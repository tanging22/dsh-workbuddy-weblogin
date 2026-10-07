/** 桩：与真实 resolveDshHome 同语义 —— `$DSH_HOME`（空/空白视作未设）> `~/.dsh`。 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function resolveDshHome(configured, env = process.env) {
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured.trim())
  const fromEnv = env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim())
  return join(homedir(), '.dsh')
}
