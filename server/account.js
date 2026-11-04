// SPDX-License-Identifier: AGPL-3.0-only
// 红果账号相关的服务端部分。服务器不保存、也接触不到任何账号凭据：
//  - /wisp/          端到端加密隧道：浏览器内的 libcurl.js 完成 TLS，这里只转发加密后的 TCP 字节，
//                    且只允许连接红果域名的 443 端口
//  - /api/account/sign    为账号接口生成签名（签名只覆盖 URL 与请求体，不含 Cookie）
//  - /api/account/device  为每个浏览器注册一个独立的匿名设备身份
const express = require('express');
const { server: wisp, logging: wispLogging } = require('@mercuryworkshop/wisp-js/server');
const { signedAccountRequest, requestJson } = require('./native/app-source');
const { createPlaybackDeviceRegistrar } = require('./native/playback-device');

const TUNNEL_HOSTS = [
  /^hongguoduanju\.com$/i,
  /^(?:[a-z0-9-]+\.)*fqnovel\.com$/i,
  /^(?:[a-z0-9-]+\.)*snssdk\.com$/i,
];

Object.assign(wisp.options, {
  hostname_whitelist: TUNNEL_HOSTS,
  port_whitelist: [443],
  allow_direct_ip: false,
  // 本机若使用 Fake-IP 代理，红果域名会解析到 198.18.0.0/15 等保留地址；目标已由域名白名单限定
  allow_private_ips: true,
  allow_loopback_ips: false,
  allow_udp_streams: false,
  stream_limit_per_host: 32,
  parse_real_ip_from: ['127.0.0.1', '::1', '::ffff:127.0.0.1'],
});
wispLogging.set_level(process.env.LOG_LEVEL === 'debug' ? wispLogging.INFO : wispLogging.WARN);

/** 挂载 WebSocket 隧道；isAllowedHost 与 HTTP 层的 Host 校验保持一致 */
function attachTunnel(server, isAllowedHost) {
  server.on('upgrade', (req, socket, head) => {
    const host = String(req.headers.host || '');
    const origin = req.headers.origin;
    let sameOrigin = true;
    try { sameOrigin = !origin || new URL(origin).host === host; } catch { sameOrigin = false; }
    if (req.url !== '/wisp/' || !isAllowedHost(host) || !sameOrigin) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wisp.routeRequest(req, socket, head);
  });
}

// 简单的按 IP 限流，防止匿名设备注册被滥用
const registrations = new Map();
function allowRegistration(ip) {
  const now = Date.now();
  const recent = (registrations.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (recent.length >= 5) return false;
  recent.push(now);
  registrations.set(ip, recent);
  if (registrations.size > 1000) registrations.delete(registrations.keys().next().value);
  return true;
}

const router = express.Router();

router.post('/account/sign', express.json({ limit: '32kb' }), (req, res) => {
  const { path, params = {}, identity, body = null } = req.body || {};
  if (typeof path !== 'string' || typeof params !== 'object' || Array.isArray(params)) {
    throw Object.assign(new Error('签名请求无效'), { status: 400 });
  }
  if (body !== null && typeof body !== 'string') throw Object.assign(new Error('请求体必须为字符串'), { status: 400 });
  const values = Object.fromEntries(Object.entries(params).map(([k, v]) => [String(k), String(v)]));
  res.json(signedAccountRequest(path, values, identity, body));
});

router.post('/account/device', async (req, res) => {
  if (!allowRegistration(req.ip)) {
    throw Object.assign(new Error('设备注册过于频繁，请稍后再试'), { status: 429 });
  }
  // 每次都是全新的匿名设备，不与其他浏览器共享
  const register = createPlaybackDeviceRegistrar();
  try {
    const { device_id, iid, cdid } = await register(requestJson);
    res.json({ device_id, iid, cdid });
  } catch (error) {
    throw Object.assign(error, { status: 502 });
  }
});

module.exports = { router, attachTunnel };
