/**
 * dsh-workbuddy-weblogin —— 宿主半端（host half）
 * ============================================================================
 * 给 `dsh-workbuddy-connect` 补一个**网页登录**入口：**不用装 WorkBuddy 桌面 App**。
 *
 * 原理（对 0.7.1 源码取证后确认，不是猜测）：
 *   `WorkBuddyCredentialStore.current()` 择优两个凭据来源 —— 桌面 App 的
 *   `workbuddy-desktop[-ai].info` 与**插件自留副本** `$DSH_HOME/.workbuddy[-ai]-auth.json`。
 *   择优逻辑：desktop 为 undefined 就用 own；own 为 undefined 就用 desktop；
 *   都在时比 `expiresAtMs` 取大的。而对 AI variant 来说**桌面文件根本不存在**
 *   （两个候选都 absent，`readDesktop()` 走 ENOENT → continue → 返回 undefined），
 *   所以只要往 own 副本里写一份合法凭据，插件就正常工作。
 *
 *   ⚠️ 反过来：**桌面文件存在但不可解析会抛错**（它 outrank own 副本）。
 *      所以本插件的状态接口会把桌面文件的存在情况报出来，让用户自己判断。
 *
 * 登录协议（逆向自 zqcccc/workbuddy-cliproxy main.go L80-103 / L915-1068）：
 *   POST {base}/v2/plugin/auth/state?platform=CLI     body {}                 -> {state, authUrl}
 *   GET  {base}/v2/plugin/auth/token?state=<state>                            -> code 11217(pending) | code 0 + 令牌包
 *   GET  {base}/v2/plugin/login/account?state=<state> + Bearer                -> {uid, enterpriseId, nickname}
 *   🔴 **全程必须复用同一个 cookie jar**：上游把浏览器登录与 state 关联，
 *      换 jar 就永远 pending（cliproxy main.go L260-261 明确要求）。
 *
 * 写完凭据后 `dsh-workbuddy-connect` 自己会续期（`POST /v2/plugin/auth/token/refresh`
 * + `X-Refresh-Token` 头，刷新后写回 own 副本），所以它也会**接管刷新**——
 * 本插件只负责"签发第一张票"，之后不用再登录。
 *
 * 零运行时依赖。Node >= 18（global fetch + AbortSignal.timeout）。
 * ============================================================================
 */

import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'

/* ================================ 常量 ================================ */

/** 路由前缀（宿主 webServer 的 prefix 路由）。 */
const ROUTE_PREFIX = '/api/wb-login'

/** 上游 pending 业务码。 */
const PENDING_CODE = 11217
/** 冒充 WorkBuddy CLI 的 UA（与上游协议一致）。 */
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'
/** 单次上游请求超时。 */
const UPSTREAM_TIMEOUT_MS = 15_000
/** 登录等待时限的可选范围。 */
const TIMEOUT_MIN_MS = 30_000
const TIMEOUT_MAX_MS = 1_800_000
const TIMEOUT_DEFAULT_MS = 300_000
/** 内存里最多同时留多少个登录会话（防手滑刷爆）。 */
const MAX_SESSIONS = 8

/**
 * 两个变体，字段与 0.7.1 的 `WORKBUDDY_VARIANTS` 对齐
 * （`lib/host-heartbeat-L93zSVB5.js:1552-1607`）。
 *
 * `fallbackDomain`：上游不返回 domain 时用它兜底 —— **不能留空**：0.7.1 的
 * `current()` 会校验 `regionOf(domain)` 与 variant.region 一致，不一致直接抛
 * `credential-region-mismatch`，而 `regionOf('')` 是 `'cn'`（AI variant 会炸）。
 */
