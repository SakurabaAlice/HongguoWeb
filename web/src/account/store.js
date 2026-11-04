// 红果账号状态。登录凭据（Cookie + 匿名设备身份）只保存在本浏览器的 localStorage 中，
// 每个客户端各自登录自己的红果账号，服务器不保存任何账号信息。
import { reactive } from 'vue';
import * as hg from './hongguo.js';

const KEY = 'hongguo-web:account';

export const account = reactive({
  status: 'anonymous', // anonymous | signed-in
  profile: null,
  verifying: false,
  error: '',
  history: [],
  historyLoadedAt: 0,
  historyLoading: false,
  historyError: '',
  favorites: [],
  favoritesLoadedAt: 0,
  favoritesLoading: false,
  favoritesError: '',
  lastUpload: null, // 最近一次进度回写 { at, ok, message }
  profileFields: [], // App 用户资料接口返回的字段名，便于排查
  loginOpen: false,
});

export function openLogin() {
  account.loginOpen = true;
}

let credentials = null; // { cookie, device, profile }

function persist() {
  try {
    if (credentials) localStorage.setItem(KEY, JSON.stringify(credentials));
    else localStorage.removeItem(KEY);
  } catch { /* 存储不可用 */ }
}

function apply(next) {
  credentials = next;
  account.status = next ? 'signed-in' : 'anonymous';
  account.profile = next?.profile || null;
  account.history = [];
  account.historyLoadedAt = 0;
  account.historyError = '';
  account.favorites = [];
  account.favoritesLoadedAt = 0;
  account.favoritesError = '';
  account.lastUpload = null;
}

export function signOut(reason = '') {
  apply(null);
  account.error = reason;
  persist();
}

/** 遇到登录失效时统一退出 */
function guard(error) {
  if (error instanceof hg.AuthError) signOut(`红果登录已失效：${error.message}`);
  throw error;
}

/**
 * 用 App 用户资料（昵称、头像、红果号）覆盖网页通行证资料。
 * 通行证资料只用于验证登录态；读取失败时保留已有资料。
 */
async function refreshAppProfile() {
  const owner = credentials;
  if (!owner) return;
  try {
    const app = await hg.fetchAppProfile(owner);
    if (credentials !== owner) return;
    account.profileFields = app.fields;
    const profile = { ...owner.profile, ...(app.nickname ? { nickname: app.nickname } : {}),
      ...(app.avatar ? { avatar: app.avatar } : {}), hongguoId: app.hongguoId || owner.profile.hongguoId || '' };
    owner.profile = profile;
    account.profile = profile;
    persist();
  } catch (error) {
    if (error instanceof hg.AuthError) signOut(`红果登录已失效：${error.message}`);
  }
}

/** 扫码完成后：注册设备、验证登录态，再读取 App 资料并保存 */
export async function completeLogin(cookie) {
  const [device, passport] = await Promise.all([hg.registerDevice(), hg.fetchProfile(cookie)]);
  apply({ cookie, device, profile: passport });
  account.error = '';
  await refreshAppProfile();
  persist();
  refreshHistory().catch(() => {});
  return account.profile;
}

/** 页面启动时恢复登录态，并在后台复核会话是否仍有效 */
export function restoreAccount() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* ignore */ }
  if (!saved?.cookie || !saved?.device || !saved?.profile) return;
  apply({ cookie: saved.cookie, device: saved.device, profile: saved.profile });
  account.verifying = true;
  hg.fetchProfile(saved.cookie).then(() => {
    if (credentials?.cookie !== saved.cookie) return;
    return Promise.all([refreshAppProfile(), refreshHistory()]);
  }).catch((error) => {
    if (error instanceof hg.AuthError && credentials?.cookie === saved.cookie) signOut(`红果登录已失效，请重新扫码：${error.message}`);
  }).finally(() => { account.verifying = false; });
}

// ================= 云端观看记录 =================

