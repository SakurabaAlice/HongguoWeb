// SPDX-License-Identifier: GPL-3.0-only
// 红果短剧网页版 —— 本地 Web 服务
// 负责：API 代理（目录 / 搜索 / 详情 / 演员）、CENC 视频流实时解密、托管前端静态页面。
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { isIP } = require('node:net');
const dramaService = require('./services/dramaService');
const streamService = require('./services/streamService');
const hongguo = require('./native/hongguo');
const appSource = require('./native/app-source');
const account = require('./account');
const logger = require('./services/logger');

const PORT = Number(process.env.PORT) || 8899;
const HOST = process.env.HOST || '127.0.0.1';
// RELAY=0 时关闭服务器中转，视频只能由浏览器直连 CDN（节省远端带宽）
const RELAY_ENABLED = !['0', 'false', 'off'].includes(String(process.env.RELAY || '').toLowerCase());
const QUALITIES = new Set(['auto', '1080p', '720p']);
const ID_PATTERN = /^\d{1,30}$/;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback'); // 部署在 Caddy 等反向代理之后时取真实客户端 IP

// 仅监听本机时校验 Host，防止 DNS rebinding 让其他网站借道访问本服务。
// 部署在反向代理之后时，把对外域名加入 ALLOWED_HOSTS（逗号分隔）。
const loopbackOnly = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
const allowedHosts = new Set(['127.0.0.1', 'localhost', '::1',
  ...String(process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)]);
function isAllowedHost(hostHeader) {
  if (!loopbackOnly) return true;
  const host = String(hostHeader || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return allowedHosts.has(host);
}
app.use((req, res, next) => {
  if (!isAllowedHost(req.headers.host)) {
    return res.status(403).json({ error: '仅允许通过 localhost 访问' });
  }
  if (['cross-site'].includes(req.headers['sec-fetch-site']) && req.path.startsWith('/api/')) {
    return res.status(403).json({ error: '禁止跨站访问' });
  }
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  next();
});

app.use('/api', (req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    // 视频分片请求非常频繁，降为 debug 级别
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn'
      : req.path.startsWith('/stream/') ? 'debug' : 'info';
    logger[level]('API', `${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - t0}ms)`);
  });
  res.set('Cache-Control', 'no-store');
  next();
});

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function requireId(value, label) {
  const id = String(value || '').trim();
  if (!ID_PATTERN.test(id)) throw badRequest(`${label}无效`);
  return id;
}

// ================= API 路由 =================

app.get('/api/catalog', async (req, res) => {
  const { page, category, genre } = req.query;
  res.json(await dramaService.catalog({ page, category, genre }));
});

app.get('/api/search', async (req, res) => {
  const { keyword, page } = req.query;
  res.json(await dramaService.search(keyword, page || 1));
});

// 分享链接 / 剧集 ID 解析
app.get('/api/resolve', async (req, res) => {
  const input = String(req.query.input || '');
  if (!input.trim()) throw badRequest('请输入分享链接或剧集 ID');
  try {
    res.json({ series_id: await hongguo.resolveSeriesId(input) });
  } catch (error) {
    throw badRequest(error.message);
  }
});

app.get('/api/series/:seriesId', async (req, res) => {
  const seriesId = requireId(req.params.seriesId, '剧集编号');
  res.json(await dramaService.getSeriesDetail(seriesId));
});

app.get('/api/config', (req, res) => {
  res.json({ relay: RELAY_ENABLED });
});

/** 播放地址里的 /{签名}/{十六进制过期时间}/ 段，解析为秒级时间戳 */
function urlExpiry(url) {
  const match = /^\/[0-9a-f]{32}\/([0-9a-f]{8})\//i.exec(new URL(url).pathname);
  const seconds = match ? parseInt(match[1], 16) : 0;
  return seconds > 1.5e9 ? seconds : null;
}

