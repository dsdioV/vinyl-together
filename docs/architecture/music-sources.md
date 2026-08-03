# 音源与播放链接（music-sources.md）

> 记录四个音源平台（网易云 / QQ 音乐 / 酷狗 / 哔哩哔哩）的接入方式、降级链、海外部署行为和浏览器中继协议。修改任何平台相关代码前先读本文。

## 1. 总体结构

- 服务端统一入口：`packages/server/src/services/musicProvider.ts` 的 `MusicProvider`。
- 统一类型：`packages/shared` 的 `Track`（`sourceId`、`urlId`、`lyricId`、`picId`、`mediaMid`、`vip` 等）。
- 三级缓存：Track 注册表（元数据）→ 引用索引（id 列表）→ 资源缓存（播放链接/封面/歌词）。
- 客户端 `Track` 往返保留 `mediaMid`（QQ 播放链接拼接所需，服务端 schema 放行）。

## 2. 平台能力与降级链

### 网易云（netease）

| 能力 | 实现 |
| --- | --- |
| 搜索 / 歌单 / 单曲详情 | `@neteasecloudmusicapienhanced/api`（进程内嵌入） |
| 播放链接 | `song_url_v1`（按房间音质降级 lossless/exhigh/standard）→ 失败回退 `song_url_match` |
| 匿名 cookie | `register_anonimous`，进程内缓存 |
| 歌词 | `lyric_new`（LRC/翻译/罗马音/YRC 逐词） |

要点：生产 IP（尤其海外）可能被 `song_url_v1` 直接拒（songCode 404），`song_url_match` 是实际兜底，不要删除。启动时 `neteaseApiBootstrap` 生成 xeapi 公钥与匿名 token。

### QQ 音乐（tencent）— 重点

| 能力 | 降级链（高 → 低） |
| --- | --- |
| 单曲搜索 | 明文 `musicu.fcg` Desktop 搜索 → 签名版 `musics.fcg`（zzc）→ 旧版 `client_search_cp`（海外可用） |
| 专辑搜索 | Desktop 搜索（search_type=2）→ 综合搜索 `music.adaptor.SearchAdaptor` / `do_search_v2` 的 `item_album`（海外可用） |
| 歌单搜索 | Desktop 搜索（search_type=3）→ 综合搜索 `item_songlist`（海外可用） |
| 单曲详情 | 明文 `music.trackInfo.UniformRuleCtrl` → 签名版同模块 → 旧版 `fcg_play_single_song`（海外可用） |
| 播放链接 | 明文 `music.vkey.GetVkey` / `UrlGetVkey` → 签名版同模块 → 旧版 `vkey.GetVkeyServer` / `CgiGetVkey`（GET）→ **浏览器中继** |
| 登录 | QR 扫码（ptlogin2 + OAuth + musickey），cookie 存房间 |

细节：

- 旧版 `vkey.GetVkeyServer` 在境内可能返回空（本仓库实测），但它是海外唯一可到达的直连通道（API 可达、匿名 104003）。
- 旧版 `music.trackInfo.UniformRuleClass` 已被风控（500003），一律使用 `UniformRuleCtrl`。
- `media_mid` 与歌曲 mid 常常不同；解析播放链接优先用注册表携带的 `mediaMid`，失败时经单曲详情恢复后重试一次。
- 匿名可播放档位最高 128kbps（`M500`）；更高档位与 VIP 歌曲需要登录 cookie。
- 失败分类：`104003/104013` → 无 cookie 报 `login_required`，有 cookie 报 `vip_or_copyright`；其余为 `upstream_failed`；超时单独分类。
- 权限拒绝（104003/104013）与 media_mid 无关，跳过详情恢复，直接进入中继/分类，避免多余请求。

### 酷狗（kugou）

| 能力 | 实现 |
| --- | --- |
| 搜索 / 歌单 / 专辑 / 单曲详情 | 原生移动端 API（`mobilecdn.kugou.com` 等），海外实测可用 |
| 播放链接 | `kugouAuthService.getPlayUrl`（签名接口，登录态 appid 需与 QR 登录一致） |
| 歌词 | `@s4p/kugou-lrc`（KRC 逐词） |
| 登录 | QR 扫码（appid 1005） |

要点：酷狗播放链接必须走 `kugouAuthService`，不要回退 Meting 的酷狗 provider（其硬编码 appid 1014 与登录 token 不匹配）。

## 3. QQ 海外 IP 实测行为（香港服务器，2026-07/08）

| 行为 | 结果 |
| --- | --- |
| 明文 `musicu.fcg`（搜索/新版 vkey/UniformRuleCtrl） | 500001 风控 |
| 签名版 `musics.fcg` 搜索 | code 0 但返回空结果 |
| 签名版 vkey（匿名） | 104003 |
| 旧版 `client_search_cp` / `fcg_play_single_song` | 正常返回 |
| 旧版 vkey（GET，匿名） | 104003（API 可达） |
| 匿名 30 秒试听（`RS02` 文件类型） | 可用 |
| 登录后完整播放（非绿钻） | 仍 104003 → **海外完整播放要求绿钻/VIP** |
| 播放 CDN（`isure.stream.qqmusic.qq.com` 等，带有效 vkey） | 海外可直接拉取 |
| QQ QR 登录 | 海外可发起（ptqrshow 200） |
| 手机端（Android 平台，L-1124 客户端完整设备指纹 + authst） | vkey 仍 104003（已实测） |

