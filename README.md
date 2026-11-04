# HongguoWeb · 红果短剧第三方网页版

在 PC 浏览器里浏览、搜索、观看红果短剧。启动一个本地 Node 服务后，用 Chrome / Edge 打开即可。

## 快速开始

需要 Node.js 20 或更高版本。

```bash
npm install
npm run build      # 构建前端
npm start          # 启动服务 → http://127.0.0.1:8899
```

`npm run serve` 会先构建，再启动服务并自动打开浏览器。

开发时运行 `npm run dev`：后端会自动重启，前端走 Vite 热更新，地址为 http://localhost:5173。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8899` | 服务端口 |
| `HOST` | `127.0.0.1` | 监听地址。设为 `0.0.0.0` 后局域网内其他设备也能访问（此时不再校验 Host） |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `RELAY` | `1` | 设为 `0` 时关闭服务器中转，视频只能直连（见下文） |
| `ALLOWED_HOSTS` | 空 | 部署在反向代理之后时，填写对外域名（逗号分隔），否则请求会因 Host 校验被拒绝 |

## 部署到远端：视频直连 CDN，不占服务器带宽

默认情况下，视频会由浏览器**直接从红果 CDN 拉取并在本机解密**，服务器只负责签名取址，每集只返回几 KB 的 JSON。播放页工具栏右侧的指示器会显示当前的传输方式：

- 🟢 **直连 CDN**：显示链接剩余有效期和本集直连流量。点击指示器可以查看 CDN 节点、片源、取址时间、过期时间、自动刷新次数等详情。
- 🔵 **服务器中转**：直连不可用时自动回退，指示器会注明原因。
- 🟡 **正在刷新链接 / 链接已过期**：播放链接大约 6 小时后过期，到期前或 CDN 拒绝访问时会自动重新取址。

如果确认所有客户端都能直连，可以设置 `RELAY=0` 彻底关闭中转，防止视频流量意外经过服务器。

### 放在反向代理之后

推荐让服务只监听本机（`HOST=127.0.0.1`），由同一台机器上的反向代理对外提供 HTTPS。对反向代理的要求：

1. **必须是 HTTPS**。直连播放依赖 Service Worker 和 WebCrypto，浏览器只在 HTTPS（或 localhost）下允许使用。通过 `http://IP:端口` 访问时会自动退回服务器中转。
2. **保留原始 `Host` 头**，并把对外域名写进 `ALLOWED_HOSTS`（逗号分隔）。服务只监听本机时会校验 Host，以防 DNS rebinding；加密隧道还会核对 `Origin` 与 `Host` 是否同源。
3. **支持 WebSocket**。账号功能的加密隧道走 `<站点路径>/wisp/` 的 WebSocket 连接。
4. **传递 `X-Forwarded-For`**。服务只信任来自本机（loopback）的代理头，据此识别客户端 IP，用于匿名设备注册的限流。反向代理与服务不在同一台机器时，需要相应调整代码中的 `trust proxy` 设置。
5. **不要缓存 `sw.js`**。服务已经对它返回 `Cache-Control: no-cache`，代理不要覆盖。`assets/` 下带哈希的文件可以长期缓存。

#### 挂在子路径

站点也可以挂在域名的子路径下，例如 `https://example.com/hongguo/`：

- **构建**时用 `BASE_PATH` 指定子路径，前端生成的所有地址（API、视频、Service Worker 作用域、加密隧道、页面路由）都会带上这个前缀：`BASE_PATH=/hongguo npm run build`。
- **反向代理**负责去掉这个前缀再转发，服务本身仍按根路径处理请求。
- 访问不带结尾斜杠的 `/hongguo` 时，建议跳转到 `/hongguo/`。

本地开发不需要设置 `BASE_PATH`。在 Git Bash 里构建子路径版本时要加 `MSYS_NO_PATHCONV=1`，否则 `/hongguo` 会被改写成 Windows 路径。

#### 配置示例

Caddy（会自动申请证书，并默认处理 Host、`X-Forwarded-For` 与 WebSocket）：

```
# 挂在域名根路径
hongguo.example.com {
    reverse_proxy 127.0.0.1:8899
}

# 挂在子路径 /hongguo/
example.com {
    handle /hongguo {
        redir * /hongguo/ 308
    }
    handle_path /hongguo/* {
        reverse_proxy 127.0.0.1:8899
    }
}
```

Nginx（挂在子路径 /hongguo/，证书配置从略）：

