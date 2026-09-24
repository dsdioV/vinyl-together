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
| 登录后完整播放（非绿钻，含免费时长）                       | 仍 104003 → **海外完整播放要求绿钻/VIP** |
| 播放 CDN（`isure.stream.qqmusic.qq.com` 等，带有效 vkey）  | 海外可直接拉取                           |
| QQ QR 登录                                                 | 海外可发起（ptqrshow 200）               |
| 手机端（Android 平台，L-1124 客户端完整设备指纹 + authst） | vkey 仍 104003（已实测）                 |

结论：QQ 对海外 IP 的完整播放是平台级限制。**中继只能救免费歌**（提供境内出口 IP，但
不带登录态，见 §5）；**「境内 IP + 登录」才能播 VIP/地区受限曲**，海外服务器上等价于
**需要绿钻会员**（会员权益可越过地区限制）。

#### 播放判定的正确模型（2026-09-24 生产实测定稿）

**播放 = 权限（登录凭证）AND 地区（大陆出口 IP 或会员权益）**：

| 组合                                     | VIP / 地区受限曲                                   | 免费歌      |
| ---------------------------------------- | -------------------------------------------------- | ----------- |
| 未登录 + 海外直连                        | ❌ 匿名一律 `104003`                               | ❌          |
| 未登录 + **中继**（大陆出口，匿名）      | ❌ **救不了**（缺身份，中继带不上 cookie）         | ✅ **能救** |
| 免费时长 + 大陆 IP（直连，如本地开发机） | ✅ 可播（拿低档 `M500`/`C400`）                    | ✅          |
| 免费时长 + 海外直连                      | ❌ 地区被拒                                        | ❌          |
| **会员 + 海外直连**                      | ✅ **全档直通**（`vkey ok (plain)`，连中继都不用） | ✅          |

要点：

- **两类曲目的瓶颈不同**：**免费歌卡「地区」**（只需大陆 IP，连登录都不需要——中继即可解决）；
  **VIP / 地区受限曲卡「地区 + 身份」两者**（中继只能给地区、给不了身份，故无解）。
- **「免费时长」是有效凭证但会耗尽**，且**不能越过地区限制**；会员权益才能越过地区限制。
  因此**不要**把「免费时长 + 中继」当作 VIP 曲的解法：中继本身带不上凭证（见 §5）。
- **中继只提供大陆出口 IP，不携带登录态**——详见下方 §5 的更正说明。
- **`uin` 参数本身不是凭证**：境内用真实 `uin`（不带 cookie）请求仍是 `104003`，必须有 cookie。
- **档位降级是自动的，不需要额外「降档重试」**：`tencentFileCandidatesForBitrate(320)` 返回
  `[M800, C600, M500, C400]`，且 `filename` 是**数组**——**一次** vkey 请求就带上全部档位；
  服务端遍历响应的 `midurlinfo`，返回**第一个** `result === 0` 且有 purl 的档位。
  因此海外 IP 下这 4 档**全部** `104003` 说明是**整类被拒**，不是「高码率档被拒、降档即可」。
- 早期「非绿钻只能拿 128k 档」的观察本身**是对的**（大陆出口 + 非会员确实拿到 `M500`/`C400`），
  但由此推出「所以只要降档就一定可播」是错的——降档只在**上游对至少一个档位放行**时才有意义。

> **海外服务器的现实结论**：VIP / 地区受限曲在海外 IP 下**播不了**（中继无解，见 §5）。
> 实测**会员权益可越过地区限制**——vipType=1 时海外直连即全档直通。

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
- 中继 URL 使用旧版 `vkey.GetVkeyServer` GET 形态 + `callback=__vinylQqRelay_<随机>`，**请求里的 `uin` 参数固定为 `0`**。
- 启用时机：三条直连通道全部失败后都会尝试中继 —— **包括直连「超时」的情况**。超时往往正是服务器 IP 被风控/不可达的典型表现，因此超时不再提前返回（早期实现会在此 return，导致中继永远没有机会）。权限拒绝（104003/104013）时跳过 media_mid 恢复直接尝试中继。中继成功结果照常进匿名缓存；中继失败时，若直连仅以超时告负则保持 `timeout` 分类，否则保持原分类提示。
- **关联键是稳定身份（`identityUserId`），不是 `socketId`**：成员 socket 一旦重连（页面刷新、浏览器扩展导致的传输错误等）就会换 `socketId`。按 `socketId` 严格匹配会让重连前发出的请求其响应被静默丢弃——表现为「既没有成功日志也没有超时日志」的无声失败（生产曾实际发生）。现在断线**不立即丢弃** pending 请求，改由请求自身超时兜底；来自同一身份（含重连后的新 `socketId`）的响应会被采纳并记录日志。不同身份冒名回传、未知 `requestId`、重复回传都会被**明确记日志后拒绝**，不再静默。
- 服务端不保存、不读取中继者 cookie；中继者的浏览器登录态只影响其发出的那一次请求。

#### ⚠️ 中继是**匿名**的：它只提供大陆出口 IP，不带登录态（2026-09 实测更正）

> **本节更正一个此前写错的结论。** 早先版本称「中继会天然携带中继者的 QQ cookie」——**这是错的**，
> 且该错误曾导致一整轮无效排查。以下为生产实测结论。

**结论**：中继请求**不携带**登录 cookie。中继的唯一作用是**把出口 IP 换成中继者所在大陆网络**。

**实测依据（三重，均已复现）**：