const VARIANTS = {
  ai: {
    id: 'workbuddy-ai',
    region: 'global',
    label: 'WorkBuddy AI',
    base: 'https://www.workbuddy.ai',
    origin: 'https://www.workbuddy.ai',
    ownFilename: '.workbuddy-ai-auth.json',
    desktopFilename: 'workbuddy-desktop-ai.info',
    fallbackDomain: 'workbuddy.ai',
  },
  cn: {
    id: 'workbuddy',
    region: 'cn',
    label: 'WorkBuddy（国内）',
    base: 'https://copilot.tencent.com',
    origin: 'https://www.codebuddy.cn',
    ownFilename: '.workbuddy-auth.json',
    desktopFilename: 'workbuddy-desktop.info',
    fallbackDomain: '',
  },
}

/** own 副本格式版本（0.7.1 的 `OWN_FORMAT_VERSION`）。文件版本不对会被整个丢弃。 */
const OWN_FORMAT_VERSION = 1

/* ============================ 路径与区域判定 ============================ */

/**
 * DSH home：与 0.7.1 用的 `resolveDshHome()` 语义一致（`$DSH_HOME` > `~/.dsh`）。
 * 优先走宿主的 `@deepseek-ai/dsh-home-paths`，拿不到就自己算 —— 两条路结果相同。
 */
async function dshHome() {
  try {
    const mod = await import('@deepseek-ai/dsh-home-paths')
    if (typeof mod.resolveDshHome === 'function') return mod.resolveDshHome()
  } catch { /* 宿主没把包暴露给插件，走下面的等价实现 */ }
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(expandHome(fromEnv.trim()))
  return join(homedir(), '.dsh')
}

function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/** 与 0.7.1 的 `regionOf` 逐字一致（`host-heartbeat-L93zSVB5.js:687`）。 */
function regionOf(domain) {
  const lowered = String(domain ?? '').trim().toLowerCase()
  if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) return 'global'
  return 'cn'
}

/** own 副本路径：`join(resolveDshHome(), variant.ownFilename)`（:2632）。 */
async function ownPathFor(variant) {
  return join(await dshHome(), variant.ownFilename)
}

/** 桌面凭据文件的平台默认候选（:2485 / :2515）。只用于状态展示，从不解析。 */
function desktopCandidatesFor(variant) {
  const home = homedir()
  const dirs = process.platform === 'win32'
    ? [join(home, 'AppData', 'Local'), join(home, 'AppData', 'Roaming')]
    : process.platform === 'darwin'
      ? [join(home, 'Library', 'Application Support')]
      : [join(home, '.config'), join(home, '.local', 'share')]
  const rel = ['CodeBuddyExtension', 'Data', 'Public', 'auth']
  return dirs.map((d) => join(d, ...rel, variant.desktopFilename))
}

/* ============================== cookie jar ============================== */

/**
 * 最小 cookie jar。上游把浏览器登录与 auth/state 签发的 state 关联，
 * 所以**同一个 jar 必须跟着每一次轮询**，否则永远 pending。
 */
class CookieJar {
  constructor() {
    this.map = new Map()
  }

  absorb(response) {
    const raw = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
    for (const line of raw) {
      const pair = line.split(';')[0]
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (value === '' || /expires=/i.test(value)) continue
      this.map.set(name, value)
    }
  }

  header() {
    if (this.map.size === 0) return undefined
    return [...this.map].map(([k, v]) => `${k}=${v}`).join('; ')
  }
}

/* ============================== 凭据读写 ============================== */

/**
 * 读 own 副本并返回摘要；与 0.7.1 的 `parseOwnDocument`（:2578）同款校验。
 * 任何一处不合法都当作"没有凭据"（上游也是这么处理的）。
 */
