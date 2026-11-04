// SPDX-License-Identifier: AGPL-3.0-only
// 直连播放 Service Worker
//
// 拦截页面里 <video src="/media/:vid"> 发出的 Range 请求：
//   1. 向服务器取一次播放地址与密钥（/api/playinfo，几 KB）
//   2. 直接向红果 CDN 拉取对应字节（不带 Referer，否则 CDN 返回 403）
//   3. 用 WebCrypto 解密 CENC (AES-CTR) 样本，并把 moov 中的 encv 改写回 hvc1/avc1
//   4. 以 206 响应交给 <video>
// 这样视频流量不经过服务器。MP4 解析与改写逻辑移植自 server/native/hongguo.js 与
// server/services/rangeMedia.js（源自 zfdang/hongguo-open-player，GPL-3.0）。

const VERSION = 'media-sw-1';
const CHANNEL = 'hongguo-media';
const FIRST_CHUNK = 256 * 1024; // 每个响应的第一块小一些，起播更快
const CHUNK = 1024 * 1024;
const MAX_RESPONSE = 4 * 1024 * 1024; // 单个响应的上限，让浏览器分段续传，避免一个请求长时间挂起
const HEAD_BYTES = 256 * 1024; // 首次读取文件头的长度，通常可覆盖 ftyp + moov
const REFRESH_MARGIN = 120; // 链接过期前多少秒主动刷新
const MAX_PLANS = 8;
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta']);

// 站点挂载路径（如 /hongguo），由注册时的 scope 决定
const BASE = new URL(self.registration.scope).pathname.replace(/\/$/, '');
const channel = new BroadcastChannel(CHANNEL);
const plans = new Map(); // `${vid}:${quality}` -> { promise, plan, retryToken }

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(`${BASE}/media/`)) return;
  event.respondWith(handleMedia(event.request, url));
});

channel.onmessage = (event) => {
  if (event.data?.type !== 'query') return;
  for (const entry of plans.values()) if (entry.plan) broadcast(entry.plan, true);
};

// ================= 字节工具 =================

const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u64 = (b, o) => u32(b, o) * 2 ** 32 + u32(b, o + 4);
function w32(b, o, v) { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; }
function w64(b, o, v) { w32(b, o, Math.floor(v / 2 ** 32)); w32(b, o + 4, v >>> 0); }
const str4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function fail(message, code, extra) { return Object.assign(new Error(message), { code }, extra); }

// ================= MP4 解析与改写 =================

