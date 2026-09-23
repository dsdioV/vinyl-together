# 音源与播放链接（music-sources.md）

> 记录五个音源平台（网易云 / QQ 音乐 / 酷狗 / 哔哩哔哩 / bandcamp）的接入方式、降级链、海外部署行为和浏览器中继协议。修改任何平台相关代码前先读本文。

## 1. 总体结构

- 服务端统一入口：`packages/server/src/services/musicProvider.ts` 的 `MusicProvider`。
- 统一类型：`packages/shared` 的 `Track`（`sourceId`、`urlId`、`lyricId`、`picId`、`mediaMid`、`vip` 等）。
- 三级缓存：Track 注册表（元数据）→ 引用索引（id 列表）→ 资源缓存（播放链接/封面/歌词）。
- 客户端 `Track` 往返保留 `mediaMid`（QQ 播放链接拼接所需，服务端 schema 放行）。

## 2. 平台能力与降级链

### 网易云（netease）

| 能力                   | 实现                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| 搜索 / 歌单 / 单曲详情 | `@neteasecloudmusicapienhanced/api`（进程内嵌入）                                                           |
| 播放链接               | `song_url_v1` + `realIP`（按房间音质降级 lossless/exhigh/standard）→ 无 IP 兜底 → `song_url_match` 解灰兜底 |
| 匿名 cookie            | `register_anonimous`，进程内缓存                                                                            |
| 歌词                   | `lyric_new`（LRC/翻译/罗马音/YRC 逐词）                                                                     |

要点：启动时 `neteaseApiBootstrap` 生成 xeapi 公钥与匿名 token。

#### 海外 IP 的关键：`realIP`（2026-09 实测）

香港生产 IP 下 `song_url_v1` 对几乎所有歌曲返回 `entry.code=404`（**API 层按 IP 拒绝，不是版权**），实测 10 首仅 1 首成功。该库官方支持的 `realIP` 参数会把它写成真实的 `X-Real-IP` / `X-Forwarded-For` 头（`util/request.js:204-210`），让上游按大陆 IP 判权：

| 配置                                 | 香港实测结果                                                 |
| ------------------------------------ | ------------------------------------------------------------ |
| 不传 IP（baseline）                  | 10 首仅 1 首成功；失败 45–46 s                               |
| `realIP='<大陆 IP>'`                 | **10/10 成功，单曲 ≈200–1072 ms**；`fetch Range` 均 HTTP 206 |
| `realIP='8.8.8.8'` / 香港本机        | 头已正确发出，**仍 404**                                     |
| `randomCNIP` / `ENABLE_RANDOM_CN_IP` | **完全无效**：出站请求里根本没有 `X-Real-IP` 头              |

- 起作用的是**「大陆 IP 身份」**，不是「多带了一个头」（反向对照：境外 IP 带了头依然 404）。
- `randomCNIP` 无效的代码根因：它只被 `server.js:310-321` 的 Express 层消费（读 `global.cnIp`）；本项目嵌入式入口 `main.js` 直接调 `util/request.js`，后者只认 `options.realIP || options.ip`。
- **实验方法警告**：同一进程内先调一次 `realIP` 后，后续不带 `realIP` 的 baseline 也会返回 200（上游短时会话态）。因此**结论必须用独立进程复现**，同进程轮询得出的因果不可信。
- 兜底顺序（`getNeteaseStreamUrlResult`）：`realIP` → 无 IP → 解灰。带用户 cookie 时跳过「无 IP」重复轮。
- **超时必须共享总预算**（`TimeBudget`，8 s）：`song_url_match` 与 `unblock:'true'` 走的是第三方「解灰」服务，实测 promise **永不 settle**。此前每层各等 15 s，叠加成 **45,593 ms**（2×plain 0.5 s + `song_url_match` 15,007 ms + 2×unblock 各 15,015 ms），这就是「房间卡死」的根因。解灰通道另有 6 s 总预算 / 3 s 单步上限。
- `song_url_match` 仍保留为最后兜底（降级链不可删），但**它不是香港的实际兜底**——它在香港整体挂死，真正让服务恢复可用的是 `realIP`。

