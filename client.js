/**
 * dsh-workbuddy-weblogin —— 浏览器半端（client bundle）
 * ============================================================================
 * 设置里的「WorkBuddy 登录」页面：点一下拿到 WorkBuddy 的授权链接，
 * 在浏览器里登录完，宿主自动把凭据写进 `dsh-workbuddy-connect` 会读的那份文件。
 *
 * 设计约束：
 *   1. **只占一格属于自己的设置页**（`settings.section`，id = 包名）。
 *      绝不去占 `dsh-workbuddy-connect` 的 key —— 那会 shadow 掉官方配置页。
 *   2. **没有弹窗、没有 DOM 注入**：全部走 React 插槽，不碰宿主 DOM。
 *      样式写在自己的 <style> 里，卸载时移除。
 *   3. 令牌/凭据**一个字符都不进**前端 state —— 前端只拿得到「有没有登录、
 *      昵称、过期时间」，写文件全在宿主侧。
 *   4. 登录链接**展示成可复制的文本框 + 「打开」按钮**（不自动弹窗，
 *      免得被浏览器拦，也方便主人拿到另一台机器上登录）。
 *   5. 轮询节奏在前端（每 2.5s 一次），宿主侧每次只做一次上游请求 ——
 *      这样取消/关闭页面就能立刻停，不会留下野轮询。
 *   6. 两个变体（AI 国际版 / CN 国内版）共用一页，靠顶部两个按钮切换；
 *      切换会先撤销当前会话再重新读状态。
 *
 * 手写 factory bundle：无需构建，`exports["./client"]` 直接指向本文件。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-workbuddy-weblogin',
  factory(require) {
    const React = require('react')

    /** 宿主路由前缀，与宿主半端 index.js 的 ROUTE_PREFIX 一致。 */
    const API = '/api/wb-login'
    /** 等待授权时的轮询间隔（宿主侧每次只发一个上游请求）。 */
    const POLL_INTERVAL_MS = 2500
    /** 状态兜底刷新间隔（登录态本身由上游续期，这里只是让页面跟上）。 */
    const STATUS_REFRESH_MS = 30000

    /** 两个变体：id 与宿主半端 VARIANTS 的键一致。 */
    const VARIANTS = [
      { id: 'ai', label: 'WorkBuddy AI（国际版）' },
      { id: 'cn', label: 'WorkBuddy（国内版）' },
    ]

    const CSS = `
[data-wbl]{display:flex;flex-direction:column;gap:12px;width:100%;box-sizing:border-box;}
[data-wbl-title]{font-size:14px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary);}
[data-wbl-desc]{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}
[data-wbl-row]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-wbl-switch]{display:inline-flex;gap:4px;padding:2px;border-radius:10px;
  background:var(--dsw-alias-bg-layer-1, rgba(128,128,128,.08));}
[data-wbl-switch]>[data-wbl-btn][data-wbl-on]{background:var(--dsw-alias-bg-layer-2, rgba(128,128,128,.22));
  border-color:transparent;color:var(--dsw-alias-label-primary);}
[data-wbl-dot]{width:7px;height:7px;border-radius:999px;flex:none;
  background:var(--dsw-alias-state-warn-primary, #d89614);}
[data-wbl-dot][data-wbl-ok]{background:var(--dsw-alias-state-success-primary, #2e9e5b);}
[data-wbl-text]{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}
[data-wbl-sub]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);word-break:break-all;}
[data-wbl-card]{display:flex;flex-direction:column;gap:8px;padding:12px;box-sizing:border-box;
  border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.28));border-radius:12px;}
[data-wbl-url]{flex:1;min-width:0;height:30px;padding:0 8px;box-sizing:border-box;
  border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.28));border-radius:8px;
  background:var(--dsw-alias-bg-layer-1, transparent);color:var(--dsw-alias-label-secondary);
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;}
[data-wbl-btn]{display:inline-flex;align-items:center;justify-content:center;height:30px;padding:0 12px;
  border:1px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2, rgba(128,128,128,.28)));
  border-radius:8px;background:transparent;cursor:pointer;font-size:12px;line-height:1;
  font-family:inherit;color:var(--dsw-alias-label-secondary);white-space:nowrap;}
[data-wbl-btn]:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12));
  color:var(--dsw-alias-label-primary);}
[data-wbl-btn]:disabled{opacity:.5;cursor:default;}
[data-wbl-btn][data-wbl-primary]{border-color:transparent;background:var(--dsw-alias-button-info-fill, #2f6feb);
  color:var(--dsw-alias-label-primary-foreground, #fff);}
[data-wbl-btn][data-wbl-primary]:hover{background:var(--dsw-alias-button-info-hover, var(--dsw-alias-button-info-fill, #2f6feb));}
[data-wbl-btn][data-wbl-danger]{color:var(--dsw-alias-state-error-primary, #d64545);}
[data-wbl-btn][data-wbl-danger]:hover{background:var(--dsw-alias-state-error-primary, #d64545);
  color:var(--dsw-alias-label-primary-foreground, #fff);}
[data-wbl-error]{padding:6px 10px;border-radius:8px;font-size:12px;line-height:18px;word-break:break-word;
  background:var(--dsw-alias-state-error-primary, #d64545);color:var(--dsw-alias-label-primary-foreground, #fff);}
[data-wbl-note]{padding:6px 10px;border-radius:8px;font-size:11px;line-height:17px;word-break:break-word;
  background:var(--dsw-alias-bg-layer-1, rgba(128,128,128,.08));color:var(--dsw-alias-label-tertiary);}
`

    /** 过期时间的中文短串；拿不到就说"未知"。 */
    function formatExpiry(expiresAtMs) {
      if (typeof expiresAtMs !== 'number' || expiresAtMs <= 0) return '未知'
      const delta = expiresAtMs - Date.now()
      if (delta <= 0) return '已过期'
      const mins = Math.round(delta / 60000)
      if (mins < 60) return `${mins} 分钟后`
      const hours = Math.round(mins / 60)
      if (hours < 24) return `${hours} 小时后`
      return `${Math.round(hours / 24)} 天后`
    }

    /** 设置页：一个变体一张卡，顶部两个按钮切变体。 */
    function WbLoginPage() {
      const [variant, setVariant] = React.useState(VARIANTS[0].id)
      const [status, setStatus] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [authUrl, setAuthUrl] = React.useState('')
      const [phase, setPhase] = React.useState('idle') // idle | waiting | done
      const [copied, setCopied] = React.useState(false)
      const sessionRef = React.useRef('')
      const timerRef = React.useRef(null)

      const stopPolling = React.useCallback(() => {
        if (timerRef.current !== null) {
          clearInterval(timerRef.current)
          timerRef.current = null
        }
      }, [])

      const refresh = React.useCallback(async () => {
        try {
          const res = await fetch(`${API}/status?variant=${encodeURIComponent(variant)}`, { method: 'GET' })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
          setStatus(body)
          setError('')
        } catch (err) {
          setError(`状态读取失败：${err instanceof Error ? err.message : String(err)}`)
        }
      }, [variant])

      React.useEffect(() => {
        refresh()
        const timer = setInterval(refresh, STATUS_REFRESH_MS)
        return () => {
          clearInterval(timer)
          stopPolling()
          if (sessionRef.current !== '') {
            void fetch(`${API}/cancel`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ session: sessionRef.current }),
            }).catch(() => {})
          }
        }
      }, [refresh, stopPolling])

      const startLogin = React.useCallback(async () => {
        setBusy(true)
        setError('')
        setCopied(false)
        try {
          const res = await fetch(`${API}/start`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ variant }),
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
          sessionRef.current = body.sessionId
          setAuthUrl(body.authUrl)
          setPhase('waiting')

          stopPolling()
          timerRef.current = setInterval(async () => {
            if (sessionRef.current === '') return
            try {
              const pres = await fetch(`${API}/poll?session=${encodeURIComponent(sessionRef.current)}`, { method: 'GET' })
              const pbody = await pres.json().catch(() => ({}))
              if (!pres.ok) return
              if (pbody.state === 'done') {
                stopPolling()
                sessionRef.current = ''
                setPhase('done')
                setAuthUrl('')
                await refresh()
              } else if (pbody.state === 'failed') {
                stopPolling()
                sessionRef.current = ''
                setPhase('idle')
                setAuthUrl('')
                setError(`登录失败：${pbody.reason ?? '上游未给出原因'}`)
              } else if (pbody.state === 'expired' || pbody.state === 'gone') {
                stopPolling()
                sessionRef.current = ''
                setPhase('idle')
                setAuthUrl('')
                setError('登录超时或已失效，请重新点一次「开始登录」。')
              }
              // pending / retrying → 继续等
            } catch { /* 网络抖动，下一轮再来 */ }
          }, POLL_INTERVAL_MS)
        } catch (err) {
          setError(`无法开始登录：${err instanceof Error ? err.message : String(err)}`)
        } finally {
          setBusy(false)
        }
      }, [refresh, stopPolling, variant])

      const cancelLogin = React.useCallback(() => {
        stopPolling()
        const id = sessionRef.current
        sessionRef.current = ''
        setPhase('idle')
        setAuthUrl('')
        if (id !== '') {
          void fetch(`${API}/cancel`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ session: id }),
          }).catch(() => {})
        }
      }, [stopPolling])

      /** 切换变体：先撤销当前会话，再让 effect 重新读状态（cancelLogin 在下方定义，靠函数提升可用）。 */
      function switchVariant(next) {
        if (next === variant) return
        cancelLogin()
        setStatus(null)
        setError('')
        setPhase('idle')
        setAuthUrl('')
        setVariant(next)
      }

      const logout = React.useCallback(async () => {
        setBusy(true)
        try {
          const res = await fetch(`${API}/logout`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ variant }),
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
          await refresh()
        } catch (err) {
          setError(`退出失败：${err instanceof Error ? err.message : String(err)}`)
        } finally {
          setBusy(false)
        }
      }, [refresh, variant])

      const copyUrl = React.useCallback(() => {
        const done = () => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(authUrl).then(done).catch(() => {})
        }
      }, [authUrl])

      const own = status?.own
      const signedIn = own?.present === true && own.expired !== true

      return React.createElement('div', { 'data-wbl': '' },
        React.createElement('div', { 'data-wbl-title': '' }, 'WorkBuddy 登录'),
        React.createElement('div', { 'data-wbl-desc': '' },
          '在浏览器里登录 WorkBuddy 账号，凭据会写进 dsh-workbuddy-connect 读取的那份文件。装了桌面 App 也能用，不装也能用。'),

        React.createElement('div', { 'data-wbl-switch': '' },
          VARIANTS.map(item => React.createElement('button', {
            key: item.id,
            type: 'button',
            'data-wbl-btn': '',
            'data-wbl-on': item.id === variant ? '' : undefined,
            onClick: () => switchVariant(item.id),
          }, item.label))),

        error !== ''
          ? React.createElement('div', { 'data-wbl-error': '' }, error)
          : null,

        React.createElement('div', { 'data-wbl-card': '' },
          React.createElement('div', { 'data-wbl-row': '' },
            React.createElement('span', { 'data-wbl-dot': '', 'data-wbl-ok': signedIn ? '' : undefined }),
            React.createElement('span', { 'data-wbl-text': '' },
              status === null
                ? '读取中…'
                : signedIn
                  ? `已登录${own.nickname ? ` · ${own.nickname}` : ''}${own.uid ? `（${own.uid}）` : ''}`
                  : '未登录'),
            React.createElement('span', { style: { flex: 1 } }),
            signedIn
              ? React.createElement('button', {
                  type: 'button', 'data-wbl-btn': '', 'data-wbl-danger': '',
                  disabled: busy || undefined, onClick: logout,
                }, '退出登录')
              : React.createElement('button', {
                  type: 'button', 'data-wbl-btn': '', 'data-wbl-primary': '',
                  disabled: busy || status === null || phase === 'waiting' || undefined, onClick: startLogin,
                }, phase === 'waiting' ? '等待授权中…' : '开始登录'),
          ),

          signedIn
            ? React.createElement('div', { 'data-wbl-sub': '' },
                `令牌 ${formatExpiry(own.expiresAtMs)}过期${own.hasRefresh ? '（可自动续期）' : '（无续期令牌，过期后需重新登录）'}`)
            : null,

          phase === 'waiting'
            ? React.createElement(React.Fragment, null,
                React.createElement('div', { 'data-wbl-sub': '' },
                  '请在浏览器里打开下面的链接并完成登录（任何设备都可以）。登录完成后这里会自动更新。'),
                React.createElement('div', { 'data-wbl-row': '' },
                  React.createElement('input', {
                    'data-wbl-url': '', readOnly: true, value: authUrl,
                    onFocus: (e) => e.target.select(),
                  }),
                  React.createElement('button', {
                    type: 'button', 'data-wbl-btn': '',
                    onClick: () => { window.open(authUrl, '_blank', 'noopener') },
                  }, '打开'),
                  React.createElement('button', {
                    type: 'button', 'data-wbl-btn': '', onClick: copyUrl,
                  }, copied ? '已复制' : '复制'),
                  React.createElement('button', {
                    type: 'button', 'data-wbl-btn': '', 'data-wbl-danger': '', onClick: cancelLogin,
                  }, '取消'),
                ),
              )
            : null,
        ),

        React.createElement('div', { 'data-wbl-note': '' },
          `凭据写入 ${status?.ownPath ?? 'DSH home 下的凭据文件'}；写入后由 dsh-workbuddy-connect 自己续期，无需再登录。`),

        (status?.desktop?.outranks === true)
          ? React.createElement('div', { 'data-wbl-note': '' },
              `检测到桌面凭据文件：${(status.desktop.present ?? []).join('、')}。它的优先级高于本插件写入的副本，若它不可读会让登录状态报错。`)
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-workbuddy-weblogin')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => { style.remove() }, 'dsh-workbuddy-weblogin: page styles')

        // 设置页只占一格属于自己的：id = 包名，排在「插件」(15) 之后、
        // 「智能体预设」(20) 之前。绝不去占 dsh-workbuddy-connect 的格子。
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-workbuddy-weblogin',
            order: 17,
            label: () => 'WorkBuddy 登录',
          },
          WbLoginPage,
        ))
      },
    }
  },
})
