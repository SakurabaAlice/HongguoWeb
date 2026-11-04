<script setup>
// 红果扫码登录。二维码获取、扫码状态轮询都经加密隧道直接与红果通信。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { startQrLogin, pollQrLogin, closeLogin } from '../account/hongguo.js';
import { completeLogin } from '../account/store.js';
import { toast } from '../toast.js';

const emit = defineEmits(['close']);
const state = ref('loading'); // loading | ready | scanned | confirming | expired | error
const image = ref('');
const error = ref('');
const now = ref(Date.now());
let login = null;
let timer = null;
let ticker = null;
let closed = false;
let generation = 0;

const remaining = computed(() => (login ? Math.max(0, Math.ceil((login.expiresAt - now.value) / 1000)) : 0));
const hint = computed(() => ({
  loading: '正在通过加密隧道获取二维码…',
  ready: '打开手机「红果短剧」App，扫一扫登录',
  scanned: '已扫码，请在手机上确认登录',
  confirming: '正在验证账号…',
  expired: '二维码已过期',
  error: error.value,
}[state.value]));

async function start() {
  const token = ++generation;
  stop();
  state.value = 'loading';
  image.value = '';
  error.value = '';
  try {
    const next = await startQrLogin();
    if (closed || token !== generation) return closeLogin(next);
    login = next;
    image.value = next.image;
    state.value = 'ready';
    schedule(token);
  } catch (e) {
    if (token !== generation) return;
    state.value = 'error';
    error.value = e.message;
  }
}

function schedule(token) {
  timer = setTimeout(() => poll(token), 2000);
}

async function poll(token) {
  if (closed || token !== generation || !login) return;
  try {
    const result = await pollQrLogin(login);
    if (closed || token !== generation) return;
    if (result.status === 'expired') { state.value = 'expired'; return stop(); }
    if (result.status === 'done') {
      state.value = 'confirming';
      const profile = await completeLogin(result.cookie);
      if (closed) return;
      toast(`登录成功，欢迎 ${profile.nickname}`);
      emit('close');
      return;
    }
    if (result.status === 'scanned') state.value = 'scanned';
    schedule(token);
  } catch (e) {
    if (closed || token !== generation) return;
    state.value = 'error';
    error.value = e.message;
  }
}

function stop() {
  clearTimeout(timer);
  timer = null;
  closeLogin(login);
  login = null;
}

onMounted(() => {
  start();
  ticker = setInterval(() => { now.value = Date.now(); }, 1000);
});
onBeforeUnmount(() => {
  closed = true;
  clearInterval(ticker);
  stop();
});
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dialog">
      <button class="close ghost" title="关闭" @click="emit('close')">✕</button>
      <h3>登录红果账号</h3>
      <div class="qr" :class="{ dim: state === 'expired' || state === 'scanned' || state === 'confirming' }">
        <img v-if="image" :src="image" alt="登录二维码" />
        <div v-else-if="state === 'loading'" class="spinner" />
        <div v-if="state === 'expired' || state === 'error'" class="overlay">
          <button class="primary" @click="start">刷新二维码</button>
        </div>
        <div v-else-if="state === 'scanned' || state === 'confirming'" class="overlay ok">✓</div>
      </div>
      <p class="hint" :class="{ err: state === 'error' }">{{ hint }}</p>
      <p v-if="state === 'ready'" class="sub">{{ remaining }} 秒后过期</p>
      <ul class="notes">
        <li>登录请求经端到端加密隧道直接发往红果，本站服务器看不到你的登录凭据。</li>
        <li>登录状态只保存在当前浏览器中，退出后即清除。</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.mask { position: fixed; inset: 0; z-index: 200; display: grid; place-items: center; background: rgba(0, 0, 0, .6); backdrop-filter: blur(4px); }
.dialog { position: relative; width: 360px; padding: 26px 28px 20px; border-radius: 16px; background: #1b1d24; border: 1px solid var(--line); text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,.5); }
.dialog h3 { margin: 0 0 18px; font-size: 18px; }
.close { position: absolute; right: 10px; top: 10px; padding: 4px 9px; }
.qr { position: relative; width: 220px; height: 220px; margin: 0 auto; border-radius: 12px; background: #fff; display: grid; place-items: center; overflow: hidden; }
.qr img { width: 100%; height: 100%; image-rendering: pixelated; }
.qr.dim img { opacity: .15; }
.overlay { position: absolute; inset: 0; display: grid; place-items: center; }
.overlay.ok { font-size: 64px; color: #2fbf71; }
.hint { margin: 16px 0 2px; font-size: 15px; }
.hint.err { color: #ff8a9c; font-size: 13px; }
.sub { margin: 0; font-size: 12px; color: var(--text-mute); }
.notes { margin: 18px 0 0; padding: 12px 0 0 18px; border-top: 1px solid var(--line); text-align: left; font-size: 12px; color: var(--text-mute); }
.notes li + li { margin-top: 4px; }
</style>