let historyTask = null;
export function refreshHistory() {
  if (!credentials) return Promise.resolve([]);
  if (historyTask) return historyTask;
  const owner = credentials;
  account.historyLoading = true;
  historyTask = hg.fetchCloudHistory(owner).then((list) => {
    if (credentials !== owner) return [];
    account.history = list;
    account.historyLoadedAt = Date.now();
    account.historyError = '';
    return list;
  }).catch((error) => {
    if (credentials === owner) account.historyError = error.message;
    return guard(error);
  }).finally(() => {
    account.historyLoading = false;
    historyTask = null;
  });
  return historyTask;
}

/** 返回某部剧的云端进度；数据超过 maxAge 毫秒时先刷新 */
export async function cloudProgress(seriesId, maxAge = 60000) {
  if (!credentials) return null;
  if (Date.now() - account.historyLoadedAt > maxAge) await refreshHistory().catch(() => {});
  return account.history.find((r) => r.series_id === String(seriesId)) || null;
}

// ================= 进度回写 =================

/** 登录后始终把网页上的观看进度写回红果账号 */
let lastUploadKey = '';
export async function syncProgress(info) {
  if (!credentials) return;
  // 同一集同一位置不重复上报
  const key = `${info.vid}:${Math.floor(info.position / 5)}`;
  if (key === lastUploadKey) return;
  lastUploadKey = key;
  const owner = credentials;
  try {
    await hg.uploadProgress(owner, info);
    if (credentials !== owner) return;
    account.lastUpload = { at: Date.now(), ok: true, message: `第 ${info.ep} 集 ${Math.floor(info.position)} 秒` };
    // 同步本地缓存的云端记录，避免下一次打开时被旧进度覆盖
    const row = account.history.find((r) => r.series_id === String(info.seriesId));
    const updated = { ...(row || {}), series_id: String(info.seriesId), vid: String(info.vid), ep: info.ep,
      position: info.position, duration: info.duration, updated_at: Date.now(), episode_count: info.episodeCount,
      series_title: info.title || row?.series_title || '', cover: info.cover || row?.cover || '' };
    account.history = [updated, ...account.history.filter((r) => r.series_id !== updated.series_id)];
  } catch (error) {
    lastUploadKey = '';
    if (credentials === owner) account.lastUpload = { at: Date.now(), ok: false, message: error.message };
    if (error instanceof hg.AuthError) signOut(`红果登录已失效：${error.message}`);
  }
}

// ================= 收藏 =================

let favoritesTask = null;
export function refreshFavorites() {
  if (!credentials) return Promise.resolve([]);
  if (favoritesTask) return favoritesTask;
  const owner = credentials;
  account.favoritesLoading = true;
  favoritesTask = hg.fetchFavorites(owner).then((list) => {
    if (credentials !== owner) return [];
    account.favorites = list;
    account.favoritesLoadedAt = Date.now();
    account.favoritesError = '';
    return list;
  }).catch((error) => {
    if (credentials === owner) account.favoritesError = error.message;
    return guard(error);
  }).finally(() => {
    account.favoritesLoading = false;
    favoritesTask = null;
  });
  return favoritesTask;
}

export const isFavorite = (seriesId) => account.favorites.some((r) => r.series_id === String(seriesId));

/**
 * 加入 / 取消收藏：先读最新列表，确有需要才写一次，再回读确认。
 * 不把接口返回成功当作结果，以回读列表为准；不自动重试写请求。
 */
export async function setFavorite(seriesId, add) {
  if (!credentials) throw new Error('请先登录红果账号');
  const owner = credentials;
  const before = await refreshFavorites();
  if (before.some((r) => r.series_id === String(seriesId)) === add) return { confirmed: true, changed: false };
  try {
    await hg.updateFavorite(owner, seriesId, add);
  } catch (error) {
    return guard(error);
  }
  const after = await refreshFavorites();
  return { confirmed: after.some((r) => r.series_id === String(seriesId)) === add, changed: true };
}
