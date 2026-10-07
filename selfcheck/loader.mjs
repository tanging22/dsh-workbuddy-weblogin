/**
 * 自检用的 ESM loader —— `node --import ./selfcheck/loader.mjs selfcheck.mjs`
 * ============================================================================
 * 目的：把 `dsh-workbuddy-connect@0.7.1` 的**真实**凭据解析代码拉起来跑，
 * 用它自己的 `parseOwnDocument` / `WorkBuddyCredentialStore.status()` 验我们
 * 写出的文件 —— 而不是照抄一份校验自己糊弄自己。
 *
 * 障碍：那个模块 import 了 `@deepseek-ai/dsh-atomic-write` 和
 * `@deepseek-ai/dsh-home-paths`，而 web profile 的 node_modules 里**没有**
 * 这两个包（它们属于 profile 外层依赖，插件进程里才有）。
 *
 * 解法：只把这两个**与凭据格式无关**的裸说明符重定向到本地桩。
 * 凭据解析链（parseOwnDocument / current / status / regionOf）一行没改。
 *
 * 桩的行为：
 *   - writeFileAtomic：写文件（mode 0o600 无所谓）
 *   - withFileLock：直接跑（自检是单进程，没并发）
 *   - resolveDshHome：`$DSH_HOME` > `~/.dsh`，与真实实现语义一致
 */
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))

const REDIRECT = {
  '@deepseek-ai/dsh-atomic-write': pathToFileURL(joinPath(HERE, 'stub-atomic-write.mjs')).href,
  '@deepseek-ai/dsh-home-paths': pathToFileURL(joinPath(HERE, 'stub-home-paths.mjs')).href,
}

function joinPath(a, b) {
  const sep = a.includes('\\') ? '\\' : '/'
  return a.endsWith(sep) ? a + b : a + sep + b
}

register(
  'data:text/javascript,' + encodeURIComponent(`
    const REDIRECT = ${JSON.stringify(REDIRECT)};
    export async function resolve(specifier, context, next) {
      const target = REDIRECT[specifier];
      if (target !== undefined) {
        return { url: target, shortCircuit: true, format: 'module' };
      }
      return next(specifier, context);
    }
  `),
)