### QQ 音乐（tencent）— 重点

| 能力     | 降级链（高 → 低）                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------- |
| 单曲搜索 | 明文 `musicu.fcg` Desktop 搜索 → 签名版 `musics.fcg`（zzc）→ 旧版 `client_search_cp`（海外可用）                          |
| 专辑搜索 | Desktop 搜索（search_type=2）→ 综合搜索 `music.adaptor.SearchAdaptor` / `do_search_v2` 的 `item_album`（海外可用）        |
| 歌单搜索 | Desktop 搜索（search_type=3）→ 综合搜索 `item_songlist`（海外可用）                                                       |
| 单曲详情 | 明文 `music.trackInfo.UniformRuleCtrl` → 签名版同模块 → 旧版 `fcg_play_single_song`（海外可用）                           |
| 播放链接 | 明文 `music.vkey.GetVkey` / `UrlGetVkey` → 签名版同模块 → 旧版 `vkey.GetVkeyServer` / `CgiGetVkey`（GET）→ **浏览器中继** |
| 登录     | QR 扫码（ptlogin2 + OAuth + musickey），cookie 存房间                                                                     |

细节：

- 旧版 `vkey.GetVkeyServer` 在境内可能返回空（本仓库实测），但它是海外唯一可到达的直连通道（API 可达、匿名 104003）。
- 旧版 `music.trackInfo.UniformRuleClass` 已被风控（500003），一律使用 `UniformRuleCtrl`。
- `media_mid` 与歌曲 mid 常常不同；解析播放链接优先用注册表携带的 `mediaMid`，失败时经单曲详情恢复后重试一次。
- 匿名可播放档位最高 128kbps（`M500`）；更高档位与 VIP 歌曲需要登录 cookie。
- 失败分类：`104003/104013` → 无 cookie 报 `login_required`，有 cookie 报 `vip_or_copyright`；其余为 `upstream_failed`；超时单独分类。
- 权限拒绝（104003/104013）与 media_mid 无关，跳过详情恢复，直接进入中继/分类，避免多余请求。

#### QQ VIP 标识的判定（`Track.vip`）

`vip` 只影响搜索/歌单里的「VIP」角标与失败提示文案，不决定能否播放。判定必须以**单曲目录属性**为准，不能依赖 `pay` 段：

- **不能用的字段**：`pay_month`（月度会员）、`pay_down`（付费下载）、`price_track`（单曲售价）只描述购买/下载权利。大量可免费完整播放的歌同样带这些值（例：《烟火》`pay_month=1, pay_down=1, price_track=200`）。用它做 OR 判断会把免费歌误标为 VIP（5682 首境内样本误报 1603 首，精确率仅 0.64）。
- **能用但不完整**：`pay_play=1` 语义正确（= 播放需要权限），但它随请求地区变化。香港服务器会把它连同整个 `pay` 段置 0。
- **采用**：`action.icons` 位掩码的 bit1（值 `2`，客户端 VIP/付费角标位），随目录属性下发。5682 首境内样本对照 `pay_play` 仅误报 1、漏报 11；5587 首「香港视图 + 境内标注」联合样本误报 1、漏报 10（同数据旧规则误报 647、漏报 1874）。
- 实现见 `musicProvider.ts` 的 `tencentSongNeedsVip()`：`icons & 2` 为主判据，`pay_play === 1` 仅在响应缺 `action` 时兜底。搜索与单曲详情两条映射路径共用该函数，避免此前两处 OR 链不一致。
- **已知边界（2026-09 实测，勿轻易"优化"）**：有一类 VIP 歌境内 `icons = 0x1400000`（bit22|bit24）不含 bit1；到香港视图被改写成 `0x1080000`（bit19|bit24）。而另一类**真正免费**的歌境内为 `0x1000000`（仅 bit24），在香港视图中**退化成一模一样的值**——两者的 icons/msgpay/msgid/alert/switch/pay/size_try/status 逐一相同，已用匿名 vkey 交叉验证（前者 BLOCK、后者 PLAY）。即香港视图下这两类**不可区分**，任何规则只能二选一：漏报该 VIP 类，或把对应的免费歌误标 VIP。当前**刻意不加 `bit24`**，优先避免重新引入用户报告过的"免费歌被标 VIP"，代价是香港视图漏报该 VIP 类（约占 VIP 的 0.4%，靠播放失败提示兜底）；境内不受影响（该类 `pay_play=1`，兜底捕获）。测试 `documents the Hong Kong blind spot` 锁住此决策。
- 注意 `registerTracks` 的合并策略是 `existing.vip || meta.vip`（只增不减），Registry TTL 内旧值不会自动纠正；改判定规则后需等 TTL（2h）或重启进程才完全生效。

