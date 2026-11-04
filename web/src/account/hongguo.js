// 红果账号协议（浏览器端）。所有请求都经端到端加密隧道直接发往红果，Cookie 不经过服务器。
// 扫码登录与账号接口字段参考 jackotom/hongguo-drama（account-session.js）与
// tsukiyo-zero/hongguoTV（WebLogin.kt / CloudAccount.kt），均为 GPL-3.0。
import { tunnelFetch, createSession, cookieHeaderFrom } from './tunnel.js';

const WEB = 'https://hongguoduanju.com';
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const WEB_QUERY = {
  aid: '513755', passport_jssdk_version: '3.4.10', passport_jssdk_type: 'normal',
  account_sdk_source: 'web', is_from_ttaccountsdk: '1', language: 'zh',
};

export class AuthError extends Error {}

function webUrl(path, params = {}) {
  const url = new URL(path, WEB);
  for (const [k, v] of Object.entries({ ...WEB_QUERY, ...params })) url.searchParams.set(k, v);
  return url.href;
}
const webHeaders = (cookie) => ({
  'User-Agent': WEB_UA, Referer: `${WEB}/`, Origin: WEB, Accept: 'application/json, text/javascript',
  ...(cookie ? { Cookie: cookie } : {}),
});

const cleanText = (v) => String(v || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

/** 大整数 ID（分集 vid 等超过 2^53）在 JSON.parse 前转成字符串，避免精度丢失 */
function parseJson(text) {
  const safe = String(text).replace(/("(?:vid|video_id|item_id|book_id|series_id|user_id|biz_user_id)"\s*:\s*)(\d{16,})/g, '$1"$2"');
  try { return JSON.parse(safe); } catch { throw new Error('红果返回的数据无法解析'); }
}

function passportData(res) {
  if (res.status !== 200) throw new Error(`红果登录服务返回 HTTP ${res.status}`);
  const payload = parseJson(res.text);
  if (payload.message && String(payload.message).toLowerCase() !== 'success') {
    const message = cleanText(payload.data?.description || payload.message) || '红果登录请求未完成';
    throw /会话|过期|登录|session/i.test(message) ? new AuthError(message) : new Error(message);
  }
  if (!payload.data || typeof payload.data !== 'object') throw new Error('红果登录服务返回内容为空');
  return payload.data;
}

export function cleanCover(value) {
  const text = String(value || '').trim();
  const url = text.startsWith('//') ? `https:${text}` : text;
  if (!/^https?:\/\//i.test(url)) return '';
  try {
    const parsed = new URL(url);
    if (/\.heic$/i.test(parsed.pathname)) {
      // HEIC 封面浏览器无法显示，改用公开的 JPEG 变体
      if (!/(fqnovelpic\.com|byteimg\.com)$/i.test(parsed.hostname)) return '';
      return `https://p3-novel.byteimg.com${parsed.pathname.split('~', 1)[0]}~tplv-shrink:320:0.webp`;
    }
    return url.replace(/^http:/i, 'https:');
  } catch { return ''; }
}

// ================= 扫码登录 =================

/** 获取登录二维码。返回的 login 对象保存了本次登录的 Cookie 会话 */
export async function startQrLogin() {
  const session = await createSession();
  const data = passportData(await tunnelFetch(webUrl('/passport/web/get_qrcode/', { next: `${WEB}/` }), { session, headers: webHeaders() }));
  const token = String(data.token || '').trim();
  const qrcode = String(data.qrcode || '').trim();
  if (!token || !qrcode) throw new Error('红果登录二维码格式已变化');
  const expire = Number(data.expire_time);
  const seconds = expire > 1e9 ? expire - Date.now() / 1000 : expire || 180;
  return {
    session,
    token,
    image: qrcode.startsWith('data:image/') ? qrcode : `data:image/png;base64,${qrcode.split('base64,').pop()}`,
    expiresAt: Date.now() + Math.max(30, Math.min(600, seconds)) * 1000,
  };
}

/** 轮询扫码状态：pending | scanned | expired | done（done 时附带 cookie） */
export async function pollQrLogin(login) {
  if (Date.now() >= login.expiresAt) return { status: 'expired' };
  const data = passportData(await tunnelFetch(webUrl('/passport/web/check_qrconnect/', { next: `${WEB}/`, token: login.token }), {
    session: login.session, headers: webHeaders(),
  }));
  const status = String(data.status || '');
  if (['5', 'expired'].includes(status)) return { status: 'expired' };
  if (['2', 'scanned'].includes(status)) return { status: 'scanned' };
  if (!['3', 'confirmed'].includes(status)) return { status: 'pending' };
  if (data.redirect_url) {
    const target = new URL(String(data.redirect_url), WEB);
    if (target.protocol !== 'https:' || !/(^|\.)hongguoduanju\.com$/i.test(target.hostname)) throw new Error('登录确认跳转到了不支持的站点');
    // 会话自动跟随跳转并保存 Set-Cookie
    await tunnelFetch(target.href, { session: login.session, headers: { 'User-Agent': WEB_UA, Referer: `${WEB}/` } });
  }
  const cookie = cookieHeaderFrom(login.session.export_cookies(), 'hongguoduanju.com');
  if (!/(?:^|; )sessionid(?:_ss)?=/.test(cookie)) return { status: 'scanned' };
  return { status: 'done', cookie };
}

export function closeLogin(login) {
  try { login?.session?.close(); } catch { /* ignore */ }
}

/** 用网页会话读取账号资料，同时验证登录态是否有效 */
export async function fetchProfile(cookie) {
  const data = passportData(await tunnelFetch(webUrl('/passport/account/info/v2/'), { headers: webHeaders(cookie) }));
  const id = String(data.user_id_str || data.user_id || '').trim();
  if (!/^\d{1,30}$/.test(id) || !/[1-9]/.test(id)) throw new AuthError('登录态未通过红果账号验证');
  return {
    id,
    nickname: cleanText(data.name || data.screen_name || data.username) || '红果用户',
    avatar: cleanCover(data.avatar_url || data.avatar_uri || ''),
  };
}

// ================= App 账号接口 =================

async function signRequest(path, params, identity, body) {
  const res = await fetch('/api/account/sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, params, identity, body }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || '账号请求签名失败');
  return data;
}

/** 服务器只负责签名（不含 Cookie），浏览器在隧道内附加 Cookie 后直接发给红果 */
async function appRequest(account, path, params = {}, payload = null) {
  const body = payload === null ? null : JSON.stringify(payload);
  const signed = await signRequest(path, params, account.device, body);
  const res = await tunnelFetch(signed.url, {
    method: signed.method,
    headers: { ...signed.headers, Cookie: account.cookie },
    ...(body !== null ? { body } : {}),
  });
  if (res.status === 401 || res.status === 403) throw new AuthError(`红果账号接口拒绝访问（HTTP ${res.status}）`);
  if (res.status !== 200) throw new Error(`红果账号接口返回 HTTP ${res.status}`);
  if (!res.text.trim()) throw new Error('红果账号接口返回空响应');
  const json = parseJson(res.text);
  if (Number(json.code) !== 0) {
    const message = cleanText(json.message || json.msg) || `错误码 ${json.code}`;
    throw /登录|会话|过期|login|session/i.test(message) ? new AuthError(message) : new Error(`红果账号接口：${message}`);
  }
  return json;
}

/**
 * 红果 App 中的用户资料（昵称、头像、红果号）。
 * 网页登录接口返回的是底层通行证账号（默认昵称「用户xxxx」），与 App 内展示的资料不同。
 */
export async function fetchAppProfile(account) {
  const json = await appRequest(account, '/reading/user/info/v1/');
  const d = json.data || {};
  const pickId = (...keys) => keys.map((k) => String(d[k] ?? '').trim()).find((v) => /^\d{5,20}$/.test(v)) || '';
  return {
    nickname: cleanText(d.user_name || d.nickname),
    avatar: cleanCover(d.expand_avatar_url || d.avatar_url || d.avatar),
    hongguoId: pickId('display_id', 'short_id', 'unique_id', 'hongguo_id', 'red_fruit_id', 'user_number', 'biz_user_id'),
    fields: Object.keys(d), // 便于排查字段变化
  };
}

/** 注册本浏览器专用的匿名设备身份（账号接口需要） */
export async function registerDevice() {
  const res = await fetch('/api/account/device', { method: 'POST' });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || '设备注册失败');
  return data;
}

const toMs = (v) => { const n = Number(v) || 0; return n > 0 && n < 1e10 ? n * 1000 : n; };

/** 批量获取剧集标题与封面 */
async function seriesDetails(account, ids) {
  if (!ids.length) return new Map();
  try {
    const json = await appRequest(account, '/reading/bookapi/multi-detail/v1/', { book_id: ids.join(','), book_type: '2' });
    const rows = Array.isArray(json.data) ? json.data : [];
    return new Map(rows.map((r) => [String(r.book_id), {
      series_title: cleanText(r.book_name || r.series_title),
      cover: cleanCover(r.thumb_url || r.series_cover_url || r.cover),
      episode_count: Number(r.episode_cnt || r.episode_count || r.drama_chapter_number) || 0,
    }]));
  } catch {
    return new Map(); // 资料补全失败不影响记录本身
  }
}

function normalizeProgress(rows) {
  const list = rows.map((r) => {
    if (r?.is_delete) return null;
    const sid = String(r?.series_id || r?.book_id_str || r?.book_id || '').trim();
    const vid = String(r?.vid || r?.item_id || '').trim();
    if (!/^\d{1,30}$/.test(sid) || !/^\d{1,30}$/.test(vid)) return null;
    return {
      series_id: sid,
      vid,
      ep: Math.max(1, Number(r.vid_index) || 1),
      // 云端进度单位为毫秒
      position: Math.max(0, (Number(r.current_play_time ?? r.current_play_position) || 0) / 1000),
      duration: Math.max(0, (Number(r.current_total_time ?? r.duration) || 0) / 1000),
      updated_at: toMs(r.last_watch_time || r.read_timestamp_ms),
      episode_count: Number(r.episode_count || r.episode_cnt) || 0,
      series_title: cleanText(r.series_title || r.book_name),
      cover: cleanCover(r.series_cover_url || r.thumb_url || r.cover),
    };
  }).filter(Boolean).sort((a, b) => b.updated_at - a.updated_at);
  const seen = new Set();
  return list.filter((r) => !seen.has(r.series_id) && seen.add(r.series_id)).slice(0, 50);
}

/** 账号最近 50 部观看记录（含集数与秒级进度） */
export async function fetchCloudHistory(account) {
  let rows;
  try {
    const json = await appRequest(account, '/reading/bookapi/read_progress/list/v1/', { book_types: '2', limit: '50' });
    rows = json.data?.video_data || json.video_data;
    if (!Array.isArray(rows)) throw new Error('云端历史格式已变化');
  } catch (error) {
    if (error instanceof AuthError) throw error;
    const json = await appRequest(account, '/reading/bookapi/read_history/list/v1/', {
      book_type: '2', limit: '0', offset: '0', last_min_read_timestamp_ms: '0',
      full_field: 'true', is_first_load: 'true', query_soft_deleted: 'false',
    });
    rows = json.data?.data_list;
    if (!Array.isArray(rows)) throw new Error('云端历史格式已变化');
  }
  const list = normalizeProgress(rows);
  const details = await seriesDetails(account, list.filter((r) => !r.series_title || !r.cover).map((r) => r.series_id));
  return list.map((r) => {
    const d = details.get(r.series_id) || {};
    return {
      ...r,
      series_title: r.series_title || d.series_title || `剧集 ${r.series_id}`,
      cover: r.cover || d.cover || '',
      episode_count: r.episode_count || d.episode_count || 0,
    };
  });
}

// ================= 收藏（App 中的「收藏」，接口为账号视频书架 bookshelf/video）=================

export async function fetchFavorites(account) {
  const json = await appRequest(account, '/reading/bookapi/bookshelf/video/info/v1/');
  const data = json.data;
  if (!data || !('video_shelf_info' in data)) throw new Error('账号收藏列表格式已变化');
  const rows = Array.isArray(data.video_shelf_info) ? data.video_shelf_info : [];
  return rows.map((row) => {
    const video = row.video_data || row;
    const sid = String(video.series_id || row.series_id || row.book_id || '');
    if (!/^\d{1,30}$/.test(sid)) return null;
    return {
      series_id: sid,
      series_title: cleanText(row.series_title || video.title || video.series_title || row.book_name) || `剧集 ${sid}`,
      cover: cleanCover(row.series_cover_url || video.cover || video.cover_url || video.thumb_url || row.thumb_url),
      episode_count: Number(video.episode_cnt || video.episode_count || row.episode_cnt) || 0,
      added_at: toMs(row.modify_time || row.add_time || row.create_time),
    };
  }).filter(Boolean);
}

/** 加入 / 取消收藏。只发送一次，不自动重试；调用方必须回读列表确认结果 */
export async function updateFavorite(account, seriesId, add) {
  const entry = { book_id: String(seriesId), book_type: 2, modify_time: Date.now(), video_shelf_operate_type: add ? 0 : 1 };
  if (!add) entry.group_name = '';
  const body = { is_cancelled: false, update_bookshelf_video_list: [entry] };
  if (add) {
    body.shark_extra = { enter_from: 'MainFragmentActivity', previous_page: '', page_list: 'MainFragmentActivity', is_active_behavior: 'true', inactive_type: '0' };
  }
  await appRequest(account, '/reading/bookapi/bookshelf/video/update/v1/', {}, body);
}

// ================= 进度上报 =================

/** 把网页上的观看进度写回账号（秒 -> 毫秒） */
export async function uploadProgress(account, { seriesId, vid, ep, position, duration, episodeCount }) {
  const pos = Math.max(0, Math.round(position * 1000));
  const total = Math.max(0, Math.round(duration * 1000));
  const entry = {
    book_id: String(seriesId),
    item_id: String(vid),
    vid_index: ep,
    current_play_time: pos,
    current_total_time: total,
    episode_count: episodeCount,
    read_timestamp_ms: Date.now(),
    book_type: 2,
    progress_rate: total > 0 ? String(Math.min(1, Math.max(0, pos / total))) : '0',
    player_cumulative_total_duration: pos,
  };
  await appRequest(account, '/reading/bookapi/read_progress/upload/v1/', {}, { books: [entry], write_mode: 1 });
}