async function readOwn(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return { present: false }
  }
  let document
  try {
    document = JSON.parse(text)
  } catch {
    return { present: false, malformed: true }
  }
  if (document === null || typeof document !== 'object') return { present: false, malformed: true }
  if (document.version !== OWN_FORMAT_VERSION) return { present: false, malformed: true, version: document.version }
  const credential = document.credential
  if (credential === null || typeof credential !== 'object') return { present: false, malformed: true }
  if (typeof credential.accessToken !== 'string' || credential.accessToken === '') return { present: false, malformed: true }
  const expiresAtMs = typeof credential.expiresAtMs === 'number' ? credential.expiresAtMs : 0
  const out = {
    present: true,
    expiresAtMs,
    expired: expiresAtMs > 0 && expiresAtMs <= Date.now(),
    hasRefresh: typeof credential.refreshToken === 'string' && credential.refreshToken !== '',
    domain: typeof credential.domain === 'string' ? credential.domain : '',
    uid: typeof credential.uid === 'string' ? credential.uid : '',
  }
  if (typeof credential.refreshExpiresAtMs === 'number') out.refreshExpiresAtMs = credential.refreshExpiresAtMs
  if (typeof credential.nickname === 'string' && credential.nickname !== '') out.nickname = credential.nickname
  if (typeof credential.enterpriseId === 'string' && credential.enterpriseId !== '') out.enterpriseId = credential.enterpriseId
  return out
}

/** 原子写：写临时文件再 rename，尽量 chmod 0600（Windows 上会静默失败）。 */
async function writeOwnAtomic(path, credential) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  const body = `${JSON.stringify({ version: OWN_FORMAT_VERSION, credential }, null, 2)}\n`
  await writeFile(tmp, body, 'utf8')
  try {
    await chmod(tmp, 0o600)
  } catch { /* Windows 没有 0600，无所谓 */ }
  await rename(tmp, path)
}

/* ============================== 登录中心 ============================== */

/**
 * 管理"进行中"的登录会话。会话**只在内存里**：宿主重启就丢，
 * 但已经写进 own 副本的凭据不会丢，所以这只影响"登录到一半"的窗口。
 */
class LoginCenter {
  constructor() {
    /** @type {Map<string, object>} */
    this.sessions = new Map()
    this.seq = 0
  }