### 酷狗（kugou）

| 能力                          | 实现                                                                     |
| ----------------------------- | ------------------------------------------------------------------------ |
| 搜索 / 歌单 / 专辑 / 单曲详情 | 原生移动端 API（`mobilecdn.kugou.com` 等），海外实测可用                 |
| 播放链接                      | `kugouAuthService.getPlayUrl`（签名接口，登录态 appid 需与 QR 登录一致） |
| 歌词                          | `@s4p/kugou-lrc`（KRC 逐词）                                             |
| 登录                          | QR 扫码（appid 1005）                                                    |

要点：酷狗播放链接必须走 `kugouAuthService`，不要回退 Meting 的酷狗 provider（其硬编码 appid 1014 与登录 token 不匹配）。

## 3. QQ 海外 IP 实测行为（香港服务器，2026-07/08）

| 行为                                                       | 结果                                     |
| ---------------------------------------------------------- | ---------------------------------------- |
| 明文 `musicu.fcg`（搜索/新版 vkey/UniformRuleCtrl）        | 500001 风控                              |
| 签名版 `musics.fcg` 搜索                                   | code 0 但返回空结果                      |
| 签名版 vkey（匿名）                                        | 104003                                   |
| 旧版 `client_search_cp` / `fcg_play_single_song`           | 正常返回                                 |
| 旧版 vkey（GET，匿名）                                     | 104003（API 可达）                       |
| 匿名 30 秒试听（`RS02` 文件类型）                          | 可用                                     |
| 登录后完整播放（非绿钻）                                   | 仍 104003 → **海外完整播放要求绿钻/VIP** |
| 播放 CDN（`isure.stream.qqmusic.qq.com` 等，带有效 vkey）  | 海外可直接拉取                           |
| QQ QR 登录                                                 | 海外可发起（ptqrshow 200）               |
| 手机端（Android 平台，L-1124 客户端完整设备指纹 + authst） | vkey 仍 104003（已实测）                 |

结论：QQ 对海外 IP 的完整播放是平台级限制。**中继（= 借用境内出口 IP）或境内 IP + 登录**是可行解法。

#### 两个必要条件的模型（2026-09 实测修正）

先前「付费歌只看会员身份」的结论**是错的**。用抓包时间戳可以严格判定：那份包含有效 purl 的抓包发生在 **07:09**，而该账号的会员生效时间是 **11:17** —— 即抓包时账号仍是**非会员（免费时长）状态，却拿到了 `M500`/`C400` 的 `result:0` 与有效 vkey**。因此：

**播放 = 需要登录凭证（cookie） AND 需要大陆出口 IP**，两者都是必要条件，缺一不可：

