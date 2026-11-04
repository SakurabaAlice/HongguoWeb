<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api.js';
import { store } from '../store.js';
import { media, markDirectFailure } from '../media.js';
import { account, cloudProgress, syncProgress, refreshFavorites, isFavorite, setFavorite, openLogin } from '../account/store.js';
import { toast } from '../toast.js';
import TransportBadge from '../components/TransportBadge.vue';
import SiteFooter from '../components/SiteFooter.vue';

const GROUP_SIZE = 50;
const RATES = [0.75, 1, 1.25, 1.5, 2, 3];
const QUALITIES = [['auto', '最高画质'], ['1080p', '1080P'], ['720p', '720P']];

const route = useRoute();
const router = useRouter();
const sid = String(route.params.sid);

const series = shallowRef(null);
const loadError = ref('');
const ep = ref(0); // 当前集数，1 起；0 表示尚未确定
const group = ref(0);
const video = ref(null);
const stage = ref(null);
const episodeList = ref(null);
const buffering = ref(false);
const playError = ref('');
const retryToken = ref(0);
const introOpen = ref(false);
const isFullscreen = ref(false);
const favoriteBusy = ref(false);
let pendingSeek = 0;
let resumed = false; // 本次续播位置来自红果账号

const episodes = computed(() => series.value?.episodes || []);
const total = computed(() => episodes.value.length);
const current = computed(() => episodes.value[ep.value - 1] || null);
const next = computed(() => episodes.value[ep.value] || null);
const signedIn = computed(() => account.status === 'signed-in');
// 红果账号中这部剧的观看记录，用于标记已看过的分集
const cloudEntry = computed(() => account.history.find((r) => r.series_id === sid) || null);
const favorite = computed(() => isFavorite(sid));
const groups = computed(() => {
  const list = [];
  for (let start = 1; start <= total.value; start += GROUP_SIZE) {
    list.push({ start, end: Math.min(total.value, start + GROUP_SIZE - 1) });
  }
  return list;
});
const visibleEpisodes = computed(() => {
  const g = groups.value[group.value];
  return g ? episodes.value.slice(g.start - 1, g.end) : [];
});
// 传输方式：direct 直连 CDN / relay 服务器中转 / none 无可用方式 / pending 检测中
const transport = computed(() => {
  if (!media.checked) return { mode: 'pending' };
  const pref = store.settings.transport;
  const relay = (reason) => (media.relayEnabled ? { mode: 'relay', reason } : { mode: 'none', reason: `${reason}；服务器已关闭中转` });
  if (pref === 'relay') return relay('已设置为仅中转');
  if (!media.directReady) return pref === 'direct' ? { mode: 'none', reason: media.unavailableReason } : relay(media.unavailableReason);
  if (pref === 'auto' && media.failure && media.relayEnabled) return relay(`直连失败：${media.failure.reason}`);
  return { mode: 'direct' };
});
const mediaStatus = computed(() => current.value && media.statuses[`${current.value.vid}:${store.settings.quality}`]);
const src = computed(() => {
  if (!current.value) return null;
  const options = { quality: store.settings.quality, nextVid: next.value?.vid, retry: retryToken.value || undefined };
  if (transport.value.mode === 'direct') return api.mediaUrl(current.value.vid, options);
  if (transport.value.mode === 'relay') return api.streamUrl(current.value.vid, options);
  return null;
});

// ---------- 加载剧集 ----------
async function loadSeries() {
  loadError.value = '';
  series.value = null;
  try {
    const [data, cloud] = await Promise.all([
      api.series(sid),
      // 续播断点只来自红果账号；已登录时同时读取，最多等 3 秒，不阻塞播放
      Promise.race([cloudProgress(sid).catch(() => null), new Promise((r) => setTimeout(() => r(null), 3000))]),
    ]);
    // 云端记录优先按分集 ID 匹配，匹配不到才用集号；都对不上时不套用断点
    const cloudEp = cloud ? (data.episodes.findIndex((e) => e.vid === String(cloud.vid)) + 1
      || (cloud.ep >= 1 && cloud.ep <= data.episodes.length ? cloud.ep : 0)) : 0;
    const wanted = Number(route.query.ep);
    const start = Number.isInteger(wanted) && wanted >= 1 && wanted <= data.episodes.length ? wanted : cloudEp || 1;
    if (cloudEp && start === cloudEp && cloud.position > 3) {
      pendingSeek = cloud.position;
      resumed = true;
    }
    series.value = data;
    setEpisode(start, { replace: true });
  } catch (error) {
    loadError.value = error.message;
  }
}

