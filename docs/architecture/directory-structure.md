# 目录结构

## 根目录

```
music-together/
├── packages/
│   ├── client/          # React 前端
│   ├── server/          # Node.js 后端
│   └── shared/          # 共享类型与常量
├── docs/                # 项目文档（含本文件 PROJECT_ARCHITECTURE.md）
├── package.json         # 根 package（工作区编排）
├── pnpm-workspace.yaml  # pnpm 工作区定义
├── pnpm-lock.yaml
├── README.md
└── .gitignore
```

## packages/client/src/ — 前端源码

```
src/
├── main.tsx                    # 入口：ReactDOM.createRoot
├── App.tsx                     # 根组件：Router + Provider + ErrorBoundary + Suspense 懒加载
├── index.css                   # 全局样式：Tailwind + 配色变量 + 自定义动画
│
├── pages/                      # 页面级组件
│   ├── HomePage.tsx            #   大厅：创建/加入房间、房间列表
│   ├── RoomPage.tsx            #   房间：播放器 + 聊天（桌面侧栏/移动端 Drawer） + 覆盖层弹窗
│   └── NotFoundPage.tsx        #   404 页面
│
├── components/                 # UI 组件
│   ├── Chat/
│   │   ├── ChatMessage.tsx     #     单条消息（用户/系统）
│   │   └── ChatPanel.tsx       #     聊天面板（消息列表 + 输入框）
│   ├── Lobby/
│   │   ├── CreateRoomDialog.tsx #    创建房间弹窗
│   │   ├── NicknameDialog.tsx  #     设置昵称弹窗
│   │   ├── PasswordDialog.tsx  #     输入房间密码弹窗
│   │   ├── RoomCard.tsx        #     房间列表卡片
│   │   ├── UserPopover.tsx     #     用户信息气泡
│   │   ├── HeroSection.tsx     #     首页 Hero 标题区域
│   │   ├── ActionCards.tsx     #     创建/加入房间卡片
│   │   └── RoomListSection.tsx #     活跃房间列表区域
│   ├── TrackListItem.tsx        #   共享曲目行渲染（序号+封面+标题VIP+歌手可点击+时长+isAdded 添加按钮，memo 优化）
│   ├── VirtualTrackList.tsx     #   共享虚拟滚动曲目列表（@tanstack/react-virtual + 无限加载 + skeleton + 空态，forwardRef 暴露 scrollToTop）
│   ├── Overlays/
│   │   ├── QueueDrawer.tsx     #     播放队列抽屉（vaul Drawer，移动端底部/桌面端右侧）
│   │   ├── SearchDialog.tsx    #     音乐搜索弹窗（VirtualTrackList 虚拟滚动 + 自动无限加载 + AbortController 竞态防护）
│   │   ├── LocalAudioPanel.tsx #     房间本地音频上传任务、资产编辑/删除与排序
│   │   ├── LocalAudioDropOverlay.tsx # 本地音频拖拽上传覆盖层（全局拖拽准入提示）
│   │   ├── HistoryDrawer.tsx   #     播放历史抽屉（相对/绝对时间展示）
│   │   ├── SettingsDialog.tsx  #     设置弹窗（壳，Tab 导航：房间/成员/账号/个人/外观，移动端 nav scrollbar-hide）
│   │   └── Settings/
│   │       ├── SettingRow.tsx              # 设置行共享组件
│   │       ├── RoomSettingsSection.tsx     # 房间设置（名称、密码）
│   │       ├── DefaultPlaylistSection.tsx  # 默认播放列表设置（房主：指定歌单/开关/上限）
│   │       ├── MembersSection.tsx          # 成员列表（角色管理）
│   │       ├── PlatformAuthSection.tsx     # 平台账号认证（VIP Cookie，旧版，已被 PlatformHub 替代）
│   │       ├── PlatformHub.tsx            # 平台中心（登录 + 歌单浏览 + 导入，替代 PlatformAuthSection）
│   │       ├── LoginSection.tsx           # 精简版平台登录区域（PlatformHub 子组件）
│   │       ├── PlaylistSection.tsx        # 歌单列表 + 手动输入（PlatformHub 子组件）
│   │       ├── PlaylistDetail.tsx         # 歌单详情（header + VirtualTrackList + queueKeys/addedIds 去重 + 动态全部添加过滤重复）
│   │       ├── ProfileSettingsSection.tsx  # 个人设置（昵称）
│   │       ├── AppearanceSection.tsx       # 外观设置（背景 + 布局）
│   │       ├── LyricsSection.tsx           # 歌词外观设置（TTML 逐词开关等）
│   │       ├── OtherSettingsSection.tsx    # 其他设置
│   │       ├── ManualCookieDialog.tsx      # 手动输入 Cookie 弹窗
│   │       └── QrLoginDialog.tsx           # 通用 QR 扫码登录弹窗（网易云 + 酷狗 + QQ 音乐）
│   ├── Player/
│   │   ├── constants.ts        #     共享动画常量（SPRING / LAYOUT_TRANSITION），NowPlaying 和 SongInfoBar 统一导入
│   │   ├── AudioPlayer.tsx     #     主播放器布局（桌面：左右分栏；移动：双模式封面/歌词切换）
│   │   ├── LyricDisplay.tsx    #     AMLL 歌词渲染（LRC 正则支持 [mm:ss] / [mm:ss.x] / [mm:ss.xx] / [mm:ss.xxx]）
│   │   ├── NowPlaying.tsx      #     当前曲目展示（支持 compact 小封面横排模式 + layoutId 共享动画）
│   │   ├── SongInfoBar.tsx     #     歌曲信息栏（标题/艺术家 + 音量/聊天按钮，竖屏模式自适应缩放）
│   │   └── PlayerControls.tsx  #     进度条+播放控制+播放模式切换
│   ├── Room/
│   │   └── RoomHeader.tsx      #     房间头部（房间名/人数/连接状态；移动端 DropdownMenu 收纳设置/离开等操作）
│   ├── Vote/
│   │   └── VoteBanner.tsx      #     投票横幅（进行中的投票显示 + 投票按钮）
│   ├── InteractionGate.tsx     #   浏览器交互解锁（点击后才能播放音频）
│   └── ui/                     #   shadcn/ui 基础组件
│       ├── avatar.tsx
│       ├── badge.tsx
│       ├── button.tsx
│       ├── card.tsx
│       ├── dialog.tsx
│       ├── drawer.tsx
│       ├── dropdown-menu.tsx
│       ├── input.tsx
│       ├── label.tsx
│       ├── popover.tsx
│       ├── resize-handle.tsx
│       ├── scroll-area.tsx
│       ├── select.tsx
│       ├── separator.tsx
│       ├── marquee-text.tsx
│       ├── numeric-input.tsx
│       ├── responsive-dialog.tsx
│       ├── sheet.tsx
│       ├── skeleton.tsx
│       ├── slider.tsx
│       ├── switch.tsx
│       ├── tabs.tsx
│       ├── toggle.tsx
│       ├── toggle-group.tsx
│       └── tooltip.tsx
│
├── hooks/                      # 自定义 Hooks
│   ├── useSocketEvent.ts       #   通用 Socket 事件订阅工具 Hook（自动 on/off，ref 稳定）
│   ├── usePlayer.ts            #   播放器主 hook（组合 useHowl + useLyric + usePlayerSync）
│   ├── useHowl.ts              #   Howler.js 音频实例管理
│   ├── useLyric.ts             #   歌词加载（TTML → 平台逐词 YRC/KRC → LRC）
│   ├── usePlayerSync.ts        #   播放同步（Scheduled Execution + Host 上报 + 周期性漂移校正）
│   ├── useClockSync.ts         #   NTP 时钟同步 hook（校准客户端时钟与服务器对齐）
│   ├── useRoom.ts              #   房间组合 hook（编排房间同步与本地音频上传子 hook，对外 API 不变）
│   ├── room/                   #   useRoom 子 hook（按职责拆分）
│   │   ├── useRoomState.ts     #     ROOM_STATE / JOIN / LEFT / SETTINGS / ROLE_CHANGED / ERROR + 挂载时补发 cookie（覆盖 HomePage 提前消费 ROOM_STATE 的场景）
│   │   ├── useChatSync.ts      #     CHAT_HISTORY / CHAT_MESSAGE
│   │   ├── useQueueSync.ts     #     QUEUE_UPDATED
│   │   ├── useLocalAudioSync.ts #    本地音频任务/资产 Socket 同步与快照
│   │   ├── useAuthSync.ts      #     AUTH_SET_COOKIE_RESULT + localStorage 持久化（验证失败只做 toast 反馈，永不删除 cookie；删除权仅在 useAuth.logout）
│   │   └── useConnectionGuard.ts #   disconnect → resetAllRoomState
│   ├── useAuth.ts              #   平台认证 UI & Socket 事件
│   ├── useVote.ts              #   投票（使用 useSocketEvent）
│   ├── useChat.ts              #   聊天消息收发
│   ├── useLobby.ts             #   大厅房间列表与操作（使用 useSocketEvent）
│   ├── useQueue.ts             #   播放队列操作（含 addBatchTracks 批量添加）
│   ├── usePlaylist.ts          #   歌单管理（用户歌单列表、分页曲目获取 + 无限加载、URL 解析、批量导入）
│   ├── useIsMobile.ts          #   布局维度：orientation 检测（portrait=竖屏布局，landscape=横屏布局）
│   ├── useHasHover.ts          #   交互维度：hover 能力检测（(hover: hover) 媒体查询，触控设备=false）
│   ├── useContainerPortrait.ts #   容器宽高比检测（ResizeObserver，用于播放器横竖屏切换）
│   ├── useCoverWidth.ts        #   封面容器最小尺寸测量（约束信息栏/控件宽度与封面对齐）
│   ├── useSearch.ts            #   搜索逻辑（分页 / abort / 竞态保护，从 SearchDialog 抽出，UI 组件只负责渲染）
│   ├── useMusicRelay.ts        #   通过 <script> 标签执行一次 JSONP 中继请求（跨域读取响应）
│   ├── usePlatformAutoSwitch.ts #   自动切到全房间最早 VIP 的平台（听到 VIP 曲目时自动换源）
│   ├── useVersionCheck.ts      #   客户端比服务端旧时提示刷新（GET /api/version）
│   ├── useMediaSession.ts      #   系统媒体控制集成（Media Session API：播放/暂停/上下曲）
│   └── useLocalAudioFileQueue.ts # 本地音频文件选择/拖拽统一准入（先校验再入队）
│
├── stores/                     # Zustand 状态仓库
│   ├── playerStore.ts          #   播放状态（currentTrack, isPlaying, volume 等）
│   ├── roomStore.ts            #   房间状态（room, currentUser, users）
│   ├── chatStore.ts            #   聊天（messages, unreadCount, isChatOpen）
│   ├── lobbyStore.ts           #   大厅（rooms 列表, isLoading）
│   ├── localAudioStore.ts      #   房间本地音频资产、上传任务与配额状态（搜索/排序由 LocalAudioPanel 管理）
│   └── settingsStore.ts        #   设置（歌词参数、背景参数，持久化到 localStorage）
│
├── providers/                  # React Context Provider
│   ├── SocketProvider.tsx      #   Socket.IO 连接管理，提供 socket + isConnected + 断线/重连 Toast
│   └── AbilityProvider.tsx     #   CASL 权限上下文（基于 currentUser.role）
│
└── lib/                        # 工具库
    ├── config.ts               #   配置常量（SERVER_URL）
    ├── constants.ts            #   命名常量（定时器、阈值、布局尺寸）
    ├── clockSync.ts            #   NTP 时钟同步引擎（采样、offset 计算、getServerTime）
    ├── resetStores.ts          #   全局 store 重置工具
    ├── socket.ts               #   Socket.IO 客户端实例
    ├── storage.ts              #   localStorage 封装（带类型校验）
    ├── platform.ts             #   平台常量（PLATFORM_LABELS / PLATFORM_SHORT_LABELS / PLATFORM_COLORS / VIP_LABELS / 状态查找函数）
    ├── format.ts               #   格式化工具（时间、文本等）
    ├── audioUnlock.ts          #   浏览器音频自动播放解锁
    ├── localAudioProtocol.ts   #   本地媒体 URL 与上传 API 协议工具
    ├── localAudioDrop.ts       #   本地音频拖拽事件准入（防误拖文件/链接）
    ├── localAudioFiles.ts      #   本地音频文件统一准入规则（按钮 + 拖拽共用）
    ├── localAudioPlayback.ts   #   本地音频播放前缀/URL 处理
    ├── localAudioUploadPolicy.ts # 本地上传策略（配额/格式/扩展名校验）
    ├── batchQueueAdd.ts        #   批量添加按单条消息上限分块（预设余量 < 服务端 1000 上限）
    ├── defaultQueue.ts         #   默认播放列表元数据批量补全（仅 owner/admin，单批 ≤50 id）
    ├── queueFilter.ts          #   主队列本地搜索过滤（标题/歌手，大小写不敏感）
    ├── musicInput.ts           #   平台资源 ID / 官方链接 / 酷狗短码 / BV・av 号解析
    ├── playlistLoad.ts         #   歌单加载 HTTP 错误 → 可安全展示的文案
    ├── trackLookup.ts          #   曲目精确查找失败归一化（code/message）
    └── utils.ts                #   cn() + trackKey() 等通用工具
```

