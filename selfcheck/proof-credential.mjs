/**
 * 端到端证明：本插件写出的凭据文件，dsh-workbuddy-connect 0.7.1 能不能读到。
 *
 * 这不是模拟 —— 真的 import 0.7.1 的 host-heartbeat chunk，
 * 真的 new WorkBuddyCredentialStore，真的 current() 过 region 校验。
 *
 *   node selfcheck/proof-credential.mjs            # 只读，不落文件
 *   node selfcheck/proof-credential.mjs --write    # 真的写一份临时凭据再读
 */

import { mkdtemp, readdir, rm, stat, writeFile, readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const WRITE = process.argv.includes('--write')

/* ---------- 找 0.7.1 装在哪（与 selfcheck.mjs 同一套逻辑） ---------- */

async function resolveConnectRoot() {
  const candidates = []
  if (process.env.WB_CONNECT_ROOT) candidates.push(process.env.WB_CONNECT_ROOT)
  const homes = [join(homedir(), '.dsh')]
  for (const home of homes) {
    let profiles = []
    try { profiles = await readdir(join(home, 'profiles')) } catch { /* 没有 */ }
    for (const name of profiles.sort()) {
      candidates.push(join(home, 'profiles', name, 'node_modules', 'dsh-workbuddy-connect'))
    }
  }
  for (const dir of candidates) {
    try {
      if (!(await stat(dir)).isDirectory()) continue
      const files = await readdir(join(dir, 'lib'))
      if (files.some(f => f.startsWith('host-heartbeat-') && f.endsWith('.js'))) return join(dir, 'lib')
    } catch { /* 不是它 */ }
  }
  return undefined
}

/** bundle 把导出名压成单字母，靠 `export { 原名 as 短名 }` 反查。 */
function readExportMap(file) {
  const source = readFileSync(file, 'utf8')
  const map = new Map()
  for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim()
      if (!t) continue
      const mm = /^(\S+)\s+as\s+(\S+)$/.exec(t)
      if (mm) map.set(mm[2], mm[1])
      else map.set(t, t)
    }
  }
  return map
}

const lib = await resolveConnectRoot()
if (!lib) {
  console.log('没找到 dsh-workbuddy-connect，跳过（可用 WB_CONNECT_ROOT=<lib 目录> 指定）')
  process.exit(0)
}

const chunkFile = (await readdir(lib)).find(f => f.startsWith('host-heartbeat-') && f.endsWith('.js'))
const chunkPath = join(lib, chunkFile)
console.log(`0.7.1 位置： ${chunkPath}`)

const exportMap = readExportMap(chunkPath)
const mod = await import(pathToFileURL(chunkPath).href)

// 按形状认人：有 current/status/resolve/logout 的就是 CredentialStore
const Store = Object.entries(mod)
  .map(([short, value]) => ({ short, name: exportMap.get(short) ?? short, value }))
  .find(e => typeof e.value === 'function'
    && ['current', 'status', 'resolve', 'logout'].every(k => typeof e.value.prototype?.[k] === 'function'))
  ?.value

if (!Store) {
  console.log('❌ 没在 chunk 里找到 WorkBuddyCredentialStore')
  process.exit(1)
}
console.log(`找到凭据存储类： ${exportMap.get(Object.keys(mod).find(k => mod[k] === Store)) ?? '(匿名)'}`)

/* ---------- 造一份凭据，交给 0.7.1 读 ---------- */

const VARIANT_AI = {
  id: 'workbuddy-ai',
  region: 'global',
  ownFilename: '.workbuddy-ai-auth.json',
  desktopFilename: 'workbuddy-desktop-ai.info',
  fallbackDomain: 'workbuddy.ai',
}

const home = await mkdtemp(join(tmpdir(), 'wb-proof-'))
const ownPath = join(home, VARIANT_AI.ownFilename)

const now = Date.now()
const credential = {
  accessToken: 'proof-access-token-' + now,
  refreshToken: 'proof-refresh-token-' + now,
  expiresAtMs: now + 3600_000,
  refreshExpiresAtMs: now + 30 * 86400_000,
  domain: 'workbuddy.ai',
  uid: 'proof-uid',
  nickname: 'proof-user',
}

if (WRITE) {
  await writeFile(ownPath, JSON.stringify({
    version: 1,
    credential: { ...credential, enterpriseId: undefined },
  }, null, 2), { mode: 0o600 })
  console.log(`\n已写入： ${ownPath}`)
}

const store = new Store({
  variant: VARIANT_AI,
  refresh: async () => { throw new Error('不该走到刷新') },
  ownPath,
  desktopPath: join(home, 'no-such-desktop-file.info'), // 模拟 NAS：桌面 App 不存在
})

console.log('\n--- 0.7.1 的 status()（只读、不刷新、不抛）---')
const st = await store.status()
console.log(JSON.stringify(st, null, 2))

if (WRITE) {
  console.log('--- 0.7.1 的 current()（走 region 校验）---')
  const cur = await store.current()
  console.log(JSON.stringify({
    source: cur?.source,
    domain: cur?.domain,
    uid: cur?.uid,
    nickname: cur?.nickname,
    expiresAtMs: cur?.expiresAtMs,
    tokenMatches: cur?.accessToken === credential.accessToken,
  }, null, 2))

  await rm(home, { recursive: true, force: true })
  console.log('\n临时目录已清理')
}

const ok = st.state === 'signed-in'
console.log(`\n${ok ? '✅ 读到了 —— 没有桌面 App 也能 signed-in' : '❌ 没读到：' + JSON.stringify(st)}`)
process.exit(ok ? 0 : 1)