function setEpisode(n, { replace = false } = {}) {
  if (!series.value || n < 1 || n > total.value) return;
  persist();
  ep.value = n;
  playError.value = '';
  group.value = Math.floor((n - 1) / GROUP_SIZE);
  if (Number(route.query.ep) !== n) router[replace ? 'replace' : 'push']({ query: { ...route.query, ep: n } });
  document.title = `${series.value.series_title} 第${n}集 · 红果短剧`;
  nextTick(() => episodeList.value?.querySelector('.ep.current')?.scrollIntoView({ block: 'nearest' }));
}

// 浏览器前进/后退时同步集数
watch(() => route.query.ep, (value) => {
  if (route.name !== 'play' || !series.value) return;
  const n = Number(value);
  if (Number.isInteger(n) && n !== ep.value) setEpisode(n, { replace: true });
});

function go(delta) {
  const n = ep.value + delta;
  if (n < 1) return toast('已经是第一集了');
  if (n > total.value) return toast('已经是最后一集了');
  setEpisode(n);
}

// ---------- 播放进度 ----------
let lastSync = 0;
/** 已登录时把观看进度回写红果账号：播放中每 30 秒一次，暂停 / 切集 / 离开页面时立即回写 */
function persist(force = true) {
  const v = video.value;
  if (!signedIn.value || !series.value || !current.value || !v || !v.currentTime) return;
  if (!force && Date.now() - lastSync < 30000) return;
  lastSync = Date.now();
  syncProgress({
    seriesId: sid, ep: ep.value, vid: current.value.vid, position: v.currentTime, duration: v.duration || 0,
    episodeCount: total.value, title: series.value.series_title, cover: series.value.cover,
  });
}
function onTimeUpdate() {
  persist(false);
}
function onVisibility() {
  if (document.visibilityState === 'hidden') persist();
}
function onLoadedMetadata() {
  const v = video.value;
  v.playbackRate = store.settings.rate;
  if (pendingSeek && pendingSeek < v.duration - 5) {
    v.currentTime = pendingSeek;
    if (resumed) toast(`已从红果账号记录的观看位置 ${formatTime(pendingSeek)} 继续`);
  }
  pendingSeek = 0;
  resumed = false;
}
function onEnded() {
  persist();
  if (!store.settings.autoNext) return;
  if (next.value) setEpisode(ep.value + 1);
  else toast('全剧终，已看完最后一集');
}
function onVolumeChange() {
  store.settings.volume = video.value.volume;
  store.settings.muted = video.value.muted;
}
function onRateChange() {
  // 切换 src 会把倍速重置为默认值，此时不覆盖用户设置
  if (video.value.readyState > 0) store.settings.rate = video.value.playbackRate;
}

async function onError() {
  const v = video.value;
  if (!v?.error || !src.value) return;
  const code = v.error.code;
  playError.value = '正在检查视频源…';
  try {
    const res = await fetch(src.value, { headers: { Range: 'bytes=0-1' } });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      const message = data?.error || `视频源加载失败（HTTP ${res.status}）`;
      // 自动模式下直连失败：记录原因并切换到服务器中转，从当前位置继续
      if (transport.value.mode === 'direct' && store.settings.transport === 'auto' && media.relayEnabled) {
        pendingSeek = v.currentTime || pendingSeek;
        markDirectFailure(current.value.vid, message);
        playError.value = '';
        toast('直连失败，已自动切换为服务器中转');
        return;
      }
      playError.value = message;
      return;
    }
    res.body?.cancel();
  } catch {
    playError.value = '无法连接本地服务';
    return;
  }
  playError.value = code === 4 || code === 3
    ? '浏览器无法解码该视频。红果片源多为 HEVC (H.265) 编码，请使用最新版 Chrome / Edge 并开启硬件加速，或尝试切换清晰度。'
    : '视频加载中断，请重试';
}
function retry() {
  playError.value = '';
  pendingSeek = video.value?.currentTime || pendingSeek;
  retryToken.value += 1;
}

