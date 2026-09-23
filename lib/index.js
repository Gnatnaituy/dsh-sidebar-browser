/**
 * Host half of dsh-sidebar-element-picker.
 *
 * The sidebar browser is a page served by a per-tab reverse proxy (see
 * `resources/proxy.js`), so this half has four jobs:
 *
 *   1. own the proxies — one loopback port per (DSH tab, target origin), which
 *      is what isolates two different sites into two different browser origins;
 *   2. own the browser's own tab list for each conversation. The client panel is
 *      React state that DSH may unmount at any moment (a session switch, a
 *      collapsed column), so anything kept only there is lost; keeping the list
 *      here is what makes open pages survive, and keying it by conversation
 *      (rather than by view) is what lets the composer open a page before any
 *      panel exists;
 *   3. keep the picked-element context and expose it to the model as the
 *      `read_picked_element` tool plus one line per element in the system
 *      prompt, so `[标签][DOMn]` placeholders in a user message resolve;
 *   4. answer the client panel's `/invoke` commands.
 *
 * Element data flows in through the proxy the shell was served from, not
 * through this HTTP surface: the shell POSTs a pick to its own port and the
 * session callback below records it, so a pick is never lost to a race with
 * the panel.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ProxySession, mintToken } from '../resources/proxy.js'

/** The plugin id: the loader entry name, the client bundle id, the prompt name. */
export const name = 'dsh-sidebar-element-picker'

/** Services this plugin needs before `apply` runs. */
export const inject = ['webServer', 'tools', 'systemPrompt']

/** Route prefix for the client-facing command surface. */
const ROUTE = '/dsh-sidebar-element-picker'

/** Label length in the `[标签][DOMn]` placeholder, matching the old picker. */
const LABEL_LIMIT = 10

/** How many elements one conversation keeps before the oldest are dropped. */
const CONTEXT_LIMIT = 200

/** How many browser tabs one sidebar tab may hold. */
const TAB_LIMIT = 12

/** Device preset keys the host accepts back from a client snapshot. */
const DEVICE_KEYS = new Set([
  'responsive',
  'phone-360',
  'phone-375',
  'phone-393',
  'phone-412',
  'phone-430',
  'tablet-744',
  'tablet-820',
  'tablet-834',
])

const RESOURCES = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources')

/**
 * @param {string} message - diagnostic text.
 * @param {unknown} [error] - optional cause.
 */
function logInfo(message, error) {
  if (error === undefined) console.info(`[${name}] ${message}`)
  else console.info(`[${name}] ${message}`, error)
}

/** @param {string} message - warning text. */
function logWarn(message) {
  console.warn(`[${name}] ${message}`)
}

/** @returns {Promise<Record<string, {body: Buffer, type: string}>>} the shell's own files. */
async function loadAssets() {
  const files = [
    ['chrome.html', 'text/html; charset=utf-8'],
    ['chrome.css', 'text/css; charset=utf-8'],
    ['chrome.js', 'application/javascript; charset=utf-8'],
  ]
  const assets = {}
  for (const [file, type] of files) {
    assets[file] = { body: await readFile(join(RESOURCES, file)), type }
  }
  return assets
}

/**
 * Shorten an element to the label a placeholder shows.
 * @param {object} payload - the picked element.
 * @returns {string} at most {@link LABEL_LIMIT} characters, plus an ellipsis.
 */