function parseBoxes(data, start, end, depth = 0) {
  if (depth > 32) throw fail('MP4 结构嵌套过深', 'MP4_INVALID');
  const boxes = [];
  let off = start;
  while (off + 8 <= end) {
    let size = u32(data, off);
    const typ = str4(data, off + 4);
    let hdr = 8;
    if (size === 1) {
      if (off + 16 > end) throw fail('MP4 box 头不完整', 'MP4_INVALID');
      size = u64(data, off + 8);
      hdr = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (!Number.isSafeInteger(size) || size < hdr || off + size > end) throw fail('MP4 box 大小无效', 'MP4_INVALID');
    const children = CONTAINERS.has(typ) ? parseBoxes(data, off + hdr, off + size, depth + 1) : null;
    boxes.push({ typ, off, size, hdr, children });
    off += size;
  }
  if (off !== end) throw fail('MP4 box 被截断', 'MP4_INVALID');
  return boxes;
}

function* walk(boxes) {
  for (const box of boxes || []) {
    yield box;
    if (box.children) yield* walk(box.children);
  }
}
const childOf = (box, typ) => (box.children || []).find((b) => b.typ === typ);

/** 读取每条轨道的样本偏移、大小与 CENC IV（偏移为原文件中的绝对位置） */
function trackInfo(data, top) {
  if (top.some((b) => b.typ === 'moof')) throw fail('不支持分片 MP4', 'MP4_UNSUPPORTED');
  const tracks = [];
  let budget = 0;
  for (const stbl of [...walk(top)].filter((b) => b.typ === 'stbl')) {
    const stsz = childOf(stbl, 'stsz');
    const stco = childOf(stbl, 'stco') || childOf(stbl, 'co64');
    const stsc = childOf(stbl, 'stsc');
    const senc = childOf(stbl, 'senc');
    const stsd = childOf(stbl, 'stsd');
    let encrypted = false;
    if (stsd) {
      let cursor = stsd.off + 16;
      const count = u32(data, stsd.off + 12);
      for (let i = 0; i < count; i++) {
        const size = u32(data, cursor);
        if (size < 8 || cursor + size > stsd.off + stsd.size) throw fail('MP4 样本描述无效', 'MP4_INVALID');
        const type = str4(data, cursor + 4);
        encrypted ||= type === 'encv' || type === 'enca';
        cursor += size;
      }
    }
    if (encrypted && (!stsz || !stco || !stsc || !senc)) throw fail('不支持的加密轨道布局', 'MP4_UNSUPPORTED');
    if (!stsz || !stco || !stsc) continue;

    const fixed = u32(data, stsz.off + 12);
    const n = u32(data, stsz.off + 16);
    budget += n;
    if (budget > 100000 || (fixed === 0 && 20 + n * 4 > stsz.size)) throw fail('MP4 样本表无效', 'MP4_INVALID');
    const sizes = new Uint32Array(n);
    for (let i = 0; i < n; i++) sizes[i] = fixed || u32(data, stsz.off + 20 + i * 4);

    const nc = u32(data, stco.off + 12);
    const stride = stco.typ === 'co64' ? 8 : 4;
    if (16 + nc * stride > stco.size) throw fail('MP4 块偏移表无效', 'MP4_INVALID');
    const chunkOffs = [];
    for (let i = 0; i < nc; i++) {
      const p = stco.off + 16 + i * stride;
      chunkOffs.push(stride === 8 ? u64(data, p) : u32(data, p));
    }

    const ns = u32(data, stsc.off + 12);
    if (16 + ns * 12 > stsc.size) throw fail('MP4 样本-块映射无效', 'MP4_INVALID');
    const stscTab = [];
    for (let i = 0; i < ns; i++) {
      const p = stsc.off + 16 + i * 12;
      stscTab.push([u32(data, p), u32(data, p + 4)]);
    }
    if (n > 0 && (!stscTab.length || stscTab[0][0] !== 1)) throw fail('MP4 首块无效', 'MP4_INVALID');

    const ivs = [];
    if (senc) {
      const sc = u32(data, senc.off + 12);
      if (u32(data, senc.off + 8) !== 0 || sc !== n || senc.size !== 16 + sc * 8) {
        throw fail('不支持的 CENC 加密布局（需要整样本加密与 8 字节 IV）', 'MP4_UNSUPPORTED');
      }
      for (let i = 0; i < sc; i++) ivs.push(data.slice(senc.off + 16 + i * 8, senc.off + 24 + i * 8));
    } else if (stbl.children.some((b) => b.typ === 'saio' || b.typ === 'saiz')) {
      throw fail('不支持外置 CENC 辅助数据', 'MP4_UNSUPPORTED');
    }

    const offs = new Array(n);
    let si = 0;
    for (let i = 0; i < stscTab.length; i++) {
      const [first, perChunk] = stscTab[i];
      const nextFirst = i + 1 < stscTab.length ? stscTab[i + 1][0] : nc + 1;
      if (first < 1 || first > nc || perChunk < 1 || nextFirst <= first) throw fail('MP4 块映射无效', 'MP4_INVALID');
      for (let ci = first - 1; ci < nextFirst - 1; ci++) {
        let off = chunkOffs[ci];
        for (let s = 0; s < perChunk && si < n; s++) { offs[si] = off; off += sizes[si]; si++; }
      }
    }
    if (si !== n) throw fail('MP4 样本数与块映射不一致', 'MP4_INVALID');
    tracks.push({ sizes, offs, ivs });
  }
  return tracks;
}

/**
 * 重建 moov：去掉 senc/saio/saiz/sgpd/sbgp，把 encv/enca 还原为原始编码，
 * 并通过 relocate 修正 stco/co64 中的块偏移。会就地修改 data 中的 stco。
 */
function rebuildMoov(data, top, relocate) {
  const moov = top.find((b) => b.typ === 'moov');
  if (!moov) throw fail('缺少 moov', 'MP4_INVALID');
  const clone = (b) => ({ ...b, children: b.children ? b.children.map(clone) : null });
  const prune = (b) => {
    if (b.children) b.children = b.children.filter((c) => !['senc', 'saio', 'saiz', 'sgpd', 'sbgp'].includes(c.typ)).map(prune);
    return b;
  };
  const tree = prune(clone(moov));

  const originalFormat = (children) => {
    const sinf = children.find((c) => c.typ === 'sinf');
    const frma = sinf && parseBoxes(data, sinf.off + sinf.hdr, sinf.off + sinf.size).find((c) => c.typ === 'frma');
    return frma && frma.size === frma.hdr + 4 ? str4(data, frma.off + frma.hdr) : null;
  };

  const patches = new Map();
  for (const b of walk(tree.children)) {
    if (b.typ !== 'stsd') continue;
    const count = u32(data, b.off + 12);
    let p = b.off + 16;
    const entries = [];
    for (let i = 0; i < count; i++) {
      const esize = u32(data, p);
      const etyp = str4(data, p + 4);
      if (etyp === 'encv' || etyp === 'enca') {
        const hdrSize = etyp === 'encv' ? 78 : 28;
        const children = parseBoxes(data, p + 8 + hdrSize, p + esize);
        let type = originalFormat(children);
        if (etyp === 'enca') {
          if (u16(data, p + 16) !== 0) throw fail('不支持的音频样本描述版本', 'MP4_UNSUPPORTED');
          if (!['mp4a', 'ac-3', 'ec-3', 'Opus', 'fLaC'].includes(type)) throw fail('不支持的加密音频编码', 'MP4_UNSUPPORTED');
        } else {
          const avc = children.some((c) => c.typ === 'avcC');
          const hevc = children.some((c) => c.typ === 'hvcC');
          type ||= avc && !hevc ? 'avc1' : hevc && !avc ? 'hvc1' : null;
          if (!['avc1', 'avc3', 'hvc1', 'hev1'].includes(type) || (type.startsWith('avc') ? !avc || hevc : !hevc || avc)) {
            throw fail('无法确定加密视频的原始编码', 'MP4_UNSUPPORTED');
          }
        }
        const head = new Uint8Array(8 + hdrSize);
        head.set(ascii(type), 4);
        head.set(data.subarray(p + 8, p + 8 + hdrSize), 8);
        const entry = concat([head, ...children.filter((c) => c.typ !== 'sinf').map((c) => data.subarray(c.off, c.off + c.size))]);
        w32(entry, 0, entry.length);
        entries.push(entry);
      } else {
        entries.push(data.subarray(p, p + esize));
      }
      p += esize;
    }
    const stsdHead = data.slice(b.off, b.off + 16);
    w32(stsdHead, 12, entries.length);
    const stsd = concat([stsdHead, ...entries]);
    w32(stsd, 0, stsd.length);
    patches.set(b.off, stsd);
  }

  const serialize = (box) => {
    if (!box.children) return patches.get(box.off) || data.subarray(box.off, box.off + box.size);
    const body = concat(box.children.map(serialize));
    const head = data.slice(box.off, box.off + box.hdr);
    if (box.hdr === 8) w32(head, 0, 8 + body.length);
    else { w32(head, 0, 1); w64(head, 8, 16 + body.length); }
    return concat([head, body]);
  };

  const moovSize = serialize(tree).length;
  for (const b of walk(tree.children)) {
    if (b.typ !== 'stco' && b.typ !== 'co64') continue;
    const count = u32(data, b.off + b.hdr + 4);
    const stride = b.typ === 'co64' ? 8 : 4;
    if (b.hdr + 8 + count * stride > b.size) throw fail('MP4 块偏移表无效', 'MP4_INVALID');
    for (let i = 0; i < count; i++) {
      const p = b.off + b.hdr + 8 + i * stride;
      const updated = relocate(stride === 8 ? u64(data, p) : u32(data, p), moovSize);
      if (stride === 8) w64(data, p, updated); else w32(data, p, updated);
    }
  }
  return serialize(tree);
}

/**
 * 根据远端文件的顶层 box 列表与 moov 数据，生成输出文件的布局：
 * moov 放到第一个 mdat 之前（便于边下边播），其余 box 原样引用远端字节。
 */
function createLayout(metadata, boxes, total) {
  if (boxes.some((b) => b.typ === 'moof')) throw fail('不支持分片 MP4', 'MP4_UNSUPPORTED');
  const local = parseBoxes(metadata, 0, metadata.length);
  const moov = boxes.find((b) => b.typ === 'moov');
  const order = boxes.filter((b) => b !== moov);
  const firstMedia = order.findIndex((b) => b.typ === 'mdat');
  if (!moov || firstMedia < 0) throw fail('MP4 缺少 moov 或 mdat', 'MP4_INVALID');
  order.splice(firstMedia, 0, moov);
  const tracks = trackInfo(metadata, local); // 必须在 rebuildMoov 修改 stco 之前读取
  const relocate = (offset, moovSize) => {
    let dest = 0;
    for (const box of order) {
      if (box.typ !== 'moov' && offset >= box.off && offset < box.off + box.size) return dest + offset - box.off;
      dest += box.typ === 'moov' ? moovSize : box.size;
    }
    throw fail('MP4 偏移超出文件范围', 'MP4_INVALID');
  };
  const rebuilt = rebuildMoov(metadata, local, relocate);
  let size = 0;
  const segments = order.map((box) => {
    const seg = box.typ === 'moov'
      ? { start: size, size: rebuilt.length, buffer: rebuilt }
      : { start: size, size: box.size, remote: box.off };
    size += seg.size;
    return seg;
  });
  const samples = tracks
    .flatMap((t) => t.ivs.map((iv, i) => ({ offset: t.offs[i], size: t.sizes[i], iv })))
    .sort((a, b) => a.offset - b.offset);
  for (const s of samples) if (s.offset + s.size > total) throw fail('加密样本超出文件范围', 'MP4_INVALID');
  return { size, segments, samples };
}

// ================= CDN 访问 =================

function urlExpiry(url) {
  const match = /^\/[0-9a-f]{32}\/([0-9a-f]{8})\//i.exec(new URL(url).pathname);
  const seconds = match ? parseInt(match[1], 16) : 0;
  return seconds > 1.5e9 ? seconds : null;
}

async function fetchRange(url, start, end, signal) {
  let res;
  try {
    res = await fetch(url, {
      headers: { Range: `bytes=${start}-${end}` },
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer', // 带 Referer 会被 CDN 拒绝
      cache: 'no-store',
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw fail(`无法连接 CDN（${error.message}）`, 'NETWORK');
  }
  if ([401, 403, 404, 410].includes(res.status)) {
    throw fail(`CDN 拒绝访问（HTTP ${res.status}），链接可能已过期`, 'LINK_REJECTED', { status: res.status });
  }
  if (res.status === 200) throw fail('CDN 不支持分段请求', 'RANGE_UNSUPPORTED');
  if (res.status !== 206) throw fail(`CDN 返回 HTTP ${res.status}`, 'CDN_HTTP', { status: res.status });
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('content-range') || '');
  if (!match || Number(match[1]) !== start) throw fail('CDN 分段响应无效', 'CDN_INVALID');
  const data = new Uint8Array(await res.arrayBuffer());
  if (data.length !== Number(match[2]) - start + 1) throw fail('CDN 分段长度不符', 'CDN_INVALID');
  return { data, total: Number(match[3]) };
}

async function fetchPlayinfo(vid, quality) {
  let res;
  try {
    res = await fetch(`${BASE}/api/playinfo/${vid}?quality=${encodeURIComponent(quality)}`, { cache: 'no-store' });
  } catch {
    throw fail('无法连接服务器获取播放地址', 'SERVER_UNREACHABLE');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw fail(body?.error || `获取播放地址失败（HTTP ${res.status}）`, body?.code || 'PLAYINFO_FAILED');
  if (!Array.isArray(body?.variants) || !body.variants.length) throw fail('服务器未返回可用片源', 'PLAYINFO_EMPTY');
  return body;
}

/** 读取远端文件的顶层 box 布局与 moov 原始数据 */
async function readRemoteLayout(plan) {
  const head = await fetchRange(plan.url, 0, HEAD_BYTES - 1);
  count(plan, head.data.length);
  const total = head.total;
  if (!Number.isSafeInteger(total) || total < 8 || total > 1024 ** 3) throw fail('MP4 文件大小异常', 'MP4_INVALID');
  const read = async (start, end) => {
    if (end < head.data.length) return head.data.slice(start, end + 1);
    const { data } = await fetchRange(plan.url, start, end);
    count(plan, data.length);
    return data;
  };
  const boxes = [];
  let metadata = null;
  for (let offset = 0; offset < total;) {
    if (boxes.length >= 128) throw fail('MP4 顶层 box 过多', 'MP4_INVALID');
    const header = await read(offset, Math.min(offset + 15, total - 1));
    let size = u32(header, 0);
    const minimum = size === 1 ? 16 : 8;
    if (size === 1) {
      if (header.length < 16) throw fail('MP4 扩展头不完整', 'MP4_INVALID');
      size = u64(header, 8);
    } else if (size === 0) {
      size = total - offset;
    }
    if (!Number.isSafeInteger(size) || size < minimum || offset + size > total) throw fail('远端 MP4 box 无效', 'MP4_INVALID');
    const typ = str4(header, 4);
    boxes.push({ off: offset, size, typ });
    if (typ === 'moov') {
      if (metadata || size > 4 * 1024 * 1024) throw fail('不支持的 MP4 元数据', 'MP4_UNSUPPORTED');
      metadata = await read(offset, offset + size - 1);
    }
    offset += size;
  }
  if (!metadata) throw fail('MP4 缺少元数据', 'MP4_INVALID');
  return { metadata, boxes, total };
}

// ================= 播放计划 =================

async function buildPlan(vid, quality) {
  const status = { vid, quality, state: 'building', bytes: 0, refreshCount: 0 };
  broadcast(status, true);
  try {
    const info = await fetchPlayinfo(vid, quality);
    let lastError;
    for (const variant of info.variants) {
      const plan = {
        vid, quality,
        url: variant.url,
        keyHex: variant.key,
        codec: variant.codec,
        resolution: variant.resolution,
        expires: variant.expires || urlExpiry(variant.url),
        fetchedAt: info.fetched_at || Date.now(),
        refreshCount: 0,
        bytes: 0,
        state: 'building',
        error: '',
      };
      try {
        plan.key = variant.key
          ? await crypto.subtle.importKey('raw', hexToBytes(variant.key), 'AES-CTR', false, ['decrypt'])
          : null;
        const remote = await readRemoteLayout(plan);
        Object.assign(plan, createLayout(remote.metadata, remote.boxes, remote.total), { total: remote.total });
        if (plan.samples.length && !plan.key) throw fail('片源已加密但缺少密钥', 'KEY_MISSING');
        plan.state = 'ok';
        broadcast(plan, true);
        return plan;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || fail('没有可用片源', 'NO_SOURCE');
  } catch (error) {
    broadcast({ ...status, state: 'error', error: error.message }, true);
    throw error;
  }
}

function getPlan(vid, quality, retryToken) {
  const key = `${vid}:${quality}`;
  let entry = plans.get(key);
  if (entry && retryToken && entry.retryToken !== retryToken) entry = null;
  if (!entry) {
    entry = { retryToken };
    entry.promise = buildPlan(vid, quality).then((plan) => { entry.plan = plan; return plan; });
    entry.promise.catch(() => { if (plans.get(key) === entry) plans.delete(key); });
    plans.set(key, entry);
    while (plans.size > MAX_PLANS) plans.delete(plans.keys().next().value);
  } else {
    plans.delete(key);
    plans.set(key, entry); // LRU
  }
  return entry.promise;
}

/** 重新取址：只接受与当前文件大小和密钥都一致的片源，保证已生成的布局仍然有效 */
function refreshPlan(plan, reason) {
  if (plan.refreshing) return plan.refreshing;
  plan.state = 'refreshing';
  plan.error = reason;
  broadcast(plan, true);
  plan.refreshing = (async () => {
    const info = await fetchPlayinfo(plan.vid, plan.quality);
    for (const variant of info.variants) {
      if (variant.key !== plan.keyHex) continue;
      try {
        const probe = await fetchRange(variant.url, 0, 0);
        if (probe.total !== plan.total) continue;
        plan.url = variant.url;
        plan.expires = variant.expires || urlExpiry(variant.url);
        plan.fetchedAt = info.fetched_at || Date.now();
        plan.refreshCount += 1;
        plan.state = 'ok';
        plan.error = '';
        broadcast(plan, true);
        return;
      } catch { /* 尝试下一个候选 */ }
    }
    throw fail('刷新后的片源与当前文件不一致，请重新加载本集', 'SOURCE_CHANGED');
  })().catch((error) => {
    plan.state = 'error';
    plan.error = error.message;
    broadcast(plan, true);
    const key = `${plan.vid}:${plan.quality}`;
    if (plans.get(key)?.plan === plan) plans.delete(key); // 下次请求重新生成
    throw error;
  }).finally(() => { plan.refreshing = null; });
  return plan.refreshing;
}

async function planRange(plan, start, end, signal) {
  if (plan.refreshing) await plan.refreshing;
  if (plan.expires && Date.now() / 1000 > plan.expires - REFRESH_MARGIN) await refreshPlan(plan, '链接即将过期，自动刷新');
  try {
    const result = await fetchRange(plan.url, start, end, signal);
    count(plan, result.data.length);
    return result.data;
  } catch (error) {
    if (signal?.aborted || !['LINK_REJECTED', 'NETWORK'].includes(error.code)) throw error;
    await refreshPlan(plan, error.message);
    const result = await fetchRange(plan.url, start, end, signal);
    count(plan, result.data.length);
    return result.data;
  }
}

/** 就地解密 data（对应远端文件 [remote, remote + data.length) 区间）中的所有加密样本片段 */
async function decryptInPlace(plan, data, remote) {
  const samples = plan.samples;
  if (!samples.length) return;
  const limit = remote + data.length;
  let lo = 0, hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (samples[mid].offset + samples[mid].size <= remote) lo = mid + 1; else hi = mid;
  }
  const jobs = [];
  for (let i = lo; i < samples.length && samples[i].offset < limit; i++) {
    const s = samples[i];
    const begin = Math.max(remote, s.offset);
    const finish = Math.min(limit, s.offset + s.size);
    if (begin >= finish) continue;
    const within = begin - s.offset;
    const pad = within % 16;
    // CENC：8 字节 IV + 8 字节块计数器；从样本中间开始时先补齐到块边界
    const counter = new Uint8Array(16);
    counter.set(s.iv, 0);
    w64(counter, 8, Math.floor(within / 16));
    const cipher = data.subarray(begin - remote, finish - remote);
    const input = pad ? concat([new Uint8Array(pad), cipher]) : cipher;
    jobs.push(crypto.subtle.decrypt({ name: 'AES-CTR', counter, length: 64 }, plan.key, input)
      .then((plain) => data.set(new Uint8Array(plain, pad), begin - remote)));
  }
  await Promise.all(jobs);
}

async function* readOutput(plan, start, end, signal) {
  for (const seg of plan.segments) {
    const from = Math.max(start, seg.start);
    const to = Math.min(end, seg.start + seg.size - 1);
    if (from > to) continue;
    if (seg.buffer) {
      yield seg.buffer.subarray(from - seg.start, to - seg.start + 1);
      continue;
    }
    for (let pos = from; pos <= to;) {
      const length = Math.min(pos === start ? FIRST_CHUNK : CHUNK, to - pos + 1);
      const remote = seg.remote + pos - seg.start;
      const data = await planRange(plan, remote, remote + length - 1, signal);
      await decryptInPlace(plan, data, remote);
      yield data;
      pos += length;
    }
  }
}

// ================= 请求处理 =================

function jsonError(error, status = 502) {
  return new Response(JSON.stringify({ error: error.message || '直连播放失败', code: error.code || 'DIRECT_FAILED' }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Transport': 'direct' },
  });
}

function parseRange(header, total) {
  if (!header) return { start: 0, end: total - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  let start, end;
  if (!match[1]) {
    start = Math.max(0, total - Number(match[2]));
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= total) return null;
  return { start, end: Math.min(end, start + MAX_RESPONSE - 1), partial: true };
}

async function handleMedia(request, url) {
  const vid = /^\/media\/(\d{1,30})$/.exec(url.pathname.slice(BASE.length))?.[1];
  const quality = url.searchParams.get('quality') || 'auto';
  if (!vid || !['auto', '1080p', '720p'].includes(quality)) return jsonError(fail('参数无效', 'BAD_REQUEST'), 400);

  let plan;
  try {
    plan = await getPlan(vid, quality, url.searchParams.get('r') || '');
  } catch (error) {
    return jsonError(error);
  }
  const range = parseRange(request.headers.get('range'), plan.size);
  if (!range) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${plan.size}` } });
  }
  const headers = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Content-Length': String(range.end - range.start + 1),
    'Cache-Control': 'no-store',
    'X-Transport': 'direct',
  };
  if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${plan.size}`;
  if (request.method === 'HEAD') return new Response(null, { status: range.partial ? 206 : 200, headers });

  const controller = new AbortController();
  request.signal?.addEventListener('abort', () => controller.abort());
  const chunks = readOutput(plan, range.start, range.end, controller.signal);
  // 先取到第一块再返回响应头：若取址或 CDN 出错，页面能拿到 JSON 错误并自动切换为中转
  let first;
  try {
    first = await chunks.next();
  } catch (error) {
    plan.state = 'error';
    plan.error = error.message;
    broadcast(plan, true);
    return jsonError(error);
  }
  schedulePrefetch(url.searchParams.get('next'), quality);

  const body = new ReadableStream({
    start(c) {
      if (first.done) c.close(); else c.enqueue(first.value);
    },
    async pull(c) {
      try {
        const { value, done } = await chunks.next();
        if (done) c.close(); else c.enqueue(value);
      } catch (error) {
        if (!controller.signal.aborted) {
          plan.state = 'error';
          plan.error = error.message;
          broadcast(plan, true);
        }
        c.error(error);
      }
    },
    cancel() {
      controller.abort();
      chunks.return();
    },
  });
  return new Response(body, { status: range.partial ? 206 : 200, headers });
}

// 当前集开始播放后，预先为下一集取址并读取 moov（只有几百 KB）
const prefetchTimers = new Map();
function schedulePrefetch(vid, quality) {
  if (!vid || !/^\d{1,30}$/.test(vid) || plans.has(`${vid}:${quality}`) || prefetchTimers.has(vid)) return;
  prefetchTimers.set(vid, setTimeout(() => {
    prefetchTimers.delete(vid);
    getPlan(vid, quality, '').catch(() => {});
  }, 3000));
}

// ================= 状态广播 =================

const lastBroadcast = new Map();
function count(plan, bytes) {
  plan.bytes += bytes;
  // 之前的瞬时错误已恢复
  if (plan.state === 'error' && !plan.refreshing) {
    plan.state = 'ok';
    plan.error = '';
    return broadcast(plan, true);
  }
  broadcast(plan);
}

function broadcast(plan, force = false) {
  const key = `${plan.vid}:${plan.quality}`;
  const now = Date.now();
  if (!force && now - (lastBroadcast.get(key) || 0) < 500) return;
  lastBroadcast.set(key, now);
  let host = '';
  try { host = plan.url ? new URL(plan.url).host : ''; } catch { /* ignore */ }
  channel.postMessage({
    type: 'status',
    version: VERSION,
    vid: plan.vid,
    quality: plan.quality,
    state: plan.state,
    error: plan.error || '',
    host,
    codec: plan.codec || '',
    resolution: plan.resolution || '',
    expires: plan.expires || null,
    fetchedAt: plan.fetchedAt || null,
    refreshCount: plan.refreshCount || 0,
    bytes: plan.bytes || 0,
    total: plan.total || 0,
    updatedAt: now,
  });
}