结论：QQ 对海外 IP 的完整播放是平台级限制，免费歌也不例外；唯一技术解法是浏览器中继（成员浏览器在境内代为请求）或绿钻账号。

## 4. QQ JSONP 细节（浏览器中继的可行性基础）

- `musicu.fcg` 加 **`callback=`** 参数即返回 JSONP 包装（`cb({...})`）；`jsonpCallback=` 单独使用不触发包装。
- 旧版 `client_search_cp` 支持 JSONP（`format=jsonp`）。
- `fcg_play_single_song`、酷狗、网易云均不支持 JSONP；三平台均无 CORS 允许读取。
- `<script>` 标签加载 JSONP 会**自动携带该域名 cookie**（若中继者浏览器登录过 QQ 音乐），这是浏览器机制，无法关闭，属于中继功能的预期副作用。

## 5. 浏览器中继协议

事件（`packages/shared`）：

| 方向 | 事件 | 载荷 |
| --- | --- | --- |
| 客户端 → 服务端 | `relay:mode_changed` | `{ enabled: boolean }` |
| 服务端 → 客户端 | `music:relay_request` | `{ requestId: string; url: string }` |
| 客户端 → 服务端 | `music:relay_response` | `{ requestId: string; ok: boolean; data?: unknown; error?: string }` |

服务端（`musicRelayService.ts`）：

- 仅接受白名单前缀 `https://u.y.qq.com/cgi-bin/musicu.fcg?` 的 URL（服务端自行构造，客户端不能指定任意地址）。
- 单请求超时 10 秒；同一客户端同一时间只处理一个请求；每次调用每个客户端只尝试一次，最多尝试 3 个客户端；断线时清理待处理请求。
- 客户端校验 URL 前缀与 `callback` 名（`^[A-Za-z0-9_]+$`），然后注入 `<script>` 执行 JSONP，把解析后的 JSON 原样回传。
- 中继 URL 使用旧版 `vkey.GetVkeyServer` GET 形态 + `callback=__vinylQqRelay_<随机>`，`uin=0`（匿名）；响应解析复用直连通道同一逻辑。
- 启用时机：仅当三条直连通道全部失败后；权限拒绝（104003/104013）时跳过 media_mid 恢复直接尝试中继。中继成功结果照常进匿名缓存；中继失败保持原分类提示。
- 服务端不保存、不读取中继者 cookie；中继者的浏览器登录态只影响其发出的那一次请求。

设置与隐私：

- 位于「设置 → 房间 → QQ 音乐 → 浏览器中继」，**默认关闭**，每次开启都需确认弹窗。
- 描述文案与确认弹窗文案以代码为准；核心提示：中继者 IP 会被 QQ 音乐看到、可能关联其账号、请求仅含歌曲 ID 与音质参数、关闭网页/退出房间/关闭开关即失效。
- 开发开关 `TENCENT_FORCE_RELAY`（接受 `1/0/true/false`）：本地调试时跳过直连强制先走中继；生产不要设置。

## 6. 测试与验证

- 服务端单测：`musicRelayService.test.ts`（白名单、成功回传、无客户端、超时、忙碌跳过、断线清理）。
- 集成测试：`musicProvider.tencentStream.test.ts`（直连成功不用中继、直连全失败才用、中继失败保持分类、强制开关、media_mid 恢复、搜索/专辑/歌单降级链）。
- 端到端（Playwright，本地强制模式）：建房间 → 开中继（确认弹窗）→ QQ 搜索免费歌 → 浏览器发出 `u.y.qq.com/...callback=__vinylQqRelay_...` → 服务端 `Tencent vkey ok (relay forced)` → 播放开始。
- 海外场景验证过的外部事实：香港 IP 直连全通道失败、境内浏览器 JSONP 可取 vkey、CDN 对海外可拉取。

### 哔哩哔哩（bilibili）

| 能力 | 实现 |
| --- | --- |
| 搜索 / 单曲详情 | 官方 Web 接口（`x/web-interface/search/type`、`x/web-interface/view`），无需登录 |
| 播放链接 | `x/player/playurl?fnval=16` 的 DASH 音频流，按房间音质选档；同时下发 `backupUrl` 供客户端兜底 |
| 歌词 / 封面 | 歌词留空；封面来自 hdslb.com 并统一为 https |

要点：

- 搜索必须先请求 `x/frontend/finger/spi` 拿 `buvid3/buvid4`，并携带 `origin/referer: search.bilibili.com`，否则接口返回风控错误。该指纹 cookie 进程内缓存，不涉及任何账号。实现参考 [MusicFree 插件 bilibili.js](https://github.com/qwerwhr/musicfree-plugins/blob/main/bilibili.js)。
- 搜索标题带 `<em>` 高亮标签，服务端统一清洗；时长可能为 `MM:SS` 字符串。
- `Track` 用 `bvid` 作为 `sourceId/urlId`，`bilibiliCid` 保留分 P cid；输入 av 号时经 view 接口解析后统一为 bvid。
- 播放主 CDN 在部分网络（如香港）可能 403，此时客户端自动切到 `fallbackStreamUrl`（backupUrl）。
- bilibili 不参与 netease ↔ tencent 自动换源，也不支持专辑/歌单搜索（前端在 B 站页签下隐藏专辑/歌单入口）。