watch(() => store.settings.quality, () => {
  pendingSeek = video.value?.currentTime || 0;
});
// 切换传输方式会重新加载视频，保持播放位置
watch(() => transport.value.mode, () => {
  pendingSeek = video.value?.currentTime || pendingSeek;
});

// ---------- 交互 ----------
function togglePlay() {
  const v = video.value;
  if (!v) return;
  if (v.paused) v.play().catch(() => {}); else v.pause();
}
function seek(delta) {
  const v = video.value;
  if (v?.duration) v.currentTime = Math.max(0, Math.min(v.duration - 0.1, v.currentTime + delta));
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else stage.value?.requestFullscreen().catch(() => {});
}
function setRate(rate) {
  store.settings.rate = rate;
  if (video.value) video.value.playbackRate = rate;
}

function onKeydown(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
  const actions = {
    ' ': togglePlay, k: togglePlay, K: togglePlay,
    ArrowLeft: () => seek(-5), ArrowRight: () => seek(5),
    ArrowUp: () => go(-1), PageUp: () => go(-1),
    ArrowDown: () => go(1), PageDown: () => go(1),
    f: toggleFullscreen, F: toggleFullscreen,
    m: () => { if (video.value) video.value.muted = !video.value.muted; },
    M: () => { if (video.value) video.value.muted = !video.value.muted; },
  };
  const action = actions[event.key];
  if (!action) return;
  event.preventDefault();
  event.stopPropagation();
  action();
}

let wheelLock = 0;
function onWheel(event) {
  if (!store.settings.wheelSwitch || Math.abs(event.deltaY) < 30) return;
  event.preventDefault();
  if (Date.now() < wheelLock) return;
  wheelLock = Date.now() + 800;
  go(event.deltaY > 0 ? 1 : -1);
}

function onFullscreenChange() { isFullscreen.value = !!document.fullscreenElement; }

async function onFavorite() {
  if (!series.value || favoriteBusy.value) return;
  if (!signedIn.value) {
    toast('收藏保存在红果账号中，请先登录');
    openLogin();
    return;
  }
  const add = !favorite.value;
  favoriteBusy.value = true;
  try {
    const { confirmed } = await setFavorite(sid, add);
    toast(confirmed
      ? (add ? '已收藏到红果账号' : '已取消收藏')
      : '已提交，但回读收藏列表未确认变化，请稍后在「我的 › 我的收藏」刷新查看');
  } catch (error) {
    toast(`操作失败：${error.message}`);
  } finally {
    favoriteBusy.value = false;
  }
}