  /** 丢掉过期会话，并给新会话腾位置。 */
  gc() {
    const now = Date.now()
    for (const [id, session] of this.sessions) {
      if (session.done || now > session.deadline + 60_000) this.sessions.delete(id)
    }
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next()
      if (oldest.done) break
      this.sessions.delete(oldest.value)
    }
  }

  /**
   * 第一步：向上游要一个登录 state，拿到给浏览器用的 authUrl。
   * @returns {Promise<{sessionId: string, authUrl: string, state: string, variant: string, expiresAtMs: number}>}
   */
  async start(variant, timeoutMs) {
    this.gc()
    const jar = new CookieJar()
    const res = await fetch(`${variant.base}/v2/plugin/auth/state?platform=CLI`, {
      method: 'POST',
      headers: this.#headers(variant, jar),
      body: '{}',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    jar.absorb(res)
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body?.code !== 0 || typeof body?.data?.state !== 'string' || typeof body?.data?.authUrl !== 'string') {
      throw new Error(`登录入口申请失败：${describeUpstream(body) || `HTTP ${res.status}`}`)
    }
    const now = Date.now()
    const id = `wb-login-${now}-${(this.seq += 1)}`
    this.sessions.set(id, {
      id,
      variant,
      jar,
      state: body.data.state,
      authUrl: body.data.authUrl,
      deadline: now + timeoutMs,
      createdAtMs: now,
      done: undefined,
    })
    return { sessionId: id, authUrl: body.data.authUrl, state: body.data.state, variant: variant.id, expiresAtMs: now + timeoutMs }
  }

  /**
   * 第二步（可反复调用）：问上游浏览器那边签完了没有。
   * 只做**一次**请求，节奏交给前端（每 2-3 秒一次），这样取消和超时都可控。
   */
  async poll(sessionId) {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return { state: 'gone' }
    if (session.done !== undefined) return session.done
    if (Date.now() > session.deadline) {
      this.sessions.delete(sessionId)
      return { state: 'expired' }
    }

    let res
    try {
      res = await fetch(`${session.variant.base}/v2/plugin/auth/token?state=${encodeURIComponent(session.state)}`, {
        method: 'GET',
        headers: this.#headers(session.variant, session.jar),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      })
    } catch (error) {
      return { state: 'retrying', reason: safeMessage(error) }
    }
    session.jar.absorb(res)
    const body = await res.json().catch(() => ({}))
    if (body?.code === PENDING_CODE) return { state: 'pending' }
    if (body?.code !== 0 || typeof body?.data?.accessToken !== 'string' || body.data.accessToken === '') {
      this.sessions.delete(sessionId)
      return { state: 'failed', reason: describeUpstream(body) || `HTTP ${res.status}` }
    }

    const account = await this.#fetchAccount(session, body.data.accessToken)
    const credential = buildCredential(session.variant, body.data, account)
    const path = await ownPathFor(session.variant)
    await writeOwnAtomic(path, credential)
    const result = {
      state: 'done',
      path,
      variant: session.variant.id,
      uid: credential.uid,
      domain: credential.domain,
      ...(credential.nickname === undefined ? {} : { nickname: credential.nickname }),
      expiresAtMs: credential.expiresAtMs,
    }
    session.done = result
    return result
  }

  cancel(sessionId) {
    return this.sessions.delete(sessionId)
  }

  /** 第三步：拿身份信息（纯装饰，拿不到也不影响凭据可用）。 */
  async #fetchAccount(session, accessToken) {
    try {
      const res = await fetch(`${session.variant.base}/v2/plugin/login/account?state=${encodeURIComponent(session.state)}`, {
        method: 'GET',
        headers: {
          ...this.#headers(session.variant, session.jar),
          Authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      })
      const body = await res.json().catch(() => ({}))
      if (body?.code === 0 && body.data !== null && typeof body.data === 'object') return body.data
    } catch { /* 装饰性 */ }
    return {}
  }

  #headers(variant, jar) {
    const cookie = jar.header()
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': variant.origin,
      'Referer': `${variant.origin}/`,
      'User-Agent': CLIENT_UA,
      ...(cookie === undefined ? {} : { Cookie: cookie }),
    }
  }
}

/** 上游业务体的错误文案（照 0.7.1 的 `extractDisplayErrorMessage` 思路取 msg 优先）。 */
function describeUpstream(body) {
  if (body === null || typeof body !== 'object') return undefined
  const data = body.data
  const candidates = [body.msg, body.message, data?.msg, data?.message]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return undefined
}

/**
 * 把上游令牌包整理成 own 副本的 `credential` 形状（毫秒时间戳）。
 *
 * 🔴 domain 兜底：空 domain 会让 AI variant 在 0.7.1 里触发
 *    `credential-region-mismatch`（`regionOf('') === 'cn'`），所以按变体补。
 */
function buildCredential(variant, data, account) {
  const now = Date.now()
  const rawDomain = typeof data.domain === 'string' ? data.domain.trim() : ''
  const domain = rawDomain !== '' ? rawDomain : variant.fallbackDomain
  const credential = {
    accessToken: data.accessToken,
    refreshToken: typeof data.refreshToken === 'string' ? data.refreshToken : '',
    expiresAtMs: now + Number(data.expiresIn ?? 0) * 1000,
    domain,
    uid: typeof account.uid === 'string' ? account.uid : '',
  }
  if (data.refreshExpiresIn !== undefined && Number(data.refreshExpiresIn) > 0) {
    credential.refreshExpiresAtMs = now + Number(data.refreshExpiresIn) * 1000
  }
  if (typeof account.enterpriseId === 'string' && account.enterpriseId !== '') credential.enterpriseId = account.enterpriseId
  if (typeof account.nickname === 'string' && account.nickname !== '') credential.nickname = account.nickname
  return credential
}

