// 视频传输方式：直连（Service Worker 直接从 CDN 拉取并在浏览器内解密）或服务器中转
import { reactive } from 'vue';
import { BASE } from './base.js';

export const media = reactive({
  checked: false, // 检测完成前不设置 <video> 的 src，避免先走中转再切换
  directReady: false, // Service Worker 已接管页面，可以直连
  unavailableReason: '', // 无法直连的原因
  relayEnabled: true, // 服务器是否允许中转
  failure: null, // 本次会话中直连失败的记录 { reason, vid, at }，自动模式下改走中转
  statuses: {}, // `${vid}:${quality}` -> Service Worker 广播的状态
});

const timeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitForController() {
  if (navigator.serviceWorker.controller) return Promise.resolve();
  return new Promise((resolve) => {
    navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
  });
}

export async function initMedia() {
  const config = fetch(`${BASE}/api/config`).then((r) => r.json()).then((c) => { media.relayEnabled = c.relay !== false; }).catch(() => {});

  if (!window.isSecureContext) {
    media.unavailableReason = '页面不是通过 HTTPS 访问，浏览器不允许启用 Service Worker';
  } else if (!('serviceWorker' in navigator)) {
    media.unavailableReason = '当前浏览器不支持 Service Worker';
  } else if (!window.crypto?.subtle) {
    media.unavailableReason = '当前浏览器不支持 WebCrypto';
  } else {
    const channel = new BroadcastChannel('hongguo-media');
    channel.onmessage = (event) => {
      const s = event.data;
      if (s?.type === 'status') media.statuses[`${s.vid}:${s.quality}`] = s;
    };
    try {
      await navigator.serviceWorker.register(`${BASE}/sw.js`, { scope: `${BASE}/` });
      await Promise.race([waitForController(), timeout(4000)]);
    } catch (error) {
      media.unavailableReason = `Service Worker 注册失败：${error.message}`;
    }
    const sync = () => {
      media.directReady = Boolean(navigator.serviceWorker.controller);
      if (media.directReady) media.unavailableReason = '';
      else media.unavailableReason ||= 'Service Worker 尚未接管页面（强制刷新会跳过它，请普通刷新一次）';
    };
    sync();
    navigator.serviceWorker.addEventListener('controllerchange', sync);
    channel.postMessage({ type: 'query' }); // 页面刷新后取回已有的状态
  }

  await config;
  media.checked = true;
}

export function markDirectFailure(vid, reason) {
  media.failure = { vid: String(vid), reason, at: Date.now() };
}

export function clearDirectFailure() {
  media.failure = null;
}
