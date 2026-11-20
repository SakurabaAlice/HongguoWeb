// SPDX-License-Identifier: AGPL-3.0-only
// 浏览器 HEVC (H.265) 解码能力检测与引导文案。
// 红果片源目前只有 HEVC 能在浏览器里播放（其余档位是浏览器无法解码的 ByteVC2），
// 浏览器解不了 HEVC 时 <video> 会只放音频、画面黑屏，而且不触发 error 事件。
// 所以播放前先查能力（第 1 层），播放中再查画面尺寸（第 2 层，见 Play.vue）。
import { reactive } from 'vue';

// Service Worker 会把 MP4 的视频轨改写为 hvc1；Main Profile，Level 4.0 / 4.1 覆盖 1080p
const HEVC_TYPES = ['video/mp4; codecs="hvc1.1.6.L120.90"', 'video/mp4; codecs="hvc1.1.6.L123.90"'];

export const codecState = reactive({
  result: null, // { supported, canPlayType, mse, mediaCapabilities }，检测完成前为 null
  bypass: false, // 用户在说明层点了"仍要播放"（本次打开页面内有效）
  blackDismissed: false, // 用户在"有声无画"提示里选择继续播放（本次打开页面内有效）
});

let pending = null;
export function checkHevc() {
  pending ||= detect().then((result) => { codecState.result = result; return result; });
  return pending;
}

async function detect() {
  const video = document.createElement('video');
  const canPlayType = HEVC_TYPES.some((t) => video.canPlayType(t) !== '');
  let mse = false;
  try { mse = typeof MediaSource !== 'undefined' && HEVC_TYPES.some((t) => MediaSource.isTypeSupported(t)); } catch { /* ignore */ }
  let mediaCapabilities = null;
  try {
    if (navigator.mediaCapabilities?.decodingInfo) {
      const info = await Promise.race([
        navigator.mediaCapabilities.decodingInfo({
          type: 'file',
          video: { contentType: HEVC_TYPES[0], width: 1080, height: 1920, bitrate: 3000000, framerate: 30 },
        }),
        new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
      ]);
      mediaCapabilities = info ? Boolean(info.supported) : null;
    }
  } catch { mediaCapabilities = null; }
  // 任何一项说支持就放行：宁可漏判（由第 2 层兜底），不误拦能正常播放的浏览器
  return { supported: canPlayType || mse || mediaCapabilities === true, canPlayType, mse, mediaCapabilities };
}

// Chromium 自 100 版（2022-03-29）起约每 4 周一个大版本，节假日偶有跳过；
// 落后估计值 12 个版本以上（约一年）才提示"版本较旧"，避免误报
function estimatedChromiumMajor(now = Date.now()) {
  return 100 + Math.floor((now - Date.UTC(2022, 2, 29)) / (28 * 86400000));
}

export function browserInfo(ua = navigator.userAgent) {
  const windows = /Windows/i.test(ua);
  const mac = /Macintosh|Mac OS X/i.test(ua) && !/Mobile/i.test(ua);
  const pick = (re) => Number(ua.match(re)?.[1]) || 0;
  let name = 'other';
  let version = 0;
  if (/Edg\//.test(ua)) { name = 'edge'; version = pick(/Edg\/(\d+)/); }
  else if (/Firefox\//.test(ua)) { name = 'firefox'; version = pick(/Firefox\/(\d+)/); }
  else if (/Chrome\//.test(ua)) { name = 'chrome'; version = pick(/Chrome\/(\d+)/); }
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) { name = 'safari'; version = pick(/Version\/(\d+)/); }
  const outdated = ['edge', 'chrome'].includes(name) && version > 0 && version < estimatedChromiumMajor() - 12;
  return { name, version, windows, mac, outdated };
}

const STORE_FREE = 'https://apps.microsoft.com/detail/9N4WGH0Z6VHQ'; // 来自设备制造商的 HEVC 视频扩展（免费）
const STORE_PAID = 'https://apps.microsoft.com/detail/9NMZLZ57R3T7'; // HEVC 视频扩展（¥7）
const CHROME_DOWNLOAD = 'https://www.google.cn/chrome/';

/**
 * 按浏览器给出引导步骤。每一步 { text, links?: [{ label, href }], copy?: string }。
 * copy 用于 edge:// / chrome:// 这类网页不能直接跳转的地址，只能让用户复制到地址栏。
 */
export function hevcGuide(info = browserInfo()) {
  const steps = [];
  const restart = { text: '完成后请完全关闭浏览器，再重新打开本页。' };
  if (info.name === 'edge') {
    if (info.outdated) steps.push({ text: `Edge 版本较旧（${info.version}），请先更新到最新版：把下面的地址复制到地址栏打开。`, copy: 'edge://settings/help' });
    if (info.windows) {
      steps.push({
        text: '在微软商店安装「HEVC 视频扩展」（Windows 上的 Edge 需要它才能解码 H.265）：',
        links: [{ label: '免费版（来自设备制造商）', href: STORE_FREE }, { label: '付费版（¥7）', href: STORE_PAID }],
      });
      steps.push({ text: '如果免费版提示无法获取，请改用付费版。' });
    }
    steps.push(restart);
    steps.push({ text: '或者改用最新版 Chrome（自带 H.265 解码，不需要安装扩展）。', links: [{ label: '下载 Chrome', href: CHROME_DOWNLOAD }] });
  } else if (info.name === 'chrome') {
    if (info.outdated) steps.push({ text: `浏览器版本较旧（${info.version}），请先更新到最新版：把下面的地址复制到地址栏打开。`, copy: 'chrome://settings/help' });
    steps.push({ text: '确认已开启硬件加速：设置 › 系统 › 打开「使用图形加速功能（如果可用）」。', copy: 'chrome://settings/system' });
    if (info.windows) steps.push({ text: '更新显卡驱动；H.265 解码需要显卡支持。' });
    steps.push(restart);
    steps.push({ text: '如果用的是国产浏览器（Chrome 内核），可以换成最新版 Chrome 试试。', links: [{ label: '下载 Chrome', href: CHROME_DOWNLOAD }] });
  } else if (info.name === 'safari') {
    steps.push({ text: '请更新 macOS 与 Safari 到最新版本。' });
    steps.push({ text: '或者改用最新版 Chrome。', links: [{ label: '下载 Chrome', href: CHROME_DOWNLOAD }] });
  } else {
    steps.push({ text: '当前浏览器对 H.265 支持有限，建议改用最新版 Chrome 或 Edge。', links: [{ label: '下载 Chrome', href: CHROME_DOWNLOAD }] });
  }
  return steps;
}