| 组合                       | 结果 | 说明                                  |
| -------------------------- | ---- | ------------------------------------- |
| 未登录 + 大陆 IP           | ❌   | 匿名一律 104003（`uin` 参数不是凭证） |
| **免费时长 + 大陆 IP**     | ✅   | 实测可播（用户本地 + 抓包均为该组合） |
| 免费时长 + 香港 IP（直连） | ❌   | 香港出口被按地区拒（104003）          |
| 会员 + 香港 IP（直连）     | ✅   | 会员档位可越过该地区限制              |

- **免费时长是有效凭证**，足以拿到部分档位；会员只是把可取的档位上限抬高（并能让香港直连通过）。因此「免费时长 + 中继（大陆出口）」在理论上**应当可播**，是可行的免费路径。
- 「未登录 → 不能播」与「免费时长 + 本机 IP → 能播」这两条用户实测，正是上表的第 1、2 行。
- **中继同时提供「大陆出口 IP」与「中继者的登录态」**（见 §5「中继携带登录态」）。要让免费时长用户经中继播放，需要：① 中继者的浏览器已登录 QQ 音乐（携带凭证）；② 中继确实被尝试。
- **`uin` 参数本身不是凭证**：境内用真实 `uin`（不带 cookie）请求仍是 `104003`，必须有 cookie。
- 早期「非绿钻只能拿 128k 档、320k 被拒 → 所以低档一定可播」的推理方向对，但**当时被我错误地整体否定了**；正确表述是：该账号**确实**拿到了低档，而项目的请求路径按房间音质（默认 320k）发起，若该档被地区拒则需要**降档重试**才能真正用上低档——这正是待修的点（见下）。

> **待修（中继已尝试但仍失败）**：生产日志显示烟花易冷失败时，中继在同一 ±5s 窗口内**确实发出了 3 次请求**（不是没试）。因此失败发生在中继**之后**的某个环节，而不是「中继未被调用」。后续需逐段打点确认是响应解析、档位匹配还是降档逻辑。

> 中继的代价（已在设置中告知）：请求经由中继者浏览器发出，QQ 能看到中继者的 IP 并关联其账号。中继者关闭网页/退出房间/关闭开关即失效。

## 4. QQ JSONP 细节（浏览器中继的可行性基础）

- `musicu.fcg` 加 **`callback=`** 参数即返回 JSONP 包装（`cb({...})`）；`jsonpCallback=` 单独使用不触发包装。
- 旧版 `client_search_cp` 支持 JSONP（`format=jsonp`）。
- `fcg_play_single_song`、酷狗、网易云均不支持 JSONP；三平台均无 CORS 允许读取。
- `<script>` 标签加载 JSONP 会**自动携带该域名 cookie**（若中继者浏览器登录过 QQ 音乐），这是浏览器机制，无法关闭，属于中继功能的预期副作用。

## 5. 浏览器中继协议

事件（`packages/shared`）：

| 方向            | 事件                   | 载荷                                                                 |
| --------------- | ---------------------- | -------------------------------------------------------------------- |
| 客户端 → 服务端 | `relay:mode_changed`   | `{ enabled: boolean }`                                               |
| 服务端 → 客户端 | `music:relay_request`  | `{ requestId: string; url: string }`                                 |
| 客户端 → 服务端 | `music:relay_response` | `{ requestId: string; ok: boolean; data?: unknown; error?: string }` |

服务端（`musicRelayService.ts`）：