```nginx
# http 块内
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

# server 块内
location = /hongguo {
    return 308 /hongguo/;
}
location /hongguo/ {
    proxy_pass http://127.0.0.1:8899/;       # 结尾的 / 会去掉 /hongguo 前缀
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;  # 加密隧道的 WebSocket
    proxy_set_header Connection $connection_upgrade;
    proxy_buffering off;                     # 服务器中转时边解密边返回视频
}
```

启动服务时带上对外域名：`ALLOWED_HOSTS=example.com,www.example.com npm start`。

### 用 Docker 运行

镜像分两阶段构建：先在容器内构建前端，运行阶段只安装生产依赖。子路径通过构建参数传入：

```bash
docker build --build-arg BASE_PATH=/hongguo -t hongguoweb .
docker run -d --name hongguoweb --restart unless-stopped --network host --memory 640m \
  -e HOST=127.0.0.1 -e PORT=8899 -e ALLOWED_HOSTS=example.com,www.example.com \
  hongguoweb
```

- 使用 `--network host` 并只监听 `127.0.0.1`，这样同机的反向代理可以直接访问，服务也不会暴露到公网；代理请求来自本机，客户端 IP 识别正常。
- 在中国大陆构建时，可以加 `--build-arg NPM_REGISTRY=https://registry.npmmirror.com` 使用 npm 镜像源。
- 挂在域名根路径时，去掉 `BASE_PATH` 参数即可。
- 空闲时内存占用约 35MB。服务器中转需要缓存视频分片，`--memory` 不建议低于 512MB。

### 其他注意事项

- 强制刷新（Ctrl+Shift+R）会让本页绕过 Service Worker，普通刷新一次即可恢复直连。
- 签名取址和匿名设备注册仍由服务器发起。如果服务器 IP 被红果风控，所有功能都会受影响，与传输方式无关。
- 登录状态按网址分别保存，在不同域名下访问需要分别扫码登录。

## 红果账号：每个浏览器登录自己的账号

本站不维护任何账号。用手机红果 App 扫码即可在网页上登录**你自己的红果账号**，登录状态只保存在当前浏览器中。

- **云端观看记录**：读取账号最近 50 部观看记录。首页「继续观看」会合并本机和云端记录。
- **跨设备续播**：打开一部剧时，比较本机记录和云端记录，取更新的那条。云端记录优先按分集 ID 匹配，所以手机上看到哪一集、第几秒，网页上就从哪里继续。
- **进度回写**：网页上的观看进度会同步回账号，手机 App 可以接着看。播放中每 30 秒同步一次，暂停、切集或离开页面时立即同步。可以在账号菜单里关闭。
- **追剧同步**：登录后，播放页的「收藏」按钮变成「追剧」，操作的是账号的追剧列表。每次写入前先读取最新列表，写入后再回读确认，不会重复提交。
- **官方评论**：播放页侧栏显示本集的官方公开评论，不需要登录。红果官网每集只公开约 15 条评论，而且只开放前几集，之后的分集官网没有评论可读。

### 登录凭据不经过服务器

浏览器无法直接调用红果的登录和账号接口：这些接口不支持跨域，而且请求要带 `Cookie` 头。所以本站用**端到端加密隧道**来访问它们：

```
浏览器（libcurl.js / WebAssembly，在浏览器内完成 TLS）
   ══ WebSocket /wisp/ ══▶ 服务器（只转发加密后的 TCP 字节）──▶ 红果（443 端口）
```

- TLS 握手和加解密都在浏览器里完成，服务器只能看到加密后的字节，**看不到 Cookie 和任何账号数据**。
- 账号接口的签名（X-Gorgon 等）只覆盖 URL 和请求体，不包含 Cookie。签名由服务器计算（`/api/account/sign`），浏览器拿到签名后，在隧道内自行附加 Cookie 发出请求。
- 每个浏览器登录时会注册一个独立的匿名设备身份，各浏览器之间互不共享。
- 隧道只允许连接 `hongguoduanju.com`、`*.fqnovel.com`、`*.snssdk.com` 的 443 端口，拒绝其他域名、端口、IP 直连和跨站连接，防止服务器被当作开放代理。
- 隧道组件（约 1.4MB 的 wasm）只在用到账号功能时才加载。

部署在反向代理之后时，代理需要支持 WebSocket，见「放在反向代理之后」一节。

## 功能

