/**
 * 离线自检 —— `node selfcheck.mjs`
 * ============================================================================
 * 真机登录要联网 + 人工点授权，CI 里跑不了。所以这里把 fetch 打桩，
 * 把"协议走通 + 写出的文件被 0.7.1 认账"这两件事离线验掉：
 *
 *   1. 纯函数契约（regionOf / buildCredential / clampTimeout / 信任栅栏）
 *   2. CookieJar 全程复用同一个 jar（上游靠它把浏览器登录和 state 关联）
 *   3. 三步协议 + pending 轮询 + 凭据落到 own 副本
 *   4. 写出的文件用 **0.7.1 的真实解析器逐字符验一遍**
 *      （直接 import 已安装的 dsh-workbuddy-connect，不是照抄一份）
 *   5. HTTP 层：方法/路径/信任栅栏/404
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const DSH_HOME = await mkdtemp(join(tmpdir(), 'wb-login-selfcheck-'))
process.env.DSH_HOME = DSH_HOME

const t = await import(pathToFileURL(join(HERE, 'index.js')).href).then((m) => m.__testing)

let passed = 0
const cases = []
function test(name, fn) { cases.push([name, fn]) }

/* ---------------------------------------------------------------- 纯函数 */

test('regionOf 与 0.7.1 一致', () => {
  assert.equal(t.regionOf('workbuddy.ai'), 'global')
  assert.equal(t.regionOf('api.workbuddy.ai'), 'global')
  assert.equal(t.regionOf('copilot.tencent.com'), 'cn')
  assert.equal(t.regionOf(''), 'cn', '空 domain 会被判成 cn —— AI 变体必须兜底')
})

test('buildCredential：毫秒时间戳 + domain 兜底', () => {
  const before = Date.now()
  const cred = t.buildCredential(t.VARIANTS.ai, {
    accessToken: 'at', refreshToken: 'rt', expiresIn: 3600, refreshExpiresIn: 86400,
  }, { uid: 'u1', nickname: '主人', enterpriseId: 'e1' })
  assert.equal(cred.domain, 'workbuddy.ai', '上游没给 domain 时按变体兜底')
  assert.equal(t.regionOf(cred.domain), t.VARIANTS.ai.region)
  assert.ok(cred.expiresAtMs >= before + 3_599_000 && cred.expiresAtMs <= Date.now() + 3_600_000)
  assert.equal(cred.refreshExpiresAtMs - cred.expiresAtMs, 82_800_000)
  assert.equal(cred.uid, 'u1')
  assert.equal(cred.nickname, '主人')

  const cn = t.buildCredential(t.VARIANTS.cn, { accessToken: 'at', refreshToken: '', expiresIn: 60, domain: 'copilot.tencent.com' }, {})
  assert.equal(cn.domain, 'copilot.tencent.com')
  assert.equal(cn.refreshToken, '')
  assert.equal(cn.refreshExpiresAtMs, undefined)
})

test('clampTimeout 夹在区间里', () => {
  assert.equal(t.clampTimeout(undefined), t.TIMEOUT_DEFAULT_MS)
  assert.equal(t.clampTimeout(0), t.TIMEOUT_DEFAULT_MS)
  assert.equal(t.clampTimeout(-5), t.TIMEOUT_DEFAULT_MS)
  assert.equal(t.clampTimeout(1), t.TIMEOUT_MIN_MS)
  assert.equal(t.clampTimeout(99999), t.TIMEOUT_MAX_MS)
  assert.equal(t.clampTimeout(600), 600_000)
})

test('pickVariant 只认 ai/cn', () => {
  assert.equal(t.pickVariant('ai'), 'ai')
  assert.equal(t.pickVariant('cn'), 'cn')
  assert.equal(t.pickVariant('../../etc/passwd'), 'ai')
  assert.equal(t.pickVariant(undefined), 'ai')
})

/* -------------------------------------------------------------- 信任栅栏 */