## packages/server/src/ — 后端源码

```
src/
├── index.ts                    # 入口：Express + HTTP + Socket.IO 服务启动与优雅关闭
├── config.ts                   # 环境变量配置（PORT, CLIENT_URL, CORS、本地音频路径/配额/FFmpeg）
│
├── controllers/                # 控制器：注册 Socket 事件处理器（薄编排层，不含业务逻辑）
│   ├── index.ts                #   统一注册入口
│   ├── roomController.ts       #   房间生命周期（创建/加入/离开/发现/设置/角色）
│   ├── playerController.ts     #   播放控制（play/pause/seek/next/prev/sync/set_mode）+ NTP ping/pong
│   ├── queueController.ts      #   队列管理（add/remove/reorder/clear）
│   ├── chatController.ts       #   聊天消息（含限流反馈）
│   ├── voteController.ts       #   投票系统（发起/投票/超时/执行，支持 set-mode / play-track / remove-track 投票）
│   ├── authController.ts       #   平台认证（QR 登录/Cookie 管理/状态查询；支持网易云/酷狗/QQ 音乐三平台；策略模式——通过 AUTH_PROVIDERS 映射表统一处理；fast path: 内存池命中跳过 API；slow path: getUserInfo + 任意失败重试 1 次）
│   ├── localAudioController.ts #   房间本地音频任务取消、资产编辑/删除
│   ├── playlistController.ts   #   歌单管理（获取用户歌单列表 via Socket，使用 getUserCookie 取请求者自己的 cookie，歌单私有）
│   └── musicRelayController.ts #   浏览器中继开关与回传事件注册（relay:mode_changed / music:relay_response）
│
├── services/                   # 服务层：业务逻辑
│   ├── roomService.ts          #   房间 CRUD + 角色管理 + 加入校验（validateJoinRequest）
│   ├── roomLifecycleService.ts #   房间生命周期定时器（空置删除）+ 防抖广播
│   ├── playerService.ts        #   播放状态管理 + 流 URL 解析 + 切歌防抖 + 加入播放同步
│   ├── queueService.ts         #   队列操作（reorder 保留未包含曲目防丢歌，getNextTrack 支持 4 种播放模式，clearQueue 清空，addBatchTracks 批量添加）
│   ├── chatService.ts          #   聊天消息处理 + HTML 转义（含系统消息）
│   ├── syncService.ts          #   播放位置估算工具（estimateCurrentTime）
│   ├── musicProvider.ts        #   音乐数据聚合（3 层引用式 LRU 缓存 + 外部 API 超时保护 + 最多 10,000 首的歌单分页/全量搜索；Netease 每批 1,000 首，Kugou/Tencent 使用原生分页 API）
│   ├── authService.ts          #   Cookie 池管理（房间级作用域；getAnyCookie 用于 VIP 播放共享，getUserCookie 用于歌单等用户私有操作）
│   ├── authProvider.ts         #   统一认证接口（AuthProvider 接口定义 + GetUserInfoResult/UserInfoData 共享类型 + AUTH_PROVIDERS 策略映射表）
│   ├── neteaseAuthService.ts   #   网易云 API 认证（QR / Cookie 验证 / 用户信息 / 用户歌单列表；getUserInfo 返回 { ok, data? } | { ok: false, reason: 'expired' | 'error' } 区分过期与临时故障）
│   ├── kugouAuthService.ts    #   酷狗 API 认证（QR 扫码登录 + VIP 检查 + 用户昵称(RSA) + 用户歌单列表 + 歌单歌曲获取；kugouRequest 含 HTTP 状态检查与 JSON 安全解析；自包含签名实现，状态码归一化为 800-803 与网易云统一）
│   ├── tencentAuthService.ts  #   QQ 音乐认证（5 步 OAuth QR 扫码登录：ptqrshow/ptqrlogin/check_sig/authorize/QQLogin 换取 musickey；zzc 签名防风控；getUserInfo 获取昵称 + VIP 状态；getUserPlaylists 获取自建 + 收藏歌单；getPlaylistTracks 分页获取歌单歌曲）
│   ├── localAudioAccess.ts     #   房间/资产/variant 绑定的 HMAC 媒体访问签名
│   ├── localAudioMedia.ts      #   FFprobe 白名单校验、FFmpeg 转码/封面提取与 Range 解析
│   ├── localAudioService.ts    #   上传任务、配额、资产生命周期、队列引用与房间清理
│   ├── identityService.ts      #   HMAC 签名身份 token（mt_identity cookie：uid + iat/exp/ver）
│   ├── rejoinTicketService.ts  #   断线重连令牌（短时有效，凭票免全套校验重入房间）
│   ├── kugouShortCodeService.ts #  酷狗 `#短码` / `#hash=` 链接解析（mixsong 页面）
│   ├── musicRelayService.ts    #   QQ 浏览器中继（白名单 URL 前缀、10s 超时、最多轮询 3 个客户端、断线清理）
│   ├── trackFallbackService.ts #   netease ↔ tencent 自动换源（标题/歌手归一化 + Jaccard 打分）
│   └── voteService.ts          #   投票状态管理
│
├── repositories/               # 数据仓库：内存存储
│   ├── types.ts                #   接口定义（RoomRepository, ChatRepository）
│   ├── roomRepository.ts       #   房间数据 + Socket 映射 + per-socket RTT + roomToSockets 反向索引（Map<string, RoomData>）
│   └── chatRepository.ts       #   聊天记录（Map<string, ChatMessage[]>）
│
├── middleware/                  # 中间件（Socket.IO + HTTP）
│   ├── types.ts                #   TypedServer, TypedSocket, HandlerContext
│   ├── withRoom.ts             #   房间成员身份校验
│   ├── withControl.ts          #   操作权限校验（包装 withRoom）
│   ├── socketRateLimiter.ts    #   Socket 事件速率限制（per-socket，10次/5秒）+ 断连清理（cleanupSocketRateLimit）
│   ├── socketIdentity.ts       #   Socket 握手身份守卫：必须携带有效 mt_identity cookie
│   ├── identityHttp.ts         #   HTTP 身份中间件（解析 mt_identity cookie → req.identityUserId）
│   └── localAudioHttpRateLimiter.ts # 本地音频媒体流 / 导出请求的 HTTP 限流
│
├── routes/                     # Express REST 路由
│   ├── music.ts                #   GET /api/music/search|url|lyric|cover|bilibili/stream|playlist|playlist/search|ttml|cover-proxy（统一 validated() 路由包装器 + Zod 模式）
│   ├── localAudio.ts           #   本地音频任务/资产 REST、签名媒体 Range/HEAD（成员鉴权）
│   ├── auth.ts                 #   POST /api/identity/bootstrap（签发/续期身份 cookie，返回 204）
│   └── rooms.ts                #   GET /api/rooms/:roomId/check（房间预检）
│
├── types/
│   └── meting.d.ts             #   @meting/core 类型声明
│
└── utils/
    ├── logger.ts               #   结构化日志（基于 pino，info/warn/error + JSON context）
    ├── roomUtils.ts            #   房间数据转换纯函数（toPublicRoomState / toPublicRoomStateForOwner，密码仅 owner 可见）
    ├── cookieUtils.ts          #   Cookie 字符串解析（兼容 Netscape 文件导出格式，替代各 authService 重复实现）
    ├── coverResponse.ts        #   封面响应流式读取（内存上限保护，供 cover-proxy 使用）
    └── defaultQueueRef.ts      #   默认播放列表 Track ↔ DefaultQueueTrackRef 收窄/批量补全