/* ============================ HTTP 工具与信任栅栏 ============================ */
/* 与 @deepseek-ai/dsh-client-connection 的 /api 同款栅栏（DNS-rebinding + 跨站）。
 * 宿主不会替我们自己注册的路由做这层检查 —— 必须自己再过一遍。 */

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255)
    && parts[0] === '127'
}

function parseAuthority(authority) {
  try { return new URL(`http://${authority}`) } catch { return undefined }
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return entryUrl.port === ''
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

function isTrustedRequest(headers, trustedHosts) {
  const host = headers.host
  if (typeof host !== 'string') return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const origin = headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) })
  res.end(data)
}

function readJsonBody(req) {
  return new Promise((done) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1_000_000) req.destroy()
    })
    req.on('end', () => { try { done(JSON.parse(data || '{}')) } catch { done({}) } })
    req.on('error', () => done({}))
  })
}

function safeMessage(error) {
  return error instanceof Error ? error.message.slice(0, 300) : String(error)
}

/* ================================== 路由 ================================== */

async function filePresent(path) {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

function makeHandler(deps) {
  const { center, trustedHosts, defaultVariant, defaultTimeoutSec } = deps

  /** 读当前凭据状态（`?variant=ai|cn`，默认 ai）。 */
  const status = async (variantKey) => {
    const variant = VARIANTS[variantKey] ?? VARIANTS.ai
    const ownPath = await ownPathFor(variant)
    const own = await readOwn(ownPath)
    const candidates = desktopCandidatesFor(variant)
    const desktopPresent = []
    for (const path of candidates) {
      if (await filePresent(path)) desktopPresent.push(path)
    }
    return {
      variant: variant.id,
      region: variant.region,
      label: variant.label,
      base: variant.base,
      dshHome: await dshHome(),
      ownPath,
      own,
      desktop: {
        // 存在即会 outrank own 副本；对 AI 变体通常是空的（没装桌面 App）。
        present: desktopPresent,
        outranks: desktopPresent.length > 0,
      },
    }
  }

  return async (req, res) => {
    if (!isTrustedRequest(req.headers, trustedHosts())) {
      sendJson(res, 403, { error: 'request-not-trusted' })
      return
    }

    let pathname
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      sendJson(res, 400, { error: 'bad request' })
      return
    }
    // 宿主可能给完整路径，也可能已经剥掉前缀 —— 两种都兼容。
    const sub = (pathname.startsWith(ROUTE_PREFIX) ? pathname.slice(ROUTE_PREFIX.length) : pathname)
      .replace(/^\/+|\/+$/g, '')

    try {
      if (sub === 'status') {
        if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return }
        const variant = pickVariant(new URL(req.url ?? '/', 'http://localhost').searchParams.get('variant') ?? defaultVariant)
        sendJson(res, 200, await status(variant))
        return
      }

      if (sub === 'start') {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return }
        const body = await readJsonBody(req)
        const variant = VARIANTS[pickVariant(body.variant ?? defaultVariant)]
        const timeoutMs = clampTimeout(body.timeoutSec ?? defaultTimeoutSec)
        sendJson(res, 200, await center.start(variant, timeoutMs))
        return
      }

      if (sub === 'poll') {
        if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return }
        const sessionId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('session')
        if (typeof sessionId !== 'string' || sessionId === '') {
          sendJson(res, 400, { error: 'missing session' })
          return
        }
        sendJson(res, 200, await center.poll(sessionId))
        return
      }

      if (sub === 'cancel') {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return }
        const body = await readJsonBody(req)
        sendJson(res, 200, { cancelled: center.cancel(String(body.session ?? '')) })
        return
      }

      if (sub === 'logout') {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return }
        const body = await readJsonBody(req)
        const variant = VARIANTS[pickVariant(body.variant ?? defaultVariant)]
        const ownPath = await ownPathFor(variant)
        // 只删 own 副本，与 0.7.1 的 `logout()` 一致；桌面文件绝不动。
        await rm(ownPath, { force: true })
        await rm(`${ownPath}.lock`, { force: true })
        sendJson(res, 200, { ok: true, removed: ownPath })
        return
      }

      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      sendJson(res, 500, { error: safeMessage(error) })
    }
  }
}