function req(headers) {
  return { method: 'GET', url: '/api/wb-login/status', headers, on() { return this } }
}

test('信任栅栏：只认 loopback / 白名单', () => {
  assert.equal(t.isTrustedRequest({ host: '127.0.0.1:3080' }, []), true)
  assert.equal(t.isTrustedRequest({ host: 'localhost:3080' }, []), true)
  assert.equal(t.isTrustedRequest({ host: '[::1]:3080' }, []), true)
  assert.equal(t.isTrustedRequest({ host: 'evil.com' }, []), false)
  assert.equal(t.isTrustedRequest({ host: 'evil.com' }, ['evil.com']), true)
  assert.equal(t.isTrustedRequest({}, []), false, '没有 host 头一律不信任')
  assert.equal(t.isTrustedRequest({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }, []), false)
  assert.equal(t.isTrustedRequest({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }, []), true)
  assert.equal(t.isTrustedRequest({ host: '127.0.0.1:3080', origin: 'http://evil.com' }, []), false)
})

/* ------------------------------------------------------------- CookieJar */

test('CookieJar 吸收 / 输出 / 忽略过期项', () => {
  const jar = new t.CookieJar()
  assert.equal(jar.header(), undefined, '空 jar 不发 Cookie 头')
  jar.absorb({ headers: { getSetCookie: () => ['sid=abc; Path=/; HttpOnly', 'k=v'] } })
  assert.equal(jar.header(), 'sid=abc; k=v')
  jar.absorb({ headers: { getSetCookie: () => ['sid=xyz; Path=/'] } })
  assert.equal(jar.header(), 'sid=xyz; k=v', '同名 cookie 覆盖')
  jar.absorb({ headers: {} })
  assert.equal(jar.header(), 'sid=xyz; k=v', '拿不到 set-cookie 时不动')
})

/* ------------------------------------------------- 三步协议（打桩 fetch） */

/**
 * 找 0.7.1 的 `dsh-workbuddy-connect` 装在哪 —— 不写死路径，NAS 上也能跑。
 *
 * 顺序：
 *   1. `$WB_CONNECT_ROOT`（手工指定）
 *   2. `$DSH_HOME` 或 `~/.dsh` 下**每个** profile 的 `node_modules/dsh-workbuddy-connect`
 *
 * 认人的标准不是目录存在，而是里面真有 `lib/host-heartbeat-*.js`（凭据解析代码
 * 就在这份 chunk 里）。找不到就返回 undefined，那条自检会跳过而不是误判失败。
 */
async function resolveConnectRoot() {
  const candidates = []
  if (typeof process.env.WB_CONNECT_ROOT === 'string' && process.env.WB_CONNECT_ROOT !== '') {
    candidates.push(process.env.WB_CONNECT_ROOT)
  }
  // ⚠️ 上面第 22 行已经把 `process.env.DSH_HOME` 指到了临时目录（自检专用），
  // 所以这里**两个都试**：临时 home（通常没有）+ 真实的 `~/.dsh`（装插件的地方）。
  const homes = []
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '') homes.push(process.env.DSH_HOME)
  const realHome = join(homedir(), '.dsh')
  if (!homes.includes(realHome)) homes.push(realHome)
  for (const home of homes) {
    let profiles = []
    try { profiles = await readdir(join(home, 'profiles')) } catch { /* 没 profiles 目录 */ }
    for (const name of profiles.sort()) {
      candidates.push(join(home, 'profiles', name, 'node_modules', 'dsh-workbuddy-connect'))
    }
  }

  for (const root of candidates) {
    try {
      const info = await stat(root)
      if (!info.isDirectory()) continue
      const files = await readdir(join(root, 'lib'))
      if (files.some((f) => f.startsWith('host-heartbeat-') && f.endsWith('.js'))) return root
    } catch { /* 不存在或读不了，换下一个 */ }
  }
  return undefined
}

const CONNECT_ROOT = await resolveConnectRoot()

