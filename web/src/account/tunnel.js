// 端到端加密隧道：libcurl.js（WebAssembly）在浏览器内完成 TLS，
// 服务器的 /wisp/ 只转发加密后的 TCP 字节，看不到请求内容（包括 Cookie）。
// 首次使用账号功能时才加载（wasm 约 1.4MB）。
let loading = null;

export function loadTunnel() {
  loading ||= (async () => {
    const [{ libcurl }, { default: wasmUrl }] = await Promise.all([
      import('libcurl.js'),
      import('libcurl.js/libcurl.wasm?url'),
    ]);
    libcurl.logger = (type, text) => { if (type === 'error') console.warn('[tunnel]', text); };
    libcurl.stderr = () => {};
    await libcurl.load_wasm(wasmUrl);
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    libcurl.set_websocket(`${scheme}://${location.host}/wisp/`);
    return libcurl;
  })().catch((error) => {
    loading = null;
    throw new Error(`加密隧道初始化失败：${error.message || error}`);
  });
  return loading;
}

/** 经隧道发出 HTTPS 请求，返回 { status, headers, text } */
export async function tunnelFetch(url, { session, timeout = 15000, ...init } = {}) {
  const libcurl = await loadTunnel();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await (session || libcurl).fetch(url, { ...init, signal: controller.signal, _libcurl_http_version: 1.1 });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
  } catch (error) {
    if (controller.signal.aborted) throw new Error('红果服务器响应超时');
    throw new Error(`无法通过加密隧道连接红果：${error.message || error}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 带 Cookie 罐的会话（扫码登录流程用），可导出 Cookie */
export async function createSession() {
  const libcurl = await loadTunnel();
  return new libcurl.HTTPSession({ enable_cookies: true });
}

/** 解析 curl 导出的 Netscape 格式 Cookie 文件，返回指定域名的 "a=b; c=d" */
export function cookieHeaderFrom(jar, domain) {
  const pairs = new Map();
  for (const raw of String(jar || '').split('\n')) {
    const line = raw.startsWith('#HttpOnly_') ? raw.slice('#HttpOnly_'.length) : raw;
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const host = parts[0].replace(/^\./, '');
    const expires = Number(parts[4]);
    if (!(domain === host || domain.endsWith(`.${host}`))) continue;
    if (expires && expires * 1000 < Date.now()) continue;
    if (parts[6]) pairs.set(parts[5], parts[6]);
  }
  return [...pairs].map(([k, v]) => `${k}=${v}`).join('; ');
}
