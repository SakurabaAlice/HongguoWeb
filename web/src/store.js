// 本地只保存播放偏好（画质、倍速、音量等）。观看历史与收藏全部来自红果账号，见 account/store.js
import { reactive, watch } from 'vue';

const KEY = 'hongguo-web:v1';

const defaults = () => ({
  // transport: auto（优先直连，失败时中转）| direct（仅直连）| relay（仅中转）
  settings: { quality: 'auto', autoNext: true, rate: 1, volume: 1, muted: false, wheelSwitch: true, transport: 'auto' },
});

function load() {
  const base = defaults();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    return { settings: { ...base.settings, ...(saved?.settings || {}) } };
  } catch {
    return base;
  }
}

export const store = reactive(load());
// 清除旧版本保存的本机历史与收藏
try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* ignore */ }

let timer;
watch(store, () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* 存储已满或被禁用 */ }
  }, 300);
}, { deep: true });

// 其他标签页修改后同步过来
window.addEventListener('storage', (event) => {
  if (event.key === KEY) store.settings = load().settings;
});
