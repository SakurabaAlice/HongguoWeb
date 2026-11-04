<script setup>
// 传输方式指示器：直连 / 中转、链接有效期、直连流量，点击展开详情与切换偏好
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { store } from '../store.js';
import { media, clearDirectFailure } from '../media.js';

const props = defineProps({
  mode: { type: String, required: true }, // direct | relay | none | pending
  reason: String,
  status: Object, // Service Worker 广播的当前分集状态
});

const open = ref(false);
const root = ref(null);
const now = ref(Date.now());
let timer;
onMounted(() => {
  timer = setInterval(() => { now.value = Date.now(); }, 1000);
  document.addEventListener('pointerdown', onOutside);
});
onBeforeUnmount(() => {
  clearInterval(timer);
  document.removeEventListener('pointerdown', onOutside);
});
function onOutside(event) {
  if (open.value && root.value && !root.value.contains(event.target)) open.value = false;
}

const remaining = computed(() => (props.status?.expires ? props.status.expires - now.value / 1000 : null));

const view = computed(() => {
  const s = props.status;
  if (props.mode === 'pending') return { level: 'pending', label: '检测中' };
  if (props.mode === 'none') return { level: 'bad', label: '无法播放' };
  if (props.mode === 'relay') return { level: 'relay', label: '服务器中转' };
  if (!s || s.state === 'building') return { level: 'pending', label: '直连 · 准备中' };
  if (s.state === 'refreshing') return { level: 'warn', label: '直连 · 正在刷新链接' };
  if (s.state === 'error') return { level: 'bad', label: '直连 · 出错' };
  if (remaining.value !== null && remaining.value <= 0) return { level: 'warn', label: '直连 · 链接已过期' };
  return { level: 'ok', label: '直连 CDN' };
});

function duration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}小时${String(m).padStart(2, '0')}分` : `${m}分${String(sec).padStart(2, '0')}秒`;
}
function bytes(n) {
  if (!n) return '0 B';
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function clock(ts) {
  return ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) : '-';
}

const summary = computed(() => {
  const s = props.status;
  if (props.mode !== 'direct' || !s || s.state === 'building') return '';
  const parts = [];
  if (remaining.value !== null && remaining.value > 0) {
    const r = Math.floor(remaining.value);
    parts.push(r >= 3600 ? `${Math.floor(r / 3600)}:${String(Math.floor((r % 3600) / 60)).padStart(2, '0')}` : `${Math.ceil(r / 60)}分`);
  }
  if (s.bytes) parts.push(bytes(s.bytes));
  return parts.join(' · ');
});

function retryDirect() {
  clearDirectFailure();
  open.value = false;
}
</script>

<template>
  <div ref="root" class="transport">
    <button class="badge" :class="view.level" :title="reason || '链接剩余有效期 · 本集直连流量（点击查看详情）'" @click="open = !open">
      <i class="dot" />
      <span>{{ view.label }}</span>
      <span v-if="summary" class="summary">{{ summary }}</span>
    </button>

    <div v-if="open" class="panel">
      <h4>视频传输</h4>
      <dl>
        <dt>当前方式</dt>
        <dd v-if="mode === 'direct'">直连：浏览器 ⇄ 红果 CDN，在本机解密，<b>不经过服务器</b></dd>
        <dd v-else-if="mode === 'relay'">中转：红果 CDN → 服务器解密 → 浏览器，<b>占用服务器带宽</b></dd>
        <dd v-else-if="mode === 'none'">无可用方式</dd>
        <dd v-else>检测中…</dd>

        <template v-if="reason && mode !== 'direct'">
          <dt>原因</dt><dd class="err">{{ reason }}</dd>
        </template>

        <template v-if="mode === 'direct' && status">
          <dt>CDN 节点</dt><dd class="mono">{{ status.host || '-' }}</dd>
          <dt>片源</dt><dd>{{ [status.codec?.toUpperCase(), status.resolution].filter(Boolean).join(' · ') || '-' }}</dd>
          <dt>链接获取</dt><dd>{{ clock(status.fetchedAt) }}<template v-if="status.refreshCount">（已自动刷新 {{ status.refreshCount }} 次）</template></dd>
          <dt>链接有效期</dt>
          <dd v-if="status.expires" :class="{ err: remaining <= 0 }">
            {{ clock(status.expires * 1000) }}
            <template v-if="remaining > 0">（剩余 {{ duration(remaining) }}）</template>
            <template v-else>（已过期，下次请求时自动重新取址）</template>
          </dd>
          <dd v-else>未知</dd>
          <dt>本集直连流量</dt><dd>{{ bytes(status.bytes) }}<template v-if="status.total"> / 文件 {{ bytes(status.total) }}</template></dd>
          <template v-if="status.error">
            <dt>最近状态</dt><dd :class="{ err: status.state === 'error' }">{{ status.error }}</dd>
          </template>
        </template>

        <dt>传输偏好</dt>
        <dd>
          <select v-model="store.settings.transport">
            <option value="auto">自动（优先直连，失败时中转）</option>
            <option value="direct">仅直连</option>
            <option value="relay">仅中转</option>
          </select>
        </dd>
      </dl>
      <p v-if="!media.relayEnabled" class="note">服务器已关闭中转（RELAY=0）。</p>
      <button v-if="media.failure" class="primary" @click="retryDirect">重新尝试直连</button>
    </div>
  </div>
</template>

<style scoped>
.transport { position: relative; }
.badge { display: flex; align-items: center; gap: 6px; white-space: nowrap; font-size: 13px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex: none; }
.badge.ok { color: #4cd38a; border-color: rgba(76, 211, 138, .4); }
.badge.relay { color: #6aa8ff; border-color: rgba(106, 168, 255, .4); }
.badge.warn { color: var(--gold); border-color: rgba(255, 182, 61, .45); }
.badge.bad { color: #ff6b81; border-color: rgba(255, 107, 129, .45); }
.badge.pending { color: var(--text-dim); }
.badge.pending .dot { animation: blink 1s infinite; }
@keyframes blink { 50% { opacity: .2; } }
.summary { color: var(--text-dim); }

.panel {
  position: absolute; right: 0; bottom: calc(100% + 10px); z-index: 20;
  width: 400px; padding: 14px 16px;
  background: #1d2027; border: 1px solid var(--line); border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, .5);
}
.panel h4 { margin: 0 0 10px; font-size: 14px; }
dl { display: grid; grid-template-columns: 88px 1fr; gap: 7px 10px; margin: 0; font-size: 13px; }
dt { color: var(--text-mute); }
dd { margin: 0; word-break: break-all; }
dd b { color: var(--text); }
.mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
.err { color: #ff8a9c; }
.note { font-size: 12px; color: var(--text-mute); margin: 10px 0 0; }
.panel > button { margin-top: 12px; width: 100%; }
</style>