// 直连模式：只返回 CDN 地址与解密密钥，视频字节由浏览器直接从 CDN 拉取
app.get('/api/playinfo/:vid', async (req, res) => {
  const vid = requireId(req.params.vid, '分集编号');
  const quality = String(req.query.quality || 'auto');
  if (!QUALITIES.has(quality)) throw badRequest('清晰度无效');
  let info;
  try {
    info = await appSource.fetchAppPlayUrl(vid, { quality, allowLowerQuality: true });
  } catch (error) {
    throw Object.assign(error, { status: 502 });
  }
  res.json({
    vid,
    quality,
    fetched_at: Date.now(),
    variants: info.variants.map((v) => ({
      url: v.url,
      key: v.contentKey || null,
      codec: v.codec || '',
      resolution: v.quality || '',
      expires: urlExpiry(v.url),
    })),
  });
});

// 核心：边下边解密边播放的 MP4 流，支持 Range / Seek
app.get('/api/stream/:vid', (req, res) => {
  if (!RELAY_ENABLED) {
    return res.status(403).json({ error: '服务器已关闭中转模式，请使用 HTTPS 访问以启用直连', code: 'RELAY_DISABLED' });
  }
  const vid = requireId(req.params.vid, '分集编号');
  const quality = String(req.query.quality || 'auto');
  if (!QUALITIES.has(quality)) throw badRequest('清晰度无效');
  if (req.query.next_vid !== undefined && !ID_PATTERN.test(String(req.query.next_vid))) delete req.query.next_vid;
  return streamService.handleStream(req, res, vid);
});

app.get('/api/actors/ranking', async (req, res) => {
  const { page, limit, gender } = req.query;
  res.json(await dramaService.getActorRankings({ page, limit, gender }));
});

app.get('/api/actors/:actorId', async (req, res) => {
  res.json(await dramaService.getActorDetail(requireId(req.params.actorId, '演员编号')));
});

app.get('/api/actors/:actorId/works', async (req, res) => {
  const { count, offset } = req.query;
  res.json(await dramaService.getActorWorks(requireId(req.params.actorId, '演员编号'), { count, offset }));
});

app.use('/api', account.router);

app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

// /media/* 本应由浏览器里的 Service Worker 拦截处理；请求到达服务器说明 Service Worker 未接管页面
app.get('/media/:vid', (req, res) => {
  res.set('Cache-Control', 'no-store')
    .status(409).json({ error: 'Service Worker 未接管页面，无法直连', code: 'SW_INACTIVE' });
});

// ================= 前端静态资源 =================

const distDir = path.join(__dirname, '../web/dist');
if (fs.existsSync(path.join(distDir, 'index.html'))) {
  app.use(express.static(distDir, {
    index: false,
    setHeaders(res, file) {
      // 只有带哈希的构建产物可以长期缓存；sw.js 等固定文件名必须每次校验
      const hashed = file.includes(`${path.sep}assets${path.sep}`);
      res.set('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(distDir, 'index.html'));
  });
} else {
  app.use((req, res) => res.status(503).type('text/plain; charset=utf-8')
    .send('前端尚未构建：请先运行 npm run build，或使用 npm run dev 进入开发模式。'));
}

// ================= 错误处理 =================

const FRIENDLY = {
  DEVICE_REGISTRATION_FAILED: '播放设备注册暂时失败，请稍后重试',
  ETIMEDOUT: '上游请求超时，请稍后重试',
  SECURITY_BLOCKED: '视频源地址未通过安全检查',
};

// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  const status = error.status >= 400 && error.status < 600 ? error.status : 500;
  if (status >= 500) logger.error('API', `${req.method} ${req.originalUrl}: ${error.code || ''} ${error.message}`);
  if (res.headersSent) return res.destroy(error);
  res.status(status).json({
    error: status < 500 ? error.message : FRIENDLY[error.code] || error.message || '操作失败，请稍后重试',
    code: error.code,
  });
});

const server = app.listen(PORT, HOST, () => {
  const shown = isIP(HOST) === 6 ? `[${HOST}]` : HOST;
  const url = `http://${HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : shown}:${PORT}`;
  logger.info('Server', `红果短剧网页版已启动: ${url}`);
  if (!loopbackOnly) logger.warn('Server', `正在监听 ${HOST}，局域网内其他设备也可访问`);
  if (process.argv.includes('--open')) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"`
      : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    require('node:child_process').exec(cmd);
  }
});
account.attachTunnel(server, isAllowedHost);
server.on('error', (error) => {
  logger.error('Server', error.code === 'EADDRINUSE' ? `端口 ${PORT} 已被占用，可通过 PORT 环境变量更换端口` : error.message);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    streamService.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