function formatTime(seconds) {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

onMounted(() => {
  loadSeries();
  window.addEventListener('keydown', onKeydown, true);
  window.addEventListener('beforeunload', persist);
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  if (signedIn.value && Date.now() - account.favoritesLoadedAt > 60000) refreshFavorites().catch(() => {});
  stage.value?.addEventListener('wheel', onWheel, { passive: false });
});
onBeforeUnmount(() => {
  persist();
  window.removeEventListener('keydown', onKeydown, true);
  window.removeEventListener('beforeunload', persist);
  document.removeEventListener('visibilitychange', onVisibility);
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  document.title = '红果短剧 · 网页版';
});
</script>

<template>
  <div class="play-page">
    <div class="player-col">
      <div ref="stage" class="stage" :class="{ fullscreen: isFullscreen }">
        <video
          v-if="src"
          ref="video"
          :src="src"
          autoplay
          controls
          playsinline
          :volume.prop="store.settings.volume"
          :muted.prop="store.settings.muted"
          @loadedmetadata="onLoadedMetadata"
          @timeupdate="onTimeUpdate"
          @pause="persist"
          @ended="onEnded"
          @error="onError"
          @waiting="buffering = true"
          @loadstart="buffering = true"
          @playing="buffering = false"
          @canplay="buffering = false"
          @volumechange="onVolumeChange"
          @ratechange="onRateChange"
        />
        <div v-if="series && current" class="stage-title">{{ series.series_title }} · 第 {{ ep }} 集</div>
        <div v-if="(buffering || !media.checked || (!series && !loadError)) && !playError" class="stage-mask"><div class="spinner" /></div>
        <div v-if="loadError" class="stage-mask error">
          <p>{{ loadError }}</p>
          <button class="primary" @click="loadSeries">重新加载</button>
        </div>
        <div v-else-if="transport.mode === 'none' && series" class="stage-mask error">
          <p>无法播放：{{ transport.reason }}</p>
          <button v-if="store.settings.transport !== 'auto'" class="primary" @click="store.settings.transport = 'auto'">改为自动模式</button>
        </div>
        <div v-else-if="playError" class="stage-mask error">
          <p>{{ playError }}</p>
          <button class="primary" @click="retry">重试</button>
          <button v-if="next" @click="go(1)">跳到下一集</button>
        </div>
      </div>

      <div class="toolbar">
        <button :disabled="ep <= 1" @click="go(-1)">上一集</button>
        <span class="counter">第 <b>{{ ep || '-' }}</b> / {{ total || '-' }} 集</span>
        <button :disabled="!next" @click="go(1)">下一集</button>
        <span class="sep" />
        <label>倍速
          <select :value="store.settings.rate" @change="setRate(Number($event.target.value))">
            <option v-for="r in RATES" :key="r" :value="r">{{ r }}x</option>
          </select>
        </label>
        <label>画质
          <select v-model="store.settings.quality">
            <option v-for="[value, label] in QUALITIES" :key="value" :value="value">{{ label }}</option>
          </select>
        </label>
        <label class="check"><input v-model="store.settings.autoNext" type="checkbox" /> 自动连播</label>
        <label class="check" title="鼠标在画面上滚动滚轮切换上一集 / 下一集"><input v-model="store.settings.wheelSwitch" type="checkbox" /> 滚轮切集</label>
        <span class="grow" />
        <TransportBadge :mode="transport.mode" :reason="transport.reason" :status="mediaStatus" />
        <button
          :class="{ faved: favorite }"
          :disabled="favoriteBusy || !series"
          title="收藏到红果账号"
          @click="onFavorite"
        >{{ favoriteBusy ? '同步中…' : favorite ? '★ 已收藏' : '☆ 收藏' }}</button>
        <button title="快捷键 F" @click="toggleFullscreen">全屏</button>
      </div>
    </div>

    <aside class="side">
      <template v-if="series">
        <div class="info">
          <img v-if="series.cover" class="cover" :src="series.cover" referrerpolicy="no-referrer" alt="" />
          <div class="info-main">
            <h1>{{ series.series_title }}</h1>
            <div class="stats">
              <span v-if="series.social_info?.rating" class="rating">{{ series.social_info.rating }} 分</span>
              <span v-if="series.social_info?.hot_text">{{ series.social_info.hot_text }}</span>
              <span>{{ series.episode_label || `共 ${total} 集` }}</span>
            </div>
            <div v-if="series.tags?.length" class="tags">
              <span v-for="t in series.tags.slice(0, 6)" :key="t" class="tag">{{ t }}</span>
            </div>
          </div>
        </div>
        <p v-if="series.intro" class="intro" :class="{ open: introOpen }" @click="introOpen = !introOpen">{{ series.intro }}</p>

        <div v-if="series.celebrities?.length" class="actors">
          <component
            :is="c.actor_id ? 'RouterLink' : 'div'"
            v-for="c in series.celebrities"
            :key="c.actor_id || c.name"
            :to="c.actor_id ? `/actor/${c.actor_id}` : undefined"
            class="actor"
            :title="c.role"
          >
            <img v-if="c.avatar" :src="c.avatar" referrerpolicy="no-referrer" alt="" />
            <span v-else class="avatar-ph">{{ c.name.slice(0, 1) }}</span>
            <span class="name">{{ c.name }}</span>
            <span v-if="c.role" class="role">{{ c.role }}</span>
          </component>
        </div>

        <div class="ep-head">
          <h3>选集</h3>
          <div v-if="groups.length > 1" class="groups">
            <span v-for="(g, i) in groups" :key="g.start" class="chip" :class="{ active: i === group }" @click="group = i">{{ g.start }}-{{ g.end }}</span>
          </div>
        </div>
        <div ref="episodeList" class="episodes">
          <button
            v-for="e in visibleEpisodes"
            :key="e.vid"
            class="ep"
            :class="{ current: e.vid_index === ep, watched: e.vid_index < (cloudEntry?.ep || 0) }"
            @click="setEpisode(e.vid_index)"
          >{{ e.vid_index }}</button>
        </div>
        <p class="keys">快捷键：空格 播放/暂停 · ←/→ 快退/快进 5 秒 · ↑/↓ 上一集/下一集 · F 全屏 · M 静音</p>
        <SiteFooter compact />
      </template>
    </aside>
  </div>
</template>

<style scoped>
.play-page {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 380px;
  grid-template-rows: minmax(0, 1fr);
  height: calc(100vh - var(--header-h));
}
.player-col { display: flex; flex-direction: column; min-width: 0; min-height: 0; background: #000; }
.stage { position: relative; flex: 1; min-height: 0; background: #000; }
/* 绝对定位，避免竖屏视频的固有尺寸撑开布局 */
.stage video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; outline: none; }
.stage-title {
  position: absolute; left: 0; right: 0; top: 0;
  padding: 14px 18px 30px;
  background: linear-gradient(rgba(0,0,0,.6), transparent);
  font-size: 15px; font-weight: 500;
  opacity: 0; transition: opacity .25s;
  pointer-events: none;
}
.stage:hover .stage-title { opacity: 1; }
.stage-mask {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
  pointer-events: none;
}
.stage-mask.error { background: rgba(0,0,0,.82); pointer-events: auto; padding: 0 15%; text-align: center; color: #ffb3bf; }
.stage-mask.error button { min-width: 120px; }

.toolbar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 10px 12px;
  background: var(--bg-elev);
  border-top: 1px solid var(--line);
}
.toolbar label { display: flex; align-items: center; gap: 6px; color: var(--text-dim); white-space: nowrap; }
.toolbar label.check { cursor: pointer; }
.toolbar input[type="checkbox"] { accent-color: var(--accent); }
.counter { color: var(--text-dim); white-space: nowrap; }
.counter b { color: var(--text); }
.sep { width: 1px; height: 20px; background: var(--line); }
.grow { flex: 1; }
.faved { color: var(--gold); border-color: var(--gold); }

.side { overflow-y: auto; padding: 18px; border-left: 1px solid var(--line); background: var(--bg); }
.info { display: flex; gap: 14px; }
.cover { width: 88px; aspect-ratio: 3/4; object-fit: cover; border-radius: 8px; flex: none; }
.info-main { min-width: 0; }
.info h1 { font-size: 18px; margin: 0 0 6px; line-height: 1.35; }
.stats { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 13px; color: var(--text-dim); }
.rating { color: var(--gold); font-weight: 600; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.intro {
  margin: 14px 0 0; font-size: 13px; color: var(--text-dim); cursor: pointer;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
.intro.open { -webkit-line-clamp: unset; }

.actors { display: flex; gap: 12px; overflow-x: auto; padding: 14px 0 6px; }
.actor { flex: none; width: 64px; text-align: center; font-size: 12px; }
.actor img, .avatar-ph { width: 52px; height: 52px; margin: 0 auto 4px; border-radius: 50%; object-fit: cover; }
.avatar-ph { display: grid; place-items: center; background: var(--bg-hover); font-size: 18px; }
.actor .name, .actor .role { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.actor .role { color: var(--text-mute); }
.actor:hover .name { color: var(--accent); }

.ep-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 16px 0 10px; }
.ep-head h3 { margin: 0; font-size: 15px; }
.groups { display: flex; flex-wrap: wrap; gap: 4px; }
.groups .chip { padding: 1px 8px; font-size: 12px; }
.episodes { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; }
.ep { padding: 8px 0; text-align: center; border-radius: 8px; font-variant-numeric: tabular-nums; }
.ep.watched { color: var(--text-mute); }
.ep.current { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); font-weight: 600; }
.keys { margin-top: 20px; font-size: 12px; color: var(--text-mute); }


@media (max-width: 960px) {
  .play-page { grid-template-columns: 1fr; grid-template-rows: auto; height: auto; }
  .stage { height: 70vh; flex: none; }
  .side { border-left: none; }
}
</style>