function labelOf(payload) {
  const candidates = [
    payload.text,
    payload.attributes && payload.attributes['aria-label'],
    payload.attributes && payload.attributes.placeholder,
    payload.attributes && payload.attributes.alt,
    payload.attributes && payload.attributes.title,
    payload.attributes && payload.attributes.value,
  ]
  for (const candidate of candidates) {
    const text = String(candidate ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    if (text !== '') return text.length > LABEL_LIMIT ? `${text.slice(0, LABEL_LIMIT)}…` : text
  }
  const tag = String(payload.tag ?? 'element')
  if (payload.id) return `${tag}#${payload.id}`
  const first = Array.isArray(payload.classes) ? payload.classes[0] : undefined
  if (first !== undefined) return `${tag}.${first}`
  return tag
}

/**
 * Give bare address-bar text an `http://` scheme without mistaking `host:port`
 * for a scheme: `localhost:3000/admin` is a host and a port, not a URL in the
 * `localhost` scheme, and a real foreign scheme (`mailto:`, `file:`) must be
 * refused rather than silently rewritten into a host.
 * @param {string} text - what the user typed.
 * @returns {string} absolute http(s) text, or `''` when it cannot be one.
 */
function withScheme(text) {
  var match = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/.exec(text)
  if (match === null) return `http://${text}`
  if (/^https?$/i.test(match[1])) return text
  if (/^\d+(?:[/?#].*)?$/.test(match[2])) return `http://${text}`
  return ''
}

/**
 * @param {string} url - a URL the panel or shell asked for.
 * @returns {{origin: string, path: string}|undefined} its origin and path.
 */
function splitUrl(url) {
  const text = withScheme(String(url ?? '').trim())
  if (text === '') return undefined
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  return { origin: `${parsed.protocol}//${parsed.host}`, path: `${parsed.pathname}${parsed.search}${parsed.hash}` }
}

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  const tools = ctx.get('tools')
  const systemPrompt = ctx.get('systemPrompt')

  /**
   * Picked elements per conversation, newest last.
   * @type {Map<string, Array<{domId: string, label: string, payload: object, sessionId: string, seq: number, time: number}>>}
   */
  const contexts = new Map()

  /**
   * The browser's own tabs per conversation. This, not the panel, is the
   * authority: the panel is remounted freely and re-reads this on mount, and a
   * conversation has exactly one browser (DSH allows one page tab of a kind per
   * pane), which is why the key is the session and not the view.
   * @type {Map<string, {activeId: string, counter: number, tabs: Map<string, {id: string, origin: string, path: string, title: string, zoom: number, deviceKey: string, landscape: boolean, nav: number}>}>}
   */
  const browsers = new Map()

  /** @type {Map<string, ProxySession>} one loopback port per `sessionId::origin`. */
  const ports = new Map()

  let counter = 0
  let tabCounter = 0

  /**
   * @param {string} sessionId - the conversation the elements belong to.
   * @returns {Array<object>} that conversation's live context.
   */
  function contextOf(sessionId) {
    let list = contexts.get(sessionId)
    if (list === undefined) {
      list = []
      contexts.set(sessionId, list)
    }
    return list
  }

  /**
   * Record one pick and assign its conversation-wide number.
   * @param {string} sessionId - the conversation that picked.
   * @param {object} payload - the element snapshot from the shell.
   * @returns {{domId: string, label: string}} the assigned identity.
   */
  function record(sessionId, payload) {
    counter += 1
    const entry = {
      domId: `DOM${counter}`,
      label: labelOf(payload),
      payload,
      sessionId,
      seq: counter,
      time: Date.now(),
    }
    const list = contextOf(sessionId)
    list.push(entry)
    while (list.length > CONTEXT_LIMIT) list.shift()
    logInfo(`picked ${entry.domId} (${entry.label}) in ${sessionId}, ${list.length} in context`)
    return { domId: entry.domId, label: entry.label }
  }

  /**
   * Find one picked element anywhere it was recorded. Numbers are unique across
   * conversations, which is what lets the tool resolve a placeholder without
   * knowing which conversation it came from.
   * @param {string} domId - the `DOMn` number.
   * @returns {object|undefined} the recorded entry.
   */
  function find(domId) {
    for (const list of contexts.values()) {
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (list[i].domId === domId) return list[i]
      }
    }
    return undefined
  }

  // ------------------------------------------------------------------ browser

  /**
   * @param {string} sessionId - the conversation.
   * @returns {object} that conversation's browser state, created on first use.
   */
  function browserOf(sessionId) {
    let browser = browsers.get(sessionId)
    if (browser === undefined) {
      browser = { activeId: '', counter: 0, tabs: new Map() }
      browsers.set(sessionId, browser)
    }
    return browser
  }

  /**
   * Serve one target origin for one conversation, reusing the port when it
   * already exists. A browser that wanders across origins gets one port per
   * origin, so cookies and web storage never bleed between two sites — and
   * every tab on the same origin shares one port, like a real browser profile.
   * @param {string} sessionId - the conversation.
   * @param {string} origin - the target origin to serve.
   * @param {number} [preferredPort] - the port this origin used before, so its
   * browser origin (and therefore the app's web storage) survives a restart.
   * @returns {Promise<ProxySession>} the listening session.
   */
  async function ensurePort(sessionId, origin, preferredPort) {
    const key = `${sessionId}::${origin}`
    const existing = ports.get(key)
    if (existing !== undefined) return existing
    const session = new ProxySession({
      token: mintToken(),
      // Read the shell's files per port rather than once per process, so editing
      // `resources/` takes effect on the next page that opens instead of
      // needing a restart.
      assets: await loadAssets(),
      log: (level, message) => {
        if (level === 'warn') logWarn(message)
        else logInfo(message)
      },
      onPick: (payload) => {
        const recorded = record(sessionId, payload)
        return { ok: true, ...recorded, count: contextOf(sessionId).length }
      },
    })
    session.setTarget(origin)
    await session.start(preferredPort)
    ports.set(key, session)
    return session
  }

  /**
   * Drop a port once no browser tab still points at its origin.
   * @param {string} sessionId - the conversation.
   * @param {string} origin - the origin to release.
   */
  function releasePort(sessionId, origin) {
    const browser = browsers.get(sessionId)
    if (browser !== undefined) {
      for (const tab of browser.tabs.values()) {
        if (tab.origin === origin) return
      }
    }
    const key = `${sessionId}::${origin}`
    const session = ports.get(key)
    if (session === undefined) return
    ports.delete(key)
    session.close()
  }

  /** @param {string} sessionId - the conversation whose browser must go away. */
  function closeBrowser(sessionId) {
    const browser = browsers.get(sessionId)
    if (browser !== undefined) {
      for (const tab of browser.tabs.values()) releasePort(sessionId, tab.origin)
      browsers.delete(sessionId)
    }
    for (const key of [...ports.keys()]) {
      if (key.startsWith(`${sessionId}::`)) {
        ports.get(key)?.close()
        ports.delete(key)
      }
    }
  }

  /**
   * The wire shape of a browser: what the panel renders, with each tab's live
   * port resolved.
   * @param {string} sessionId - the conversation.
   * @returns {object} the panel-facing state.
   */
  function hydrate(sessionId) {
    const browser = browsers.get(sessionId)
    if (browser === undefined) return { ok: true, activeId: '', tabs: [] }
    const tabs = []
    for (const tab of browser.tabs.values()) {
      const session = ports.get(`${sessionId}::${tab.origin}`)
      tabs.push({
        id: tab.id,
        origin: tab.origin,
        path: tab.path,
        title: tab.title,
        url: `${tab.origin}${tab.path}`,
        zoom: tab.zoom,
        deviceKey: tab.deviceKey,
        landscape: tab.landscape,
        // Bumped only by an explicit navigation, never by the shell reporting
        // where it went. The panel pins a frame's source and re-derives it on
        // `(port, nav)` alone, so a re-render cannot reload a page the user is
        // already on — see `path` being the live address and `nav` the command.
        nav: tab.nav,
        port: session === undefined ? 0 : session.port,
      })
    }
    return { ok: true, activeId: browser.activeId, tabs }
  }

  /**
   * Mint a browser tab and give it a port.
   * @param {string} sessionId - the conversation.
   * @param {string} origin - the target origin.
   * @param {string} path - the path to show.
   * @param {number} [preferredPort] - the port this origin used before.
   * @returns {Promise<object>} the new tab.
   */
  async function addTab(sessionId, origin, path, preferredPort) {
    const browser = browserOf(sessionId)
    browser.counter += 1
    tabCounter += 1
    const tab = {
      id: `t${browser.counter}-${tabCounter}`,
      origin,
      path,
      title: '',
      zoom: 1,
      deviceKey: 'responsive',
      landscape: false,
      nav: 1,
    }
    browser.tabs.set(tab.id, tab)
    while (browser.tabs.size > TAB_LIMIT) {
      const oldest = browser.tabs.keys().next().value
      const dropped = browser.tabs.get(oldest)
      browser.tabs.delete(oldest)
      if (dropped !== undefined) releasePort(sessionId, dropped.origin)
      if (browser.activeId === oldest) browser.activeId = ''
    }
    browser.activeId = tab.id
    await ensurePort(sessionId, origin, preferredPort)
    return tab
  }

  /**
   * Rebuild a browser from a client snapshot (the durable copy the panel keeps
   * in local storage, which is what carries open pages across a DSH restart).
   * @param {string} sessionId - the conversation.
   * @param {object} restore - `{activeId, tabs:[{url, title, zoom, deviceKey, landscape}]}`.
   * @returns {Promise<void>} resolves once every port is listening.
   */
  async function adoptRestore(sessionId, restore) {
    const wanted = Array.isArray(restore.tabs) ? restore.tabs.slice(0, TAB_LIMIT) : []
    if (wanted.length === 0) return
    const browser = browserOf(sessionId)
    let index = 0
    for (const entry of wanted) {
      const split = splitUrl(String(entry.url ?? `${entry.origin ?? ''}${entry.path ?? ''}`))
      if (split === undefined) continue
      index += 1
      tabCounter += 1
      const tab = {
        id: `r${index}-${tabCounter}`,
        origin: split.origin,
        path: split.path === '' ? '/' : split.path,
        title: String(entry.title ?? ''),
        zoom: typeof entry.zoom === 'number' && isFinite(entry.zoom) ? Math.min(3, Math.max(0.25, entry.zoom)) : 1,
        deviceKey: DEVICE_KEYS.has(entry.deviceKey) ? entry.deviceKey : 'responsive',
        landscape: entry.landscape === true,
        nav: 1,
        // The port this origin used before, so the restored page is the same
        // browser origin it was — and the site's own web storage still applies.
        preferredPort: Number(entry.port),
      }
      browser.tabs.set(tab.id, tab)
      if (String(entry.id ?? '') === String(restore.activeId ?? '')) browser.activeId = tab.id
    }
    if (browser.activeId === '' && browser.tabs.size > 0) browser.activeId = browser.tabs.keys().next().value
    for (const tab of browser.tabs.values()) {
      await ensurePort(sessionId, tab.origin, tab.preferredPort)
    }
    logInfo(`restored ${browser.tabs.size} browser tab(s) for ${sessionId}`)
  }

  /**
   * @returns {string} the system-prompt block listing every referenceable element.
   */
  function buildSummary() {
    const entries = []
    for (const list of contexts.values()) entries.push(...list)
    if (entries.length === 0) return ''
    entries.sort((a, b) => a.seq - b.seq)
    const shown = entries.slice(-60)
    const lines = shown.map((entry) => {
      const payload = entry.payload ?? {}
      const tag = String(payload.tag ?? '?')
      const id = payload.id ? ` #${payload.id}` : ''
      const text = String(payload.text ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40)
      const quoted = text === '' ? '' : ` “${text}”`
      const url = String(payload.pageUrl ?? '')
      return `${entry.domId}=<${tag}>${id}${quoted} (${url})`
    })
    return [
      `以下页面元素是用户从侧边栏浏览器中拾取、并在消息里以 [标签][DOMn] 引用的（共 ${entries.length} 个，此处列出最近 ${shown.length} 个）：`,
      ...lines,
      '需要某个元素的完整信息（HTML / CSS 选择器 / DOM 路径 / 属性 / 位置尺寸 / 页面 URL）时，调用 read_picked_element 工具，参数为 {"id":"DOMn"}。',
    ].join('\n')
  }

  // ------------------------------------------------------------------ routes

  /** @type {Map<string, (params: object) => Promise<object>|object>} */
  const handlers = new Map()

  handlers.set('browser-state', async (params) => {
    const sessionId = String(params.sessionId ?? '')
    const restore = params.restore
    if (!browsers.has(sessionId) && restore !== null && typeof restore === 'object') {
      await adoptRestore(sessionId, restore)
    } else {
      browserOf(sessionId)
    }
    return hydrate(sessionId)
  })

  handlers.set('browser-open', async (params) => {
    const sessionId = String(params.sessionId ?? '')
    const split = splitUrl(String(params.url ?? '').trim())
    if (split === undefined) return { ok: false, error: '网址无法识别' }
    const preferred = Number(params.preferredPort)
    const browser = browserOf(sessionId)
    if (params.newTab !== true) {
      const active = browser.tabs.get(browser.activeId)
      if (active !== undefined && active.origin === split.origin) {
        active.path = split.path
        active.nav += 1
        await ensurePort(sessionId, split.origin, preferred)
        return hydrate(sessionId)
      }
    }
    await addTab(sessionId, split.origin, split.path, preferred)
    return hydrate(sessionId)
  })

  handlers.set('browser-navigate', async (params) => {
    const sessionId = String(params.sessionId ?? '')
    const id = String(params.id ?? '')
    const split = splitUrl(String(params.url ?? '').trim())
    if (split === undefined) return { ok: false, error: '网址无法识别' }
    const browser = browserOf(sessionId)
    const tab = browser.tabs.get(id)
    if (tab === undefined) return hydrate(sessionId)
    const previous = tab.origin
    tab.origin = split.origin
    tab.path = split.path
    tab.nav += 1
    browser.activeId = id
    await ensurePort(sessionId, split.origin, Number(params.preferredPort))
    if (previous !== split.origin) releasePort(sessionId, previous)
    return hydrate(sessionId)
  })

  handlers.set('browser-select', (params) => {
    const sessionId = String(params.sessionId ?? '')
    const browser = browserOf(sessionId)
    const id = String(params.id ?? '')
    if (browser.tabs.has(id)) browser.activeId = id
    return hydrate(sessionId)
  })

  handlers.set('browser-close', (params) => {
    const sessionId = String(params.sessionId ?? '')
    if (params.all === true) {
      closeBrowser(sessionId)
      browserOf(sessionId)
      return hydrate(sessionId)
    }
    const browser = browserOf(sessionId)
    const id = String(params.id ?? '')
    const tab = browser.tabs.get(id)
    if (tab !== undefined) {
      browser.tabs.delete(id)
      releasePort(sessionId, tab.origin)
      if (browser.activeId === id) {
        const remaining = [...browser.tabs.keys()]
        browser.activeId = remaining.length === 0 ? '' : remaining[remaining.length - 1]
      }
    }
    return hydrate(sessionId)
  })

  handlers.set('browser-sync', (params) => {
    const browser = browserOf(String(params.sessionId ?? ''))
    const tab = browser.tabs.get(String(params.id ?? ''))
    if (tab === undefined) return { ok: false }
    const split = splitUrl(String(params.url ?? ''))
    if (split !== undefined) {
      // The address only: the shell is already showing this page, so nothing
      // must be re-pointed at it.
      tab.path = split.path
    }
    if (typeof params.title === 'string') tab.title = params.title.slice(0, 200)
    return { ok: true }
  })

  handlers.set('browser-view', (params) => {
    const browser = browserOf(String(params.sessionId ?? ''))
    const tab = browser.tabs.get(String(params.id ?? ''))
    if (tab === undefined) return { ok: false }
    if (typeof params.zoom === 'number' && isFinite(params.zoom)) {
      tab.zoom = Math.min(3, Math.max(0.25, params.zoom))
    }
    if (DEVICE_KEYS.has(params.deviceKey)) tab.deviceKey = params.deviceKey
    if (typeof params.landscape === 'boolean') tab.landscape = params.landscape
    return { ok: true }
  })

  handlers.set('browser-status', (params) => {
    const sessionId = String(params.sessionId ?? '')
    const browser = browsers.get(sessionId)
    if (browser === undefined || browser.tabs.size === 0) return { ok: false, running: false }
    return { ok: true, running: true, activeId: browser.activeId, count: browser.tabs.size }
  })

  handlers.set('context-list', (params) => {
    const list = contextOf(String(params.sessionId ?? ''))
    return {
      ok: true,
      count: list.length,
      items: list.map((entry) => ({
        domId: entry.domId,
        label: entry.label,
        tag: entry.payload?.tag ?? '',
        selector: entry.payload?.selector ?? '',
        pageUrl: entry.payload?.pageUrl ?? '',
        time: entry.time,
      })),
    }
  })

  handlers.set('context-detail', (params) => {
    const entry = find(String(params.domId ?? ''))
    if (entry === undefined) return { ok: false, error: `未找到元素 ${String(params.domId ?? '')}` }
    return { ok: true, id: entry.domId, label: entry.label, element: entry.payload }
  })

  handlers.set('context-clear', (params) => {
    const sessionId = String(params.sessionId ?? '')
    contexts.set(sessionId, [])
    return { ok: true, count: 0 }
  })

  handlers.set('context-remove', (params) => {
    const sessionId = String(params.sessionId ?? '')
    const domId = String(params.domId ?? '')
    const list = contextOf(sessionId)
    const at = list.findIndex((entry) => entry.domId === domId)
    if (at >= 0) list.splice(at, 1)
    return { ok: true, count: list.length }
  })

  ctx.effect(() => {
    const dispose = webServer.register({
      kind: 'exact',
      path: `${ROUTE}/invoke`,
      handler: (req, res) => {
        let body = ''
        let overflow = false
        req.on('data', (chunk) => {
          if (overflow) return
          body += String(chunk)
          if (body.length > 1024 * 1024) {
            overflow = true
            body = ''
          }
        })
        req.on('end', () => {
          const answer = (status, value) => {
            res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(value))
          }
          if (overflow) {
            answer(200, { ok: false, error: '请求体过大' })
            return
          }
          let message = {}
          try {
            message = JSON.parse(body === '' ? '{}' : body)
          } catch {
            answer(200, { ok: false, error: '请求体不是 JSON' })
            return
          }
          const method = typeof message.method === 'string' ? message.method : ''
          const params = message.params !== null && typeof message.params === 'object' ? message.params : {}
          const handler = handlers.get(method)
          if (handler === undefined) {
            answer(404, { ok: false, error: `未知方法：${method}` })
            return
          }
          Promise.resolve()
            .then(() => handler(params))
            .then((result) => answer(200, result))
            .catch((error) => {
              logWarn(`调用 ${method} 失败：${String((error && error.message) || error)}`)
              answer(200, { ok: false, error: String((error && error.message) || error) })
            })
        })
      },
    })
    logInfo(`HTTP 路由已注册：${ROUTE}/invoke`)
    return () => {
      try {
        dispose()
      } catch {
        /* the server is already gone */
      }
    }
  })

  // ------------------------------------------------------------------- agent

  ctx.effect(() =>
    tools.register({
      name: 'read_picked_element',
      description:
        '读取用户从侧边栏浏览器中拾取的页面元素完整信息（HTML、CSS 选择器、DOM 路径、属性、位置尺寸、页面 URL 等）。系统提示中的页面元素列表给出了可用的 DOM 编号，用户消息里的 [DOMn] 占位符与之对应；需要元素细节时按编号读取。',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'DOM 编号，如 DOM1（见系统提示中的页面元素列表）',
          },
        },
        required: ['id'],
      },
      output: {
        schema: {},
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute(args) {
        const id = String((args && args.id) || '')
        if (id === '') throw new Error('read_picked_element 需要参数 id（如 DOM1）')
        const entry = find(id)
        if (entry === undefined) {
          const available = [...contexts.values()].flat().map((item) => item.domId)
          return {
            ok: false,
            error: `未找到元素 ${id}，可用编号：${available.join(', ') || '（暂无）'}`,
          }
        }
        return { ok: true, id: entry.domId, label: entry.label, element: entry.payload }
      },
    }),
  )

  ctx.effect(() =>
    systemPrompt.context({
      name,
      order: 60,
      text: () => buildSummary(),
    }),
  )

  ctx.effect(() => () => {
    for (const sessionId of [...browsers.keys()]) closeBrowser(sessionId)
    for (const session of ports.values()) session.close()
    ports.clear()
    contexts.clear()
    logInfo('插件卸载，代理端口已关闭')
  })

  logInfo(`已就绪（工具 read_picked_element，路由 ${ROUTE}/invoke，端口按标签页动态分配）`)
}
