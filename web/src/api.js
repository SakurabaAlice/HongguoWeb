// 后端 API 封装
import { BASE } from './base.js';

function buildUrl(path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  const qs = query.toString();
  return qs ? `${BASE}${path}?${qs}` : `${BASE}${path}`;
}

async function get(path, params, { signal } = {}) {
  let response;
  try {
    response = await fetch(buildUrl(path, params), { signal, headers: { Accept: 'application/json' } });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('无法连接本地服务，请确认 npm start 正在运行');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `请求失败（HTTP ${response.status}）`);
  // 上游目录接口用 success:false 表示失败，统一转成异常
  if (data && data.success === false) throw new Error(data.error || '数据加载失败');
  return data;
}

export const api = {
  catalog: (params, opts) => get('/api/catalog', params, opts),
  search: (keyword, page = 1, opts) => get('/api/search', { keyword, page }, opts),
  resolve: (input) => get('/api/resolve', { input }),
  series: (sid, opts) => get(`/api/series/${encodeURIComponent(sid)}`, undefined, opts),
  actorRanking: (params, opts) => get('/api/actors/ranking', params, opts),
  actor: (id, opts) => get(`/api/actors/${encodeURIComponent(id)}`, undefined, opts),
  actorWorks: (id, params, opts) => get(`/api/actors/${encodeURIComponent(id)}/works`, params, opts),
  // 服务器中转
  streamUrl: (vid, { quality = 'auto', nextVid, retry } = {}) =>
    buildUrl(`/api/stream/${encodeURIComponent(vid)}`, { quality, next_vid: nextVid, r: retry }),
  // 直连：由 Service Worker 拦截，浏览器直接从 CDN 拉取并解密
  mediaUrl: (vid, { quality = 'auto', nextVid, retry } = {}) =>
    buildUrl(`/media/${encodeURIComponent(vid)}`, { quality, next: nextVid, r: retry }),
};