function pickVariant(raw) {
  if (typeof raw === 'string' && (raw === 'ai' || raw === 'cn')) return raw
  return 'ai'
}

function clampTimeout(rawSec) {
  const ms = Number(rawSec) * 1000
  if (!Number.isFinite(ms) || ms <= 0) return TIMEOUT_DEFAULT_MS
  return Math.min(TIMEOUT_MAX_MS, Math.max(TIMEOUT_MIN_MS, ms))
}

/* =========================== 离线自检（供脚本调用） =========================== */
/* 真机验证要联网登录，跑不动；这些纯函数导出出来给 selfcheck 打桩断言。 */

export const __testing = {
  ROUTE_PREFIX,
  VARIANTS,
  OWN_FORMAT_VERSION,
  PENDING_CODE,
  TIMEOUT_MIN_MS,
  TIMEOUT_MAX_MS,
  TIMEOUT_DEFAULT_MS,
  regionOf,
  describeUpstream,
  buildCredential,
  isTrustedRequest,
  clampTimeout,
  pickVariant,
  normalizeVariant,
  desktopCandidatesFor,
  makeHandler,
  LoginCenter,
  CookieJar,
  writeOwnAtomic,
  readOwn,
  ownPathFor,
  dshHome,
}

/* ================================== 装配 ================================== */

export const name = 'dsh-workbuddy-weblogin'

/**
 * 插件配置。宿主没喂 schemastery 时**不导出 Config**（cordis 容忍 undefined，
 * 但也就不会帮我们填默认值 ⇒ 下面自己兜）。
 */
let z = null
try { z = (await import('@deepseek-ai/schemastery')).default ?? null } catch { /* 没喂就不导出 */ }

const DEFAULT_VARIANT = 'ai'
const DEFAULT_TIMEOUT_SEC = 300

/**
 * @param {string} raw - 用户填的变体；非法值一律回落默认，绝不把脏值写进路径。
 */
function normalizeVariant(raw) {
  return raw === 'ai' || raw === 'cn' ? raw : DEFAULT_VARIANT
}

export const Config = z ? z.object({
  variant: z.string().default(DEFAULT_VARIANT),
  timeoutSec: z.number().default(DEFAULT_TIMEOUT_SEC),
}) : undefined

/**
 * @param {any} ctx - 宿主插件上下文。
 * @param {any} rawConfig - 宿主填好的配置（拿不到 Config 时可能是 undefined）。
 */
export function apply(ctx, rawConfig) {
  const config = rawConfig ?? {}
  const defaultVariant = normalizeVariant(config.variant)
  const defaultTimeoutSec = Number.isFinite(Number(config.timeoutSec)) && Number(config.timeoutSec) > 0
    ? Number(config.timeoutSec)
    : DEFAULT_TIMEOUT_SEC

  const center = new LoginCenter()
  // 运行期信任列表（--trusted-host 等）；拿不到就是空数组，等价于"只认 loopback"。
  const trustedHosts = () => {
    const runtime = ctx.get('webRuntime')
    return runtime !== undefined && Array.isArray(runtime.trustedHosts) ? runtime.trustedHosts : []
  }

  // 前端不传 variant 时用配置的默认值。
  const handler = makeHandler({ center, trustedHosts, defaultVariant, defaultTimeoutSec })

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const dispose = webCtx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler,
      })
      return () => { dispose() }
    }, 'dsh-workbuddy-weblogin: /api/wb-login 路由')
  })

  ctx.effect(() => () => { center.sessions.clear() }, 'dsh-workbuddy-weblogin: 清理登录会话')
}
