<p align="center">
  <img alt="Vinyl Together" src="public/logo.svg" width="80">
</p>

<h1 align="center">Vinyl Together</h1>

<p align="center">
  A real-time collaborative music listening platform — create a room, invite friends, and listen to the same song perfectly synchronized. A feature fork of <a href="https://github.com/Yueby/music-together">Music Together</a>.
</p>

<p align="center">
  <a href="README.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/dsdioV/vinyl-together/stargazers"><img src="https://img.shields.io/github/stars/dsdioV/vinyl-together?style=flat&logo=github" alt="Stars"></a>
  <a href="https://github.com/dsdioV/vinyl-together/network/members"><img src="https://img.shields.io/github/forks/dsdioV/vinyl-together?style=flat&logo=github" alt="Forks"></a>
  <a href="https://github.com/dsdioV/vinyl-together/issues"><img src="https://img.shields.io/github/issues/dsdioV/vinyl-together?style=flat&logo=github" alt="Issues"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/dsdioV/vinyl-together?style=flat" alt="License"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white" alt="React">
  <img src="https://img.shields.io/badge/Vite-7-646CFF?logo=vite&logoColor=white" alt="Vite">
  <img src="https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss&logoColor=white" alt="Tailwind CSS">
  <img src="https://img.shields.io/badge/Socket.IO-4-010101?logo=socketdotio&logoColor=white" alt="Socket.IO">
  <img src="https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white" alt="Express">
  <img src="https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white" alt="Docker">
</p>

## Features

- **Real-time sync** -- NTP clock synchronization with minimal latency
- **Multi-platform sources** -- NetEase Cloud Music, QQ Music search and playback
- **Apple Music-style lyrics** -- Word-by-word animated lyrics, desktop and mobile optimized
- **VIP song support** -- Room-scoped cookie pool via NetEase QR login
- **RBAC permissions** -- Host > Admin > Member with fine-grained control
- **Voting system** -- Members vote to control playback actions
- **Play modes** -- Sequential, single loop, list loop, shuffle
- **Auto-remove played** -- Remove songs from queue after playback ends (configurable)
- **Default playlist** -- Auto-fill empty queue with random songs from a designated playlist (configurable)
- **Search by ID** -- Look up playlists and albums by numeric ID
- **Like mode** -- Most-liked song plays next (requires auto-remove)
- **Unlimited batch import** -- Remove the 200-song limit for playlist imports
- **Real-time chat** -- In-room text messaging with system messages
- **Role grace period** -- Privileged users retain roles for 30s after disconnect
- **Mobile responsive** -- Adaptive layout with orientation-based switching

## Quick Start

### Prerequisites

- Node.js >= 22
- pnpm >= 10

### Install & Develop

```bash
git clone https://github.com/dsdioV/vinyl-together.git
cd vinyl-together
pnpm install
pnpm dev
```

Frontend: http://localhost:5173 | Backend: http://localhost:3001

## Deploy

Single-image Docker deployment:

```bash
docker run -d --name vinyl-together --restart unless-stopped \
  -p 3001:3001 \
  ghcr.io/dsdioV/vinyl-together:latest
```

> If host port `3001` is already in use, change the left side of `-p <host-port>:<container-port>`, for example `-p 8080:3001`.

In default auto mode, the frontend connects back to the current origin automatically; the server allows all origins and decides whether to set the cookie `Secure` flag based on the incoming request protocol.

**Set `CLIENT_URL` only when you need an explicit origin whitelist:**

```bash
docker run -d --name vinyl-together --restart unless-stopped \
  -p 3001:3001 \
  -e CLIENT_URL=https://music.example.com \
  ghcr.io/dsdioV/vinyl-together:latest
```

> `CLIENT_URL` is mainly for explicit whitelist mode or separated frontend/backend deployments. In default auto mode, you usually do not need to set it manually.
>
> If you expose HTTPS through Nginx / Caddy / 1Panel / Lucky, make sure the proxy forwards `X-Forwarded-Proto`, or the server cannot auto-detect whether it should issue Secure cookies.

Push to main triggers GitHub Actions to build and push the image. See [Architecture Docs](docs/PROJECT_ARCHITECTURE.md) for details.

## Project Structure

```
packages/
  client/   -- Frontend React application
  server/   -- Backend Node.js service
  shared/   -- Shared types, constants, and permission definitions
```

## Acknowledgements

| Library | Description |
|---|---|
| [Howler.js](https://github.com/goldfire/howler.js) | Web audio playback |
| [Apple Music-like Lyrics](https://github.com/Steve-xmh/applemusic-like-lyrics) | Lyrics component (GPL-3.0) |
| [Meting](https://github.com/metowolf/Meting) | Multi-platform music API |
| [NeteaseCloudMusicApi Enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced) | NetEase Cloud Music API |
| [CASL](https://github.com/stalniy/casl) | Permission management |
| [Zustand](https://github.com/pmndrs/zustand) | State management |
| [shadcn/ui](https://github.com/shadcn-ui/ui) | UI component library |
| [Motion](https://github.com/motiondivision/motion) | Animation library |

## License

[AGPL-3.0](LICENSE)
