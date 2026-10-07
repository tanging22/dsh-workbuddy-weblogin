/** 桩：原子写 + 文件锁（自检单进程，锁直接放行）。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function writeFileAtomic(path, data, options = {}) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, data, { encoding: 'utf8', ...(options.mode === undefined ? {} : { mode: options.mode }) })
}

export async function withFileLock(_path, fn) {
  return await fn()
}