| 证据           | 内容                                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| 生产服务器日志 | 生产站（HTTPS 域名）中继对 VIP 曲全程 `purlUin=absent`，四档全 `104003`                                          |
| 换浏览器无效   | Chrome 与 Firefox **表现相同**（都失败），排除浏览器差异/ETP                                                     |
| 只手动词才成功 | 把 relay URL 复制到地址栏打开（**顶层导航**）会带 cookie、返回带真实 uin 的 purl；App 自己的 `<script>` 请求不会 |

**机制（原理性，无客户端解）**：QQ 的登录 cookie 是 `SameSite=Lax`，而中继是**跨站子资源请求**：

| 需求                       | 顶层导航（手动打开 URL） | 跨站子资源（`<script>` / `fetch`） |
| -------------------------- | ------------------------ | ---------------------------------- |
| 携带 `SameSite=Lax` cookie | ✅                       | ❌ **不带**                        |
| 能读到响应内容             | ❌ 被同源策略拦          | ✅ 能读（JSONP）                   |

中继用 `<script>` **正是为了能读到响应**（JSONP 绕过同源策略），代价就是拿不到 Lax cookie。
两个条件**互斥、不可兼得**；`fetch`/`XHR` 是子资源且被 CORS 拦，更不可行。

**因此中继的能力边界**：

| 曲目                                 | 海外直连  | 中继（匿名）                                |
| ------------------------------------ | --------- | ------------------------------------------- |
| **免费歌**（`pay_play=0`，不需身份） | ❌ 常失败 | ✅ **能救**（只要大陆出口，连登录都不需要） |
| **VIP / 地区受限曲**                 | ❌        | ❌ **救不了**（需要身份，而中继带不上）     |

> **不要**再尝试让中继携带登录态（原理上不可行，见上表）。
> 若要让 VIP/地区受限曲在海外可播，需要在**服务端**提供境内出口——服务端是 HTTP 客户端，
> 不受 `SameSite` 约束。实测更简单的等效做法是使用**会员账号**（会员权益可越过地区限制）。

**调试中继时的方法论陷阱（务必遵守）**：**手动打开 relay URL ≠ App 的中继请求**。
前者是顶层导航会带 cookie、看起来「成功」；后者是跨站子资源、实际匿名。
**判断中继是否带登录态，只能看服务器日志**（`Tencent vkey ok (relay)` 表示中继确实取到了可用链接），
**绝不能用浏览器里手动 fetch 的抓包作为依据**。

#### 海外直连失败与「会员可播」的观测（勿据此推断「只有会员能播」）

生产日志时间线（同一账号、同一台海外服务器，均为**直连**）：

| 时间  | `vipType`                   | `004emQMs09Z1lz`（周杰伦版烟花易冷）   |
| ----- | --------------------------- | -------------------------------------- |
| 08:00 | `0`（非会员）               | ❌ 三通道全部 `104003`，多次重试均失败 |
| 08:04 | `0`（非会员）               | ❌ 同上；同期**其他**歌曲经中继可播    |
| 11:18 | **`1`（使用会员体验卡后）** | ✅ **`vkey ok (plain)` 直连成功**      |

`vipType` 由 `tencentAuthService` 从 QQ 的 `vip_login_base` 接口读取（`identity.svip ? 2 : identity.vip ? 1 : 0`），反映账号会员状态。

**但这不能推出「只有会员能播」**：用户在同一台境内家宽机器上实测，**免费时长 + 大陆 IP 可以播放该曲**。因此上表里 08:00/08:04 直连的失败，是**海外出口 IP** 导致的，而不是「免费时长没有权限」。会员之所以在海外能过，是因为会员权益可以越过该地区限制。

> **已排除的假设**：曾怀疑中继因走旧版接口（`vkey.GetVkeyServer`/`CgiGetVkey`）而拿不到同等档位。
> 匿名对照实测：现代 `UrlGetVkey` 与旧版 `CgiGetVkey` 对同一首歌**返回完全相同的各档 result 码**。
> **接口不是变量。**

> **真正的原因（已定论）**：中继**根本不携带登录态**（跨站 `<script>` 拿不到 `SameSite=Lax` cookie，见 §5）。
> 「中继救回两首免费歌、却救不回 VIP 曲」不是「应答者没登录」，而是**中继永远匿名**：
> 免费歌不需要身份所以能过，VIP 曲需要身份所以过不去。此前「谁在应答中继」的假设**已被否定**。

> **注意**：会员状态下中继**不会被触发**（直连即成功即 `return`）。生产实测 18 小时内
> 50 首 QQ 歌全部直连成功、中继零调用。因此中继只在**非会员**场景才有意义。

> 未验证的缺口：QQ 客户端的「免费听歌时长」如何映射到接口返回（是否体现在 `vip_login_base` 的某个字段），**未测**。

#### 中继失败时的诊断日志

`tryTencentRelay` 在「中继回传成功但拿不到可用 purl」时会输出：

```
Tencent relay returned no usable purl: <songMid> media=<mediaMid> relayedUin=… purlUin=present|absent results=[M800…mp3:104003 …]
```

- `purlUin=present|absent` —— **判断中继是否携带登录态的可靠指标**：真实身份出现在
  purl 里的 `uin=` 参数中。只输出 present/absent，**不记录任何 uin 值**。
- `relayedUin=…` —— 响应 `data.uin` 字段，**只反映请求参数回显**（中继发的是 `uin:'0'`），
  **不代表** cookie 身份，不要据此判断。
- `results=[...]` —— 每个档位的 `result` 码。**四档全 `104003` 是匿名应答的强特征**
  （匿名请求对任何档位都拿不到），是当前最实用的判据。
- 另有 `Tencent relay returned no data: …`（中继返回空）、`Tencent relay skipped: no idle client with relay enabled`。

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