- 仅接受白名单前缀 `https://u.y.qq.com/cgi-bin/musicu.fcg?` 的 URL（服务端自行构造，客户端不能指定任意地址）。
- 单请求超时 10 秒；同一客户端同一时间只处理一个请求；每次调用每个客户端只尝试一次，最多尝试 3 个客户端。
- 客户端校验 URL 前缀与 `callback` 名（`^[A-Za-z0-9_]+$`），然后注入 `<script>` 执行 JSONP，把解析后的 JSON 原样回传。
- 中继 URL 使用旧版 `vkey.GetVkeyServer` GET 形态 + `callback=__vinylQqRelay_<随机>`，**请求里的 `uin` 参数固定为 `0`，但这不代表请求是匿名的**（见下）。
- 启用时机：三条直连通道全部失败后都会尝试中继 —— **包括直连「超时」的情况**。超时往往正是服务器 IP 被风控/不可达的典型表现，因此超时不再提前返回（早期实现会在此 return，导致中继永远没有机会）。权限拒绝（104003/104013）时跳过 media_mid 恢复直接尝试中继。中继成功结果照常进匿名缓存；中继失败时，若直连仅以超时告负则保持 `timeout` 分类，否则保持原分类提示。
- **关联键是稳定身份（`identityUserId`），不是 `socketId`**：成员 socket 一旦重连（页面刷新、浏览器扩展导致的传输错误等）就会换 `socketId`。按 `socketId` 严格匹配会让重连前发出的请求其响应被静默丢弃——表现为「既没有成功日志也没有超时日志」的无声失败（生产曾实际发生）。现在断线**不立即丢弃** pending 请求，改由请求自身超时兜底；来自同一身份（含重连后的新 `socketId`）的响应会被采纳并记录日志。不同身份冒名回传、未知 `requestId`、重复回传都会被**明确记日志后拒绝**，不再静默。
- 服务端不保存、不读取中继者 cookie；中继者的浏览器登录态只影响其发出的那一次请求。

#### 中继携带登录态（2026-09 实测，勿按「匿名」理解）

浏览器抓包（成员在本机登录 QQ 音乐网页版 + 开启中继）显示：

- **请求**里 `uin` 参数固定为 `0`，看起来是匿名；
- **响应**里 purl 却带**该成员的真实账号 uin**，且 `msg` 字段是**该成员所在网络的出口 IP**（均为运行时值，此处不记录）。

即 QQ 按**浏览器 cookie** 判身份，与请求参数 `uin` 无关（`uin` 参数本身不是凭证：用真实 `uin` 但不带 cookie 请求 VIP 歌仍是 104003，已实测）。因此中继确实在借用**中继者的登录态 + 中继者所在网络的出口 IP**，`<script>` 跨站请求并未被 `SameSite` 拦下。

#### 香港直连失败与「会员可播」的观测（勿据此推断「只有会员能播」）

生产日志时间线（同一账号、同一台香港服务器，均为**直连**）：

| 时间  | `vipType`                   | `004emQMs09Z1lz`（周杰伦版烟花易冷）   |
| ----- | --------------------------- | -------------------------------------- |
| 08:00 | `0`（非会员）               | ❌ 三通道全部 `104003`，多次重试均失败 |
| 08:04 | `0`（非会员）               | ❌ 同上；同期**其他**歌曲经中继可播    |
| 11:18 | **`1`（使用会员体验卡后）** | ✅ **`vkey ok (plain)` 直连成功**      |

`vipType` 由 `tencentAuthService` 从 QQ 的 `vip_login_base` 接口读取（`identity.svip ? 2 : identity.vip ? 1 : 0`），反映账号会员状态。

**但这不能推出「只有会员能播」**：用户在同一台机器上的对照实验显示，**免费时长 + 本机（大陆）IP 也能播放**该曲。因此上表里 08:00/08:04 的失败，是**香港出口 IP** 导致的，而不是「免费时长没有权限」。会员之所以在香港能过，是因为会员档位可以越过该地区限制。

> 未验证的缺口：QQ 客户端的「免费听歌时长」如何映射到接口返回（是否体现在 `vip_login_base` 的某个字段），**未测**。目前只知道它**足以让大陆出口 + 中继链路拿到该曲的低档位**。

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