- **发现**：热播榜、真人 / 漫剧 / AI 短剧热播榜，以及按题材筛选的分类浏览，滚动到底自动加载下一页
- **搜索**：按剧名、演员搜索；也可以直接粘贴 App 分享链接或剧集 ID，跳转到播放页
- **播放**：竖屏自适应、选集、自动连播、倍速、画质（最高 / 1080P / 720P）、全屏，以及播放下一集前的预加载
- **快捷键**：`空格` / `K` 播放或暂停，`←` / `→` 快退或快进 5 秒，`↑` / `↓` 切换上一集或下一集，`F` 全屏，`M` 静音；在画面上滚动鼠标滚轮也能切集（可关闭）
- **我的追剧**：本机历史、云端记录、本机收藏、账号追剧四个页签；未登录时只有本机数据，保存在浏览器 localStorage 中
- **红果账号**：扫码登录、云端记录与跨设备续播、进度回写、追剧同步（见上文）
- **官方评论**：播放页侧栏显示本集的官方公开评论
- **剧星榜**：演员排行、演员主页、合作演员、参演作品

## 工作原理

```
浏览器 (Vue 3) ──/api/*（目录 / 搜索 / 取址，几 KB）──▶ Node 服务 ──▶ 红果 App / 官网接口
   │
   ├─ 直连（默认）：<video src="/media/:vid"> ─▶ Service Worker ─▶ 红果 CDN
   │                 在浏览器内用 WebCrypto 解密，并改写 MP4 容器
   └─ 中转（回退）：<video src="/api/stream/:vid"> ─▶ Node 服务解密 ─▶ 红果 CDN
```

- 红果的视频是 CENC (AES-CTR) 加密的 MP4，浏览器无法直接播放。直连和中转两条路径的处理方式相同：先读取 `moov` 元数据，把 `encv` 改写回 `hvc1` / `avc1`，再按 `<video>` 的 Range 请求向 CDN 拉取对应分片，边解密边返回，所以拖动进度条可以即时生效。两条路径的输出逐字节一致。
- CDN 允许跨域访问，但请求带 Referer 时会返回 403，所以直连请求统一设置为 `referrerPolicy: no-referrer`。直连的实现见 `web/public/sw.js`。
- 接口签名、匿名设备注册、密钥派生都在服务端完成。账号请求经端到端加密隧道发往红果，见「红果账号」一节。

## 浏览器兼容性

红果的片源大多是 **HEVC (H.265)** 编码，推荐使用最新版 **Edge** 或 **Chrome**（Windows 上需开启硬件加速，显卡需支持 HEVC 解码）。如果画面无法播放，页面会提示原因，可以尝试切换画质。

## 目录结构

```
server/
  index.js              Web 服务与 API 路由
  account.js            加密隧道（/wisp/，域名白名单）、账号接口签名、匿名设备注册、官方评论
  services/             剧集服务、流式解密、Range 分片读取、日志
  native/               红果协议层：签名、设备注册、目录 / 搜索 / 演员接口、MP4 解密
web/
  public/sw.js          直连播放 Service Worker：CDN 直连 + 浏览器内解密
  src/media.js          Service Worker 注册、直连可用性检测与状态
  src/account/          红果账号：加密隧道客户端、扫码登录与账号接口、账号状态
  src/views/            页面：发现、搜索、播放、我的追剧、剧星榜、演员主页
  src/components/       海报卡片、自动加载、传输方式指示器、登录弹窗、账号菜单
  src/store.js          本地历史 / 收藏 / 播放偏好
```

## 致谢与许可

`server/native/` 和 `server/services/` 下的协议、解密与流媒体代码来自
[zfdang/hongguo-open-player](https://github.com/zfdang/hongguo-open-player)（GPL-3.0，commit `61d9d36`），
原始出处见各文件头部注释。该项目又参考了 zhangbaio/hongguo、N3urda/hongguoTV、woshishiq1/drpys、
jackotom/hongguo-drama、yangbin1322/hongguo-player 等社区项目。

红果账号相关的协议（扫码登录、账号接口签名、云端记录、追剧、进度上报、官方评论来源）参考了
[jackotom/hongguo-drama](https://github.com/jackotom/hongguo-drama) 和
[tsukiyo-zero/hongguoTV](https://github.com/tsukiyo-zero/hongguoTV)（均为 GPL-3.0）。
加密隧道使用 [libcurl.js](https://github.com/ading2210/libcurl.js) 与
[wisp-js](https://github.com/MercuryWorkshop/wisp-js)（均为 LGPL-3.0）。

由于引用了 GPL-3.0 代码，本项目同样以 **GPL-3.0** 发布，详见 [LICENSE](LICENSE)。

## 免责声明

本项目仅供个人学习与技术交流，不得用于商业用途。所有音视频与元数据都实时请求自红果的公开服务，本项目不存储、不分发任何内容。请支持正版。