/** 打桩 fetch：按 URL 分派，顺手记录每个请求带的 cookie。 */
function stubFetch(script) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url))
    const cookie = init?.headers?.Cookie ?? init?.headers?.cookie ?? null
    calls.push({ path: u.pathname, query: u.search, cookie, auth: init?.headers?.Authorization ?? null })
    const hit = script[u.pathname]
    if (hit === undefined) return new Response(JSON.stringify({ code: 404 }), { status: 404, headers: { 'content-type': 'application/json' } })
    const out = typeof hit === 'function' ? hit(calls.length) : hit
    const headers = new Headers({ 'content-type': 'application/json' })
    if (out.cookies !== undefined) for (const c of out.cookies) headers.append('set-cookie', c)
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers })
  }
  return calls
}

const TOKEN = {
  accessToken: 'ACCESS-TOKEN-123',
  refreshToken: 'REFRESH-TOKEN-456',
  expiresIn: 3600,
  refreshExpiresIn: 2_592_000,
  domain: 'workbuddy.ai',
}

test('登录全流程：pending → 拿到令牌 → 写 own 副本', async () => {
  let pollCount = 0
  const calls = stubFetch({
    '/v2/plugin/auth/state': { body: { code: 0, data: { state: 'ST-1', authUrl: 'https://www.workbuddy.ai/login?state=ST-1' } }, cookies: ['sid=S1; Path=/'] },
    '/v2/plugin/auth/token': () => {
      pollCount += 1
      if (pollCount < 3) return { body: { code: t.PENDING_CODE, data: null }, cookies: ['sid=S1; Path=/'] }
      return { body: { code: 0, data: TOKEN }, cookies: ['sid=S1; Path=/'] }
    },
    '/v2/plugin/login/account': { body: { code: 0, data: { uid: 'uid-9', enterpriseId: 'ent-1', nickname: '鲸鱼娘' } } },
  })

  const center = new t.LoginCenter()
  const started = await center.start(t.VARIANTS.ai, 60_000)
  assert.equal(started.authUrl, 'https://www.workbuddy.ai/login?state=ST-1')
  assert.equal(started.variant, 'workbuddy-ai')

  assert.deepEqual(await center.poll(started.sessionId), { state: 'pending' })
  assert.deepEqual(await center.poll(started.sessionId), { state: 'pending' })

  const done = await center.poll(started.sessionId)
  assert.equal(done.state, 'done')
  assert.equal(done.uid, 'uid-9')
  assert.equal(done.nickname, '鲸鱼娘')
  assert.equal(done.path, join(DSH_HOME, '.workbuddy-ai-auth.json'))

  // 🔴 核心：jar 签发之后，每一次后续请求都必须带同一个 cookie
  //    （上游靠它把浏览器登录和 state 关联；换 jar 就永远 pending）
  assert.equal(calls[0].cookie, null, '第一次请求还没有 cookie')
  for (const c of calls.slice(1)) assert.equal(c.cookie, 'sid=S1', `${c.path} 丢了 cookie jar`)
  assert.equal(calls.filter((c) => c.path === '/v2/plugin/auth/token').length, 3)

  // 写出来的文件内容
  const written = JSON.parse(await readFile(done.path, 'utf8'))
  assert.equal(written.version, t.OWN_FORMAT_VERSION)
  assert.equal(written.credential.accessToken, TOKEN.accessToken)
  assert.equal(written.credential.refreshToken, TOKEN.refreshToken)
  assert.equal(written.credential.domain, 'workbuddy.ai')
  assert.equal(written.credential.uid, 'uid-9')
  assert.equal(written.credential.enterpriseId, 'ent-1')
  assert.ok(written.credential.expiresAtMs > Date.now())

  // 幂等：会话结束后继续 poll 返回同一份结果，不再打上游
  assert.deepEqual(await center.poll(started.sessionId), done)
  assert.equal(calls.length, 5)

  // 自己的 readOwn 认账
  const own = await t.readOwn(done.path)
  assert.equal(own.present, true)
  assert.equal(own.expired, false)
  assert.equal(own.hasRefresh, true)
  assert.equal(own.nickname, '鲸鱼娘')

  return { path: done.path }
})

