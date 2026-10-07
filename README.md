# dsh-workbuddy-weblogin

给 [`dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect) 补一个**网页端登录**入口 —— **不用安装 WorkBuddy 桌面 App**。

## 为什么这样可行（对 0.7.1 源码取证，不是猜测）

`dsh-workbuddy-connect` 的 `WorkBuddyCredentialStore` 读**两个**凭据来源：

| 来源 | 路径 |
| --- | --- |
| 桌面 App | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop[-ai].info` |
| **插件自留副本** | `$DSH_HOME/.workbuddy[-ai]-auth.json` |

择优逻辑（`host-heartbeat-L93zSVB5.js:2665`）：

- desktop 为 `undefined` → 用 own
- own 为 `undefined` → 用 desktop
- 都在 → 比 `expiresAtMs`，取大的

而 **AI 变体的桌面候选默认根本不存在**（`workbuddy-desktop-ai.info` 没被桌面 App 写出来），`readDesktop()` 走 ENOENT → `continue` → 返回 `undefined`。所以只要往 own 副本里写一份合法凭据，插件就正常工作。

写完凭据后，`dsh-workbuddy-connect` **自己会续期**（`POST /v2/plugin/auth/token/refresh` + `X-Refresh-Token` 头，刷新后写回 own 副本）。本插件只负责"签发第一张票"。

⚠️ 反过来要注意：**桌面文件存在但不可解析会抛错**，因为它 outrank own 副本。所以状态接口会把桌面文件的存在情况报出来。

## 登录协议

逆向自 [zqcccc/workbuddy-cliproxy](https://github.com/zqcccc/workbuddy-cliproxy)（`main.go` L80-103 / L915-1068）：

```
POST {base}/v2/plugin/auth/state?platform=CLI   body {}          -> {code:0, data:{state, authUrl}}
GET  {base}/v2/plugin/auth/token?state=<state>                  -> code 11217 (pending) | code 0 + 令牌包
GET  {base}/v2/plugin/login/account?state=<state> + Bearer      -> {uid, enterpriseId, nickname}
```

🔴 **全程必须复用同一个 cookie jar** —— 上游靠 cookie 把浏览器登录和签发的 `state` 关联，换 jar 就永远 pending。

| 变体 | base / origin | own 副本 |
| --- | --- | --- |
| `ai`（国际，默认） | `https://www.workbuddy.ai` | `$DSH_HOME/.workbuddy-ai-auth.json` |
| `cn`（国内） | `https://copilot.tencent.com` / `https://www.codebuddy.cn` | `$DSH_HOME/.workbuddy-auth.json` |

## 安装

```bash
# 本地路径（本机开发）
dsh plugin --profile web add /path/to/dsh-workbuddy-weblogin

# 从 GitHub（NAS / 另一台机器）
git clone https://github.com/tanging22/dsh-workbuddy-weblogin /volume1/dsh/plugins/dsh-workbuddy-weblogin
dsh plugin --profile web add /volume1/dsh/plugins/dsh-workbuddy-weblogin

# 若核心版本校验拦下：
dsh plugin --profile web allow-version dsh-workbuddy-weblogin
```

> `dsh plugin add <github url>` 直接装 git spec 也行，但私有仓库要给 pnpm 备好凭据，
> 而且装完是 pnpm 的 git checkout、不是工作副本。先 `git clone` 再按本地路径装更好排查。

装完后重启宿主，在**设置 → WorkBuddy 登录** 页面里点「开始登录」。页面顶部两个按钮切换国际版 / 国内版。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `variant` | `ai` | `ai` \| `cn` |
| `timeoutSec` | `300` | 等授权的时限，夹在 30…1800 秒 |

## HTTP API（供脚本调用）

所有接口都要过 loopback / 受信任 host 栅栏。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/wb-login/status?variant=ai` | 当前凭据状态（不刷新、不抛错） |
| POST | `/api/wb-login/start` | `{variant?, timeoutSec?}` → `{sessionId, authUrl, state, expiresAtMs}` |
| GET | `/api/wb-login/poll?session=<id>` | `{state: pending\|retrying\|done\|failed\|expired\|gone}` |
| POST | `/api/wb-login/cancel` | `{session}` → `{cancelled}` |
| POST | `/api/wb-login/logout` | `{variant?}` → 删 own 副本（**不动桌面文件**） |

`start` → 浏览器打开 `authUrl` 登录 → 前端每 2.5s `poll` 一次，直到 `done`。

## 自检

```bash
npm test   # = node --import ./selfcheck/loader.mjs selfcheck.mjs
```

13 条断言，全部离线（打桩 `fetch`）。最要紧的一条是：把写出的凭据文件交给 **0.7.1 真实的 `WorkBuddyCredentialStore`** 去读，确认 `status()` 返回 `signed-in`、`current()` 过 region 校验。为此用了一个 ESM loader，把 `@deepseek-ai/dsh-atomic-write` 与 `@deepseek-ai/dsh-home-paths` 两个裸依赖重定向到本地桩（web profile 的 `node_modules` 里没有这两个包）—— **凭据解析链一行没改**。

## 与其它方案的区别

社区已有 masknull 的 fork 把登录做进了插件本体。本插件选择**不动** `dsh-workbuddy-connect`：

- 不 shadow 它的 `plugins.bundle.config` key（本插件只注册自己的设置页，id = 包名）
- 不改它的 `cordis.patch.yml` 节点（`llm-workbuddy`）
- 只往它会读的那份文件里写凭据

这样上游升级不会冲突，两边各自独立。

## 搬到 NAS / Linux 上跑

路径本身**不会出问题**——代码里没有一个写死的绝对路径（唯一一处曾写死在 `selfcheck.mjs` 里，已改成动态查找）。但有三件事要主人自己确认：

### 1. 信任栅栏：远程访问会被 403

本插件自己注册的路由**必须自己过信任检查**（宿主不会代办），`isTrustedRequest()` 只放行：

- loopback（`127.x.x.x` / `localhost` / `[::1]`）
- `ctx.webRuntime.trustedHosts` 里的 authority

而 `trustedHosts` 的来源是 `resolveLanTrust()`（`packages/bundle/web-app/src/index.ts:125`）：

```ts
// 只有 bind 到 0.0.0.0 时，才会把本机所有非内部 IPv4 自动加进白名单
const lanAddresses = bindHost === ALL_INTERFACES_HOST ? <本机 LAN IPv4> : []
return { lanAddresses, trustedHosts: [...lanAddresses, ...extra] }
```

所以：

| 访问方式 | 要不要额外配置 |
| --- | --- |
| `http://192.168.1.5:3080`（IP） | 不用——bind 到 `0.0.0.0` 时 LAN IP 自动进白名单（**port-less，端口任意**） |
| `http://nas.local:3080`（主机名） | **要** `--trusted-host nas.local` |
| 反代后的域名 | **要** `--trusted-host <域名>` |

```bash
dsh web --profile web --host 0.0.0.0 --trusted-host nas.local --no-open
```

⚠️ `--trusted-host` 的值必须是**裸 authority**（`host` 或 `host:port`），带路径会被拒：
`client-connection: trustedHosts entry "nas.local/path" is not a bare host[:port] authority`（`packages/client/connection/src/api-request-trust.ts:52`）。

> 顺带一提：NAS 上建议加 `--no-open`——`dsh web` 默认会尝试开浏览器，只有检测到 SSH 登录时才自动放弃（`packages/bundle/web-app/src/index.ts:229`）。

### 2. 登录在**你的电脑**上点，凭据落在**NAS** 上

这正是搬到 NAS 反而更方便的地方：cookie jar 和轮询都在 NAS 进程里（内存），主人只要把页面里那个 `authUrl` **复制到自己电脑的浏览器**里登录就行 —— 上游靠 `state` 关联，跟谁点的浏览器无关。UI 里特意做了「复制」按钮而不是自动弹窗，就是为这个场景准备的。

### 3. `DSH_HOME` 必须前后一致

凭据写进 `$DSH_HOME/.workbuddy[-ai]-auth.json`，而 `dsh-workbuddy-connect` 读的是**同一个** `resolveDshHome()`（`$DSH_HOME` > `~/.dsh`）。只要两者跑在同一个环境里就不会错；如果登录时和 `dsh-workbuddy-connect` 启动时 `DSH_HOME` 不一样，就会出现「显示已登录但插件说没登录」。

### Linux 上的额外好处

桌面凭据候选在 Linux 是 `~/.config` / `~/.local/share` 下的 `CodeBuddyExtension/Data/Public/auth/workbuddy-desktop[-ai].info`——NAS 上基本不存在，所以 `readDesktop()` 走 ENOENT 返回 `undefined`，**own 副本独立生效，不会被 outrank**。这比在 Windows 上（装了桌面 App 时）更干净。

### 安装：建议把插件放到 NAS 本地路径

`dsh plugin add <路径>` 用的是 `link:` 协议，要求插件目录**原地不动**。别 link 到 Windows 的 UNC 共享路径（`\\NAS\...`），建议先把插件目录拷进 NAS 的稳定路径再装：

```bash
git clone https://github.com/tanging22/dsh-workbuddy-weblogin /volume1/dsh/plugins/dsh-workbuddy-weblogin
dsh plugin --profile web add /volume1/dsh/plugins/dsh-workbuddy-weblogin
```

装完跑一次自检（在 NAS 上也能跑，13 条里有几条会因为找不到 `dsh-workbuddy-connect` 自动跳过）：

```bash
cd /volume1/dsh/plugins/dsh-workbuddy-weblogin && npm test
```

## 已知边界

- 登录会话只存在内存里（宿主重启就丢），但**已写入的凭据不丢**。
- CN 变体在 Windows 上桌面文件通常存在，会 outrank own 副本；本插件会在 UI 里提示。
- 若上游改了协议字段（比如 pending 码），`PENDING_CODE` 需要跟着改。
- 自检里那条「用 0.7.1 真实解析器验文件」依赖本机装着 `dsh-workbuddy-connect`。找不到会自动跳过（不算失败）；可用 `WB_CONNECT_ROOT=<路径>` 指定。