| 能力        | 实现                                                                                                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 搜索        | 官方 Web 接口 `x/web-interface/search/type`（`search_type=video`），无需登录，但需 buvid 指纹 cookie                                                                             |
| 单曲详情    | `x/player/pagelist` 取 cid（主来源）+ `x/web-interface/view` 取标题/封面/时长/UP 主（可选元数据，失败即降级）                                                                    |     |
| 播放链接    | `x/player/playurl?fnval=16` 的 DASH 音频流，按房间音质选档；音频经服务端代理 `/api/music/bilibili/stream` 拉流（带 bilibili Referer、支持 Range，主 CDN 403 时自动切 backupUrl） |
| 歌词 / 封面 | 歌词留空；封面来自 hdslb.com 并统一为 https                                                                                                                                      |

要点：

- 搜索必须先请求 `x/frontend/finger/spi` 拿 `buvid3/buvid4`，并携带 `origin/referer: search.bilibili.com`，否则接口返回风控错误。该指纹 cookie 进程内缓存，不涉及任何账号。实现参考 [MusicFree 插件 bilibili.js](https://github.com/qwerwhr/musicfree-plugins/blob/main/bilibili.js)。
- 搜索标题带 `<em>` 高亮标签，服务端统一清洗；时长可能为 `MM:SS` 字符串。
- `Track` 用 `bvid` 作为 `sourceId/urlId`，`bilibiliCid` 保留分 P cid；输入 av 号时经 view 接口解析后统一为 bvid。
- **cid 主来源是 `x/player/pagelist`，不是 `x/web-interface/view`**：`view` 对海外 IP（实测香港服务器）返回 **HTTP 412 反爬 HTML**，旧实现直接 `res.json()` 会抛 `Unexpected token '<'`，导致 `无法获取 bilibili 视频 cid` 而整首歌不可播；`pagelist` 在同一 IP 下实测 200 且含 cid。所有 bilibili Web 接口的 JSON 解析统一先判 `res.ok` / `content-type`，非 JSON 一律降级为 `null`，不得抛异常、不得阻断播放链接解析。
- `view` 不可用时只降级为标题/封面/时长缺失：入参是 bvid 就用入参作 `sourceId`，av 号则归一化为 `avN`，**播放链接仍能解析**。播放时若注册表没有 cid（冷启动直查、仅凭 `urlId` 播放），会再走一次 `pagelist` 兜底。
- 浏览器媒体请求无法携带 bilibili 的 Referer，CDN 会 403，因此音频统一走服务端代理；主 CDN 在部分网络（如香港）403 时由代理自动切换 backupUrl。
- 封面（hdslb.com）不支持跨域，AMLL 背景图会经 `/api/music/cover-proxy` 加载。- bilibili 不参与 netease ↔ tencent 自动换源，也不支持专辑/歌单搜索（前端在 B 站页签下隐藏专辑/歌单入口）。

### bandcamp

| 能力            | 实现                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| 搜索 / 专辑搜索 | Web 端 `bcsearch_public_api/1/autocomplete_elastic`（匿名 POST，`search_filter: 't'/'a'` 精确过滤类型；不带 filter 的混合结果对泛关键词可能不含曲目条目）          |
| 单曲/专辑详情   | 抓 `{artist}.bandcamp.com/track                                                                                                                                    | album/{slug}`页面，解析`data-tralbum` JSON 属性（单曲页 = 只含 1 条 trackinfo 的特例，同一解析器） |
| 播放链接        | 播放时实时抓曲目页提取 `trackinfo.file["mp3-128"]`（带时效 token）；**不写 streamUrlCache**（token 短命）                                                          |
| 封面            | 由 `art_id` 构造 `https://f4.bcbits.com/img/a{art_id}_10.jpg`（**必须带 `a` 前缀**；搜索接口返回的 img 字段是失效旧格式）。CDN 无 CORS 头，AMLL 背景走 cover-proxy |
| 歌词            | 部分专辑内嵌在 tralbum trackinfo 的 `lyrics` 字段，尽力提取、缺省为空                                                                                              |

要点：

- **无登录、无歌单概念**：与 bilibili 同属"无登录早退"模式（`getLyric`/`getCover`/`batchResolveCover`/`fetchFullPlaylist(playlist)` 早退；前端隐藏歌单页签，但**保留专辑页签**）。
- **反爬（Client Challenge，F5/Shape 类 JS 挑战）**：专拦"自称浏览器但指纹不符"的请求。必须用固定非浏览器 UA（`BANDCAMP_UA`）；挑战页特征为 `_fs-ch-` 标记 / `Client Challenge` 标题 / 403/503，识别后分类 `upstream_failed`（detail「Bandcamp 反爬拦截」）。**此通道可能随 Bandcamp 收紧失效**，与 QQ 降级链同属需持续维护的灰色通道（yt-dlp 2026-08 起也在持续应对）。
- **ID 设计**：`sourceId = String(track_id)`（数字 ID，去重键）；`urlId = 单曲页 URL`，专辑展开的曲目无独立链接时回退「专辑页URL#trackId」形态，流解析按 `#` 后的 track id 定位。`getTrackById` 接受 URL 形态入参（粘贴链接导入），纯数字 ID 仅注册表命中。
- **音频下发：直连优先 + 代理兜底**：`streamUrl` 直接给 `t4.bcbits.com` 直链（无 Referer 校验，大陆实测可达，省服务器带宽）；同时下发 `fallbackStreamUrl = /api/music/bandcamp/stream?id=...`，客户端直连失败时自动切换，代理每次进入重新解析 token 自愈过期。
- bandcamp 不参与 netease ↔ tencent 自动换源（`RoomAutoFallbackEvent` Exclude），不支持歌单搜索（前端隐藏歌单页签）。
- 搜索结果**不含时长**（列表显示 `--:--`），专辑详情展开后有真实时长；播放开始后进度条以 howl 实测时长为准。

## 7. 封面下发：一律同源代理

**所有第三方封面都经 `/api/music/cover-proxy` 同源下发**（客户端 `getTrackCoverUrl` →
`buildProxiedCoverUrl`，URL 拼装在 shared 内并被单测覆盖）。本地音频封面是服务端签发的
相对路径，本身同源，不走代理。

为什么必须代理，而不是让浏览器直连 CDN：

1. **Firefox 的「增强型跟踪保护」(ETP) 会把第三方 CDN 当跟踪器拦截**，表现为封面空白、
   控制台报 `NS_ERROR_TRACKING_URI`。同源请求不受影响。Chrome 及 Firefox 隐私窗口
   （ETP 更严或更宽）表现可能不同，容易误判为「某些封面坏了」。
2. **bilibili 封面 CDN 有防盗链**：非 bilibili Referer 直连会 403。
3. 顺带统一了上游白名单、内容类型与体积上限（`sanitizeCoverProxyUrl` /
   `readCoverResponse`）。

要点：

- 允许的封面域名由 `packages/shared/src/coverUrl.ts` 的 `TRACK_COVER_HOSTS` 决定
  （netease `p1..p4.music.126.net`、tencent `y.gtimg.cn`、kugou `imge/imgessl.kugou.com`、
  bilibili `i0..i2.hdslb.com`、bandcamp `f4.bcbits.com`）。代理只接受这些域名，
  不是开放图片代理。
- **内容类型必须放行 `image/jpg`**：实测网易云 `p*.music.126.net` 用该非标准写法上报
  JPEG；只认 `image/jpeg` 会让网易云封面整类 **415**（已在生产复现并修复）。
- 代理响应带 `Cache-Control: public, max-age=86400`，24 小时缓存；上限 5 MiB、按流式读取
  截断，避免超大图打满内存。
- 客户端 `AudioPlayer` 曾自带一份 `PROXY_COVER_HOSTS` 白名单，已删除——两份列表必然漂移，
  现在只有一处。