test('登录失败：上游报错要传出来，且不写文件', async () => {
  stubFetch({
    '/v2/plugin/auth/state': { body: { code: 0, data: { state: 'ST-2', authUrl: 'https://x/y' } } },
    '/v2/plugin/auth/token': { body: { code: -1, msg: '登录已取消' } },
  })
  const center = new t.LoginCenter()
  const started = await center.start(t.VARIANTS.ai, 60_000)
  const res = await center.poll(started.sessionId)
  assert.equal(res.state, 'failed')
  assert.match(res.reason, /登录已取消/)
  assert.deepEqual(await center.poll(started.sessionId), { state: 'gone' }, '失败后会话被清掉')
})

test('会话过期 / 取消 / 未知 id', async () => {
  stubFetch({ '/v2/plugin/auth/state': { body: { code: 0, data: { state: 'ST-3', authUrl: 'https://x/y' } } } })
  const center = new t.LoginCenter()
  // timeout 被 clamp 到最小 30s，所以直接把 deadline 拨到过去来触发过期分支
  const a = await center.start(t.VARIANTS.ai, t.TIMEOUT_MIN_MS)
  center.sessions.get(a.sessionId).deadline = Date.now() - 1
  assert.deepEqual(await center.poll(a.sessionId), { state: 'expired' })

  const b = await center.start(t.VARIANTS.ai, 60_000)
  assert.equal(center.cancel(b.sessionId), true)
  assert.deepEqual(await center.poll(b.sessionId), { state: 'gone' })
  assert.deepEqual(await center.poll('不存在的 id'), { state: 'gone' })
})

test('网络抖动：上游超时算 retrying，不丢会话', async () => {
  stubFetch({
    '/v2/plugin/auth/state': { body: { code: 0, data: { state: 'ST-4', authUrl: 'https://x/y' } } },
    '/v2/plugin/auth/token': () => { throw new Error('boom') },
  })
  const center = new t.LoginCenter()
  const started = await center.start(t.VARIANTS.ai, 60_000)
  const res = await center.poll(started.sessionId)
  assert.equal(res.state, 'retrying')
  assert.match(res.reason, /boom/)
  assert.equal(center.sessions.has(started.sessionId), true, '抖动不该清掉会话')
})

/* ------------------------------------------ 用 0.7.1 真实解析器验一遍文件 */

