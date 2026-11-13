# 部署方案

## 架构

采用**纯 Node.js 单镜像**方案：Express 同时托管前端 SPA 静态文件和后端 API/WebSocket，无需 Nginx。

```
Docker 容器 (:3001)
├── / 静态文件        → client/dist（Vite 产物）
├── /api/*           → REST API
└── /socket.io/*     → WebSocket
```

## CI/CD 流程

1. **push 到 main** → GitHub Actions 构建 Docker 镜像 → 推送到 GHCR（`ghcr.io`）
2. **服务器上**手动拉取并重建容器：

   ```bash
   cd /opt/projects/vinyl-together
   docker compose pull && docker compose up -d
   ```

GitHub 零额外 Secrets（使用自带的 `GITHUB_TOKEN`）。

### 为什么不用 Watchtower 自动更新

本项目的**服务端状态全部在内存里**（无数据库）：房间、队列、播放进度、房间级 Cookie 池都随进程消失。
重建容器 = 清空所有人的房间并把所有人踢出去。

自动更新（如 Watchtower 每 5 分钟轮询）会让「什么时候重启」完全脱离人工控制——很可能正好有人在听歌。
因此**刻意不做自动更新**，部署时机由人决定：确认没有活跃房间（或接受中断）后再拉取。

> ⚠️ 历史文档曾写「Watchtower 每 5 分钟自动更新」，但生产部署里**从未真正运行过 Watchtower**，
> 镜像长期停留在旧版本。现已改为如实描述手动流程。若将来仍想要自动更新，务必先评估重启代价。

## Docker 多阶段构建

- **阶段 1（deps）**：`pnpm install --frozen-lockfile` 安装全部依赖
- **阶段 2（build）**：分别构建 shared、server（tsc）、client（vite build）
- **阶段 3（production）**：仅安装 server 生产依赖（`--filter @music-together/server...`），复制构建产物

## CORS 策略

- `CLIENT_URL` 未设置 → 自动模式，允许所有来源访问（适用于单镜像同域部署、局域网、公网反代）
- `CLIENT_URL` 显式设置 → 严格白名单模式（适用于前后端分离跨域部署）

## Identity Cookie 策略

- 未显式设置 `IDENTITY_COOKIE_SECURE` 时，服务端会根据当前请求协议自动决定是否添加 `Secure`
- 局域网 HTTP 访问会下发非 Secure cookie
- 公网 HTTPS / 反代 HTTPS 访问会下发 Secure cookie
- 自动判断 HTTPS 依赖代理正确透传 `X-Forwarded-Proto`
- 仅在需要强制行为时才手动设置 `IDENTITY_COOKIE_SECURE`

## 前端同域适配

`SERVER_URL` 默认使用 `window.location.origin`，同域部署时自动指向当前页面的 origin，无需配置。

## 静态文件托管

`packages/server/src/index.ts` 在启动时检测 `client/dist/index.html` 是否存在：

- **存在**（生产环境）：挂载 `express.static` + SPA fallback
- **不存在**（本地开发）：跳过，零影响

## 服务器部署命令

生产使用 `docker compose`（部署目录 `/opt/projects/vinyl-together`，只放 compose 与 `.env`，
源码不落在服务器上）。核心等价命令：

```bash
# 首次部署 / 更新：拉取新镜像并重建容器
cd /opt/projects/vinyl-together
docker compose pull && docker compose up -d
```

等价的 `docker run` 形态（仅作参考，实际以 compose 为准）：

```bash
IDENTITY_SECRET="$(openssl rand -hex 32)"
docker run -d --name vinyl-together --restart unless-stopped \
  -p 127.0.0.1:20020:3001 \
  -v /data/projects/vinyl-together/local-audio:/data/local-audio \
  -e IDENTITY_SECRET="$IDENTITY_SECRET" \
  -e LOCAL_AUDIO_DATA_DIR=/data/local-audio \
  ghcr.io/dsdiov/vinyl-together:latest
```

> 宿主层 Caddy 反代 `mt.voidsd.top` → `localhost:20020`（容器内仍是 3001）。
> 镜像构建完成后容器**不会自动更新**，必须执行上面的 `pull && up -d`。

生产镜像已包含 FFmpeg/FFprobe。房间本地音频首版不跨服务重启持久化，服务启动时会清理无主文件；挂载存储可避免占用系统盘并提供临时上传空间。

生产环境必须设置至少 32 个字符的随机 `IDENTITY_SECRET`，它用于签名身份 cookie 和本地音频访问 URL。密钥应在容器重建时保持不变，可存放在权限受限的 `--env-file` 中。

本地音频默认单文件上限为 500 MiB、单房间配额为 1 GiB、全服配额为 2.5 GiB，并要求保留至少 1.5 GiB 可用空间。`LOCAL_AUDIO_FFMPEG_THREADS` 默认限制每个转码进程使用 1 个线程；`LOCAL_AUDIO_ACCESS_TOKEN_TTL_MS` 默认 86,400,000（24 小时），用于覆盖长录音的后续 Range/seek 请求。若要调低该值，仍应让它长于预期的最长单条录音，否则播放中的后续 Range 请求可能在曲终前过期。相关值可通过环境变量调整。

如使用反向代理，请转发 `127.0.0.1:3001` 并启用 WebSocket 和 HTTPS。若启用了本地音频上传，还需在反向代理 `location` 中加入：

```nginx
client_max_body_size 512m;
proxy_request_buffering off;
client_body_timeout 70s;
proxy_send_timeout 70s;
proxy_read_timeout 70s;
```

`client_max_body_size` 应不小于 `LOCAL_AUDIO_MAX_UPLOAD_MIB`；关闭请求体缓冲可让 Node.js 边接收边写入 `LOCAL_AUDIO_DATA_DIR`，避免代理先把大型上传暂存到磁盘。三个 timeout 均按“连续无数据时间”计算，70 秒略高于应用的 60 秒上传空闲取消阈值。