```

## packages/shared/src/ — 共享代码

```
src/
├── index.ts           # 统一导出（re-export 所有模块）
├── types.ts           # 核心类型：MusicSource（仅在线平台）, TrackSource（含 local）, Track（含 assetId/fallbackStreamUrl）, RoomState, PlayState, ScheduledPlayState, PlayMode, AudioQuality, User, ChatMessage, VoteAction (incl. play-track, remove-track), VoteState, RoomListItem, Playlist
├── events.ts          # 事件常量：EVENTS 对象（room:*, player:*, queue:*, chat:*, auth:*, ntp:*, playlist:*, local_audio:*）
├── socket-types.ts    # Socket.IO 类型：ServerToClientEvents, ClientToServerEvents
├── constants.ts       # 业务常量：LIMITS（长度/数量限制）, TIMING（同步间隔/宽限期）, NTP（时钟同步参数）, QR_STATUS（扫码状态码）, QR_TIMING（轮询间隔）
├── schemas.ts         # Zod 验证 schema
├── abilities.ts       # CASL 权限定义（Actions incl. set-mode, Subjects, defineAbilityFor）
├── coverUrl.ts        # 封面 URL 白名单校验与清洗（按平台限定 CDN 主机，防 SSRF/注入）
└── vote.ts            # 投票动作 / 播放模式中文文案（ACTION_LABELS、PLAY_MODE_LABELS）
```

---