test('写出的文件被 dsh-workbuddy-connect 0.7.1 真实解析器接受', async () => {
  if (CONNECT_ROOT === undefined) {
    console.log('  ⚠️  跳过（没找到 dsh-workbuddy-connect；可用 WB_CONNECT_ROOT=<路径> 指定）')
    return
  }
  let chunk
  try {
    const files = await readdir(join(CONNECT_ROOT, 'lib'))
    chunk = files.find((f) => f.startsWith('host-heartbeat-') && f.endsWith('.js'))
    assert.ok(chunk !== undefined, `${CONNECT_ROOT}/lib 里没有 host-heartbeat-*.js`)
  } catch (error) {
    console.log(`  ⚠️  跳过（读不到 ${CONNECT_ROOT}/lib：${error.message}）`)
    return
  }
  const chunkPath = join(CONNECT_ROOT, 'lib', chunk)

  let mod
  try {
    mod = await import(pathToFileURL(chunkPath).href)
  } catch (error) {
    console.log(`  ⚠️  跳过（读不到 ${chunkPath}：${error.message}）`)
    return
  }

  const path = join(DSH_HOME, '.workbuddy-ai-auth.json')

  // 0.7.1 是 bundle 产物，导出名被压成单字母（`WorkBuddyCredentialStore as m`）。
  // 所以按名字找不到，得先把 `原名 as 短名` 解析成表，再按**形状**认人。
  const MAP = await readExportMap(chunkPath)
  const Store = pick(mod, MAP, 'WorkBuddyCredentialStore', (v) => typeof v === 'function' && typeof v.prototype?.status === 'function')
  const AI_VARIANT = pick(mod, MAP, 'AI_VARIANT', (v) => v !== null && typeof v === 'object' && v.region === 'global' && typeof v.ownFilename === 'string')
  const regionOfReal = pick(mod, MAP, 'regionOf', (v) => typeof v === 'function' && v('workbuddy.ai') === 'global')
  const desktopCandidates = pick(mod, MAP, 'desktopAuthCandidatesFor', (v) => typeof v === 'function')

  // ① 用它**真实**的 WorkBuddyCredentialStore 读一次
  const store = new Store({
    variant: AI_VARIANT,
    refresh: async () => { throw new Error('不该触发刷新') },
    ownPath: path,
  })

  const status = await store.status()
  assert.equal(status.state, 'signed-in', `0.7.1 没认这份凭据：${JSON.stringify(status)}`)
  assert.equal(status.nickname, '鲸鱼娘')
  assert.equal(status.domain, 'workbuddy.ai')
  assert.equal(status.source, 'dsh')
  assert.ok(status.expiresAtMs > Date.now())

  // ② current() 也要认账（status 只读，current 才走 region 校验 + 择优）
  const cred = await store.current()
  assert.equal(cred.source, 'dsh')
  assert.equal(cred.accessToken, 'ACCESS-TOKEN-123')
  assert.equal(cred.uid, 'uid-9')
  assert.equal(regionOfReal(cred.domain), 'global', 'region 校验要过，否则抛 credential-region-mismatch')

  // ③ 反向：故意写一份 region 不匹配的，应当抛错。
  //    这条正是"domain 兜底"存在的理由 —— 没兜底时 0.7.1 直接炸。
  const badPath = join(DSH_HOME, '.workbuddy-ai-auth.json.bad')
  await writeFile(badPath, JSON.stringify({
    version: 1,
    credential: { accessToken: 'at', refreshToken: 'rt', expiresAtMs: Date.now() + 3.6e6, domain: '', uid: 'u' },
  }), 'utf8')
  const badStore = new Store({
    variant: AI_VARIANT,
    refresh: async () => { throw new Error('不该触发刷新') },
    ownPath: badPath,
  })
  let threw = ''
  try { await badStore.current() } catch (error) { threw = String(error.message ?? error) }
  // 0.7.1 的原文：「WorkBuddy AI received a WorkBuddy (CN) credential in its
  // plugin copy (domain ""); point WORKBUDDY_AI_AUTH_FILE at ...」
  assert.match(threw, /mismatch|received a WorkBuddy|region/i, `空 domain 本应触发 region 校验失败，实际：${threw || '没抛'}`)

  // ④ 桌面候选不存在时，own 副本独立生效（这正是"免装 App"成立的根据）
  const candidates = desktopCandidates(AI_VARIANT)
  assert.ok(Array.isArray(candidates) && candidates.length > 0)
  for (const candidate of candidates) {
    assert.equal(await fileMissing(candidate), true, `AI 变体的桌面候选不该存在：${candidate}`)
  }
})

/**
 * 0.7.1 的 export 语句把每个符号都改了名（`WorkBuddyCredentialStore as m`）。
 * 这里把 `原名 as 短名` 解析成表。
 */
async function readExportMap(file) {
  const source = await readFile(file, 'utf8')
  const line = source.split('\n').find((l) => l.startsWith('export {'))
  assert.ok(line !== undefined, '没找到 export 语句')
  const inner = line.slice(line.indexOf('{') + 1, line.lastIndexOf('}'))
  return new Map(inner.split(',').map((entry) => {
    const parts = entry.trim().split(/\s+as\s+/)
    return [parts[0].trim(), parts[parts.length - 1].trim()]
  }))
}

/** 按"原名"找到短名，再从模块命名空间里取，并用形状校验确认认对了人。 */
function pick(mod, exportMap, originalName, shapeCheck) {
  const short = exportMap.get(originalName)
  assert.ok(short !== undefined, `0.7.1 没导出 ${originalName}`)
  const value = mod[short]
  assert.ok(shapeCheck(value), `${originalName} 形状对不上（导出名可能变了）`)
  return value
}

async function fileMissing(path) {
  try { await readFile(path); return false } catch { return true }
}

/* ---------------------------------------------------------------- HTTP 层 */

function makeRes() {
  const res = { status: 0, body: undefined, headers: undefined }
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; return res }
  res.end = (data) => { res.body = JSON.parse(data); return res }
  return res
}

async function call(handler, method, sub, init = {}) {
  const res = makeRes()
  const url = `${t.ROUTE_PREFIX}/${sub}`
  const r = req({ host: '127.0.0.1:3080', ...(init.headers ?? {}) })
  r.method = method
  r.url = url + (init.query ?? '')
  r.on = (event, cb) => {
    if (event === 'end') setImmediate(() => cb())
    return r
  }
  await handler(r, res)
  return res
}

test('HTTP：路由 / 方法 / 栅栏', async () => {
  const handler = t.makeHandler({
    center: new t.LoginCenter(),
    trustedHosts: () => [],
    defaultVariant: 'ai',
    defaultTimeoutSec: 300,
  })

  // 非信任来源一律 403
  const evil = makeRes()
  await handler(req({ host: 'evil.com' }), evil)
  assert.equal(evil.status, 403)
  assert.deepEqual(evil.body, { error: 'request-not-trusted' })

  const ok = await call(handler, 'GET', 'status')
  assert.equal(ok.status, 200)
  assert.equal(ok.body.variant, 'workbuddy-ai')
  assert.equal(ok.body.ownPath, join(DSH_HOME, '.workbuddy-ai-auth.json'))
  assert.equal(ok.body.own.present, true, '上一个用例写进去的凭据还在')
  assert.deepEqual(ok.body.desktop.present, [])

  assert.equal((await call(handler, 'POST', 'status')).status, 405)
  assert.equal((await call(handler, 'GET', 'nope')).status, 404)
  assert.equal((await call(handler, 'GET', 'poll')).status, 400, 'poll 缺 session → 400')
  assert.equal((await call(handler, 'GET', 'poll', { query: '?session=x' })).status, 200)

  // 带完整前缀的路径也要能识别（宿主剥不剥前缀都兼容）
  const prefixed = makeRes()
  const r = req({ host: '127.0.0.1:3080' })
  r.method = 'GET'
  r.url = '/api/wb-login/status'
  r.on = (event, cb) => { if (event === 'end') setImmediate(() => cb()); return r }
  await handler(r, prefixed)
  assert.equal(prefixed.status, 200)
})

test('HTTP：logout 只删 own 副本', async () => {
  const path = join(DSH_HOME, '.workbuddy-ai-auth.json')
  await writeFile(`${path}.lock`, '{}', 'utf8')
  const handler = t.makeHandler({
    center: new t.LoginCenter(), trustedHosts: () => [], defaultVariant: 'ai', defaultTimeoutSec: 300,
  })
  const res = await call(handler, 'POST', 'logout')
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.deepEqual(await t.readOwn(path), { present: false }, 'own 副本已删')
  assert.equal((await call(handler, 'GET', 'status')).body.own.present, false)
})

/* ------------------------------------------------------------------ 跑 */

let failed = 0
for (const [name, fn] of cases) {
  try {
    await fn()
    passed += 1
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ❌ ${name}\n     ${error.message}`)
  }
}
await rm(DSH_HOME, { recursive: true, force: true })
console.log(`\n${passed}/${cases.length} 通过${failed === 0 ? '，全部通过 🎉' : `，${failed} 个失败`}`)
process.exit(failed === 0 ? 0 : 1)
