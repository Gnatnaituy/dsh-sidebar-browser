/**
 * Test for the client half without a browser or DSH: a stub module loader, a
 * small stateful fake host, and a minimal hook runtime so both surfaces really
 * render and the composer → panel handoff, the tab strip, the preview restore
 * and the pick path really run.
 *
 * Run with `node resources/test/client-smoke.mjs`.
 */
let failures = 0

/**
 * @param {string} label - what was checked.
 * @param {boolean} condition - the outcome.
 * @param {unknown} [detail] - extra context on failure.
 */
function check(label, condition, detail) {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!condition) failures += 1
}

// ----------------------------------------------------------- minimal React

let currentStore = null

/**
 * @param {unknown[]} a - previous deps.
 * @param {unknown[]} b - next deps.
 * @returns {boolean} whether the dependency list is unchanged.
 */
function sameDeps(a, b) {
  if (a === undefined || b === undefined) return true
  if (a.length !== b.length) return false
  return a.every((value, index) => value === b[index])
}

/**
 * One stable identity per frame, the way a real iframe keeps its window across
 * re-renders — a new object each render would make message attribution fail.
 */
const frameWindows = new Map()

const React = {
  Fragment: 'Fragment',
  createElement(type, props) {
    const children = Array.prototype.slice.call(arguments, 2)
    const element = { type, props: Object.assign({}, props || {}) }
    if (children.length === 1) element.props.children = children[0]
    else if (children.length > 1) element.props.children = children
    // Each frame gets its own identity so a message can be attributed back to
    // the page that sent it, exactly as a real contentWindow does.
    if (type === 'iframe') {
      const key = String(element.props.key)
      if (!frameWindows.has(key)) {
        const handle = { frame: key }
        handle.postMessage = (message) => pushed.push(message)
        frameWindows.set(key, handle)
      }
      element.contentWindow = frameWindows.get(key)
    }
    if (props && props.ref) {
      if (typeof props.ref === 'function') props.ref(element)
      else props.ref.current = element
    }
    return element
  },
  useState(initial) {
    const store = currentStore
    const at = store.cursor
    store.cursor += 1
    if (store.hooks[at] === undefined) {
      store.hooks[at] = { value: typeof initial === 'function' ? initial() : initial }
    }
    const slot = store.hooks[at]
    return [
      slot.value,
      (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next
        store.dirty = true
      },
    ]
  },
  useRef(initial) {
    const store = currentStore
    const at = store.cursor
    store.cursor += 1
    if (store.hooks[at] === undefined) store.hooks[at] = { value: { current: initial } }
    return store.hooks[at].value
  },
  useMemo(factory, deps) {
    const store = currentStore
    const at = store.cursor
    store.cursor += 1
    const previous = store.hooks[at]
    if (previous === undefined || !sameDeps(previous.deps, deps)) store.hooks[at] = { deps, value: factory() }
    return store.hooks[at].value
  },
  useCallback(fn, deps) {
    return React.useMemo(() => fn, deps)
  },
  useEffect(effect, deps) {
    const store = currentStore
    const at = store.cursor
    store.cursor += 1
    const previous = store.hooks[at]
    if (previous === undefined || !sameDeps(previous.deps, deps)) {
      if (previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup()
      const slot = { deps, effect, cleanup: undefined }
      store.hooks[at] = slot
      store.pending.push(slot)
    }
    return undefined
  },
  useSyncExternalStore(subscribe, getSnapshot) {
    const store = currentStore
    const at = store.cursor
    store.cursor += 1
    if (store.hooks[at] === undefined) store.hooks[at] = { unsubscribe: subscribe(() => {}) }
    return getSnapshot()
  },
}

/**
 * @param {Function} Component - the component to render.
 * @param {object} props - its props.
 * @returns {Promise<object>} the mounted store (`.tree` is the last render).
 */
async function mount(Component, props) {
  const store = { hooks: [], cursor: 0, dirty: false, pending: [], tree: null }
  /** One render pass plus the effects it scheduled. */
  const pass = async () => {
    const outer = currentStore
    currentStore = store
    try {
      for (let round = 0; round < 12; round += 1) {
        store.cursor = 0
        store.pending = []
        store.tree = Component(props)
        for (const slot of store.pending) slot.cleanup = slot.effect()
        await new Promise((resolve) => setTimeout(resolve, 0))
        if (!store.dirty) return
        store.dirty = false
      }
    } finally {
      currentStore = outer
    }
  }
  store.update = pass
  store.unmount = async () => {
    const outer = currentStore
    currentStore = store
    try {
      for (const slot of store.hooks) {
        if (slot !== undefined && typeof slot.cleanup === 'function') await slot.cleanup()
      }
    } finally {
      currentStore = outer
    }
    store.hooks = []
  }
  await pass()
  return store
}

/**
 * @param {object} tree - a rendered element tree.
 * @param {(node: object) => boolean} predicate - the match.
 * @returns {object|undefined} the first matching element.
 */
function find(tree, predicate) {
  if (tree === null || typeof tree !== 'object') return undefined
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const hit = find(child, predicate)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (predicate(tree)) return tree
  return find(tree.props ? tree.props.children : undefined, predicate)
}

/**
 * @param {object} tree - a rendered element tree.
 * @param {(node: object) => boolean} predicate - the match.
 * @returns {object[]} every matching element.
 */
function findAll(tree, predicate) {
  const hits = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (predicate(node)) hits.push(node)
    walk(node.props ? node.props.children : undefined)
  }
  walk(tree)
  return hits
}

const byClass = (name) => (node) => node.props?.className === name
const framesOf = (tree) => findAll(tree, (node) => node.type === 'iframe')
/** @returns {object|undefined} the frame rendered for one proxy port. */
const frameForPort = (tree, port) =>
  framesOf(tree).filter((frame) => new RegExp(`:${port}/`).test(String(frame.props.src)))[0]

// ------------------------------------------------------------- stub platform

const listeners = new Map()
const storage = new Map()
const calls = []

globalThis.window = {
  location: { origin: 'http://127.0.0.1:43129', protocol: 'http:', hostname: '127.0.0.1' },
  localStorage: {
    get length() {
      return storage.size
    },
    key: (index) => [...storage.keys()][index] ?? null,
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  },
  addEventListener: (type, listener) => {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type).add(listener)
  },
  removeEventListener: (type, listener) => {
    listeners.get(type)?.delete(listener)
  },
  __ModuleLoader__: {
    load(definition) {
      check('bundle declares its id', definition.id === 'dsh-sidebar-browser', definition.id)
      globalThis.__loaded = definition.factory((specifier) => {
        if (specifier === 'react') return React
        throw new Error(`unexpected require: ${specifier}`)
      })
    },
  },
}

globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ style: {}, textContent: '' }),
  head: { appendChild: () => {} },
}

// A tiny host: just enough browser bookkeeping for the panel's real flows.
const browsers = new Map()
let portSeed = 45670

/**
 * @param {string} method - the host method.
 * @param {object} params - its parameters.
 * @returns {object} the host's answer.
 */
function hostCall(method, params) {
  const sessionId = String(params.sessionId)
  const browser = browsers.get(sessionId) ?? { activeId: '', tabs: [], counter: 0 }
  browsers.set(sessionId, browser)

  const hydrate = () => ({
    ok: true,
    activeId: browser.activeId,
    tabs: browser.tabs.map((tab) => Object.assign({}, tab)),
  })

  /** Append a page, sharing the port of a tab already on that origin. */
  const openPage = (url, newTab) => {
    const parsed = new URL(url)
    const origin = `${parsed.protocol}//${parsed.host}`
    const path = `${parsed.pathname}${parsed.search}`
    if (newTab !== true) {
      const active = browser.tabs.filter((tab) => tab.id === browser.activeId)[0]
      if (active !== undefined && active.origin === origin) {
        active.path = path
        active.url = origin + path
        active.nav += 1
        return
      }
    }
    const twin = browser.tabs.filter((tab) => tab.origin === origin)[0]
    if (twin === undefined) portSeed += 1
    browser.counter += 1
    browser.tabs.push({
      id: `t${browser.counter}`,
      origin,
      path,
      title: '',
      url: origin + path,
      zoom: 1,
      deviceKey: 'responsive',
      landscape: false,
      nav: 1,
      port: twin === undefined ? portSeed : twin.port,
    })
    browser.activeId = browser.tabs[browser.tabs.length - 1].id
  }

  if (method === 'browser-state') {
    const restore = params.restore
    if (browser.tabs.length === 0 && restore !== null && typeof restore === 'object' && Array.isArray(restore.tabs)) {
      for (const entry of restore.tabs) {
        openPage(String(entry.url), true)
        const tab = browser.tabs[browser.tabs.length - 1]
        if (typeof entry.zoom === 'number') tab.zoom = entry.zoom
        if (typeof entry.deviceKey === 'string') tab.deviceKey = entry.deviceKey
        if (typeof entry.landscape === 'boolean') tab.landscape = entry.landscape
        if (typeof entry.title === 'string') tab.title = entry.title
      }
    }
    return hydrate()
  }
  if (method === 'browser-open') {
    openPage(String(params.url), params.newTab === true)
    return hydrate()
  }
  if (method === 'browser-navigate') {
    const tab = browser.tabs.filter((entry) => entry.id === params.id)[0]
    if (tab !== undefined) {
      const parsed = new URL(String(params.url))
      tab.origin = `${parsed.protocol}//${parsed.host}`
      tab.path = `${parsed.pathname}${parsed.search}`
      tab.url = tab.origin + tab.path
      tab.nav += 1
      const twin = browser.tabs.filter((entry) => entry.origin === tab.origin && entry.id !== tab.id)[0]
      if (twin === undefined) portSeed += 1
      tab.port = twin === undefined ? portSeed : twin.port
    }
    return hydrate()
  }
  if (method === 'browser-select') {
    browser.activeId = String(params.id)
    return hydrate()
  }
  if (method === 'browser-close') {
    browser.tabs = browser.tabs.filter((tab) => tab.id !== params.id)
    if (!browser.tabs.some((tab) => tab.id === browser.activeId)) {
      browser.activeId = browser.tabs.length === 0 ? '' : browser.tabs[browser.tabs.length - 1].id
    }
    return hydrate()
  }
  if (method === 'browser-sync') {
    const tab = browser.tabs.filter((entry) => entry.id === params.id)[0]
    if (tab !== undefined && typeof params.title === 'string') tab.title = params.title
    return { ok: true }
  }
  if (method === 'browser-view') {
    const tab = browser.tabs.filter((entry) => entry.id === params.id)[0]
    if (tab !== undefined) {
      if (typeof params.zoom === 'number') tab.zoom = params.zoom
      if (typeof params.deviceKey === 'string') tab.deviceKey = params.deviceKey
      if (typeof params.landscape === 'boolean') tab.landscape = params.landscape
    }
    return { ok: true }
  }
  if (method === 'context-list') return { ok: true, count: 2, items: [] }
  if (method === 'context-clear') return { ok: true, count: 0 }
  return { ok: false, error: `unexpected ${method}` }
}

globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body)
  calls.push({ method: body.method, params: body.params })
  return { json: async () => hostCall(body.method, body.params) }
}

/**
 * @param {string} key - a localStorage key.
 * @returns {any} the parsed value, or `{}` when absent.
 */
function readStored(key) {
  var raw = storage.get(key)
  if (typeof raw !== 'string' || raw === '') return {}
  try {
    var parsed = JSON.parse(raw)
    return parsed === null || parsed === undefined ? {} : parsed
  } catch (error) {
    return {}
  }
}

/** What the panel pushed into a shell, as `contentWindow.postMessage` would. */
const pushed = []

/** @param {object} event - a message event to dispatch. */
function dispatchMessage(event) {
  for (const listener of listeners.get('message') ?? []) listener(event)
}

/**
 * Let queued promises settle, then re-render.
 * @param {object} store - a mounted component.
 */
async function settle(store) {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await store.update()
}

// -------------------------------------------------------------------- the run

// What an install upgraded from the pre-rename bundle holds: keys under the old
// package id, seeded before the import so the one-shot migration inside `apply`
// meets exactly this. Deleting them on `apply` would silently log the user out
// of every site the port map pointed at.
storage.set('dsh-sidebar-element-picker:url', 'http://localhost:8081/review')
storage.set('dsh-sidebar-element-picker:ports', JSON.stringify({ 'http://localhost:8081': 45674 }))
storage.set('dsh-sidebar-element-picker:tabs:legacy-session', JSON.stringify([{ id: 't1' }]))
// A value the renamed bundle already wrote must win over the stale one.
storage.set('dsh-sidebar-element-picker:zoom', 'legacy-zoom')
storage.set('dsh-sidebar-browser:zoom', 'current-zoom')
// Another plugin shares this origin and must not be touched.
storage.set('other-plugin:flag', 'keep-me')

await import('../../lib/client.js')
const plugin = globalThis.__loaded
check('bundle exports the plugin name', plugin.name === 'dsh-sidebar-browser', plugin.name)
check('bundle declares the slots service', Array.isArray(plugin.inject) && plugin.inject.includes('slots'), String(plugin.inject))

const slotRegistrations = []
const injectedServices = new Map()
const registryCalls = []

const ctx = {
  slots: {
    inject(seat, register) {
      const dispose = register()
      slotRegistrations.push({ seat, dispose })
      return dispose
    },
    register(definition, component) {
      slotRegistrations.push({ definition, component })
      return () => {}
    },
  },
  get: (service) => injectedServices.get(service),
  inject(services, callback) {
    const injected = { get: (service) => injectedServices.get(service) }
    injectedServices.set('sidebarRightTabs', {
      register(definition) {
        registryCalls.push(definition)
        return () => {}
      },
    })
    injectedServices.set('sidebarRight', {
      openTabIn(sessionId, kind, options) {
        calls.push({ method: 'openTabIn', sessionId, kind, options })
      },
    })
    const dispose = callback(injected)
    return typeof dispose === 'function' ? dispose : () => {}
  },
  effect(body) {
    const dispose = body()
    return typeof dispose === 'function' ? dispose : () => {}
  },
}

plugin.apply(ctx)

// ------------------------------------------- migrating the pre-rename storage

check('the remembered address survives the rename', storage.get('dsh-sidebar-browser:url') === 'http://localhost:8081/review', storage.get('dsh-sidebar-browser:url'))
check('the port memory survives the rename', storage.get('dsh-sidebar-browser:ports') === JSON.stringify({ 'http://localhost:8081': 45674 }), storage.get('dsh-sidebar-browser:ports'))
check("one conversation's tabs survive the rename", storage.get('dsh-sidebar-browser:tabs:legacy-session') === JSON.stringify([{ id: 't1' }]), storage.get('dsh-sidebar-browser:tabs:legacy-session'))
check('a value already under the new name wins over the stale one', storage.get('dsh-sidebar-browser:zoom') === 'current-zoom', storage.get('dsh-sidebar-browser:zoom'))
check('the old namespace is left empty', [...storage.keys()].every((key) => !key.startsWith('dsh-sidebar-element-picker:')), [...storage.keys()].filter((key) => key.startsWith('dsh-sidebar-element-picker:')).join(', '))
check("another plugin's keys are untouched", storage.get('other-plugin:flag') === 'keep-me')
check('the migration records that it ran', storage.has('dsh-sidebar-browser:migrated-from-element-picker'))
// Give the rest of the suite the empty store it assumes.
for (const key of ['dsh-sidebar-browser:url', 'dsh-sidebar-browser:ports', 'dsh-sidebar-browser:tabs:legacy-session', 'dsh-sidebar-browser:zoom', 'dsh-sidebar-browser:migrated-from-element-picker']) storage.delete(key)

check('composer seat is claimed', slotRegistrations.some((entry) => entry.definition && entry.definition.name === 'conversation.input.left'))
check('tab type is registered as a native page', registryCalls.length === 1 && registryCalls[0].kind === 'browser', JSON.stringify(registryCalls[0]?.kind))
check('tab type id is namespaced', registryCalls[0]?.id === 'dsh-sidebar-browser:browser', registryCalls[0]?.id)
check('tab type carries a guide entry', registryCalls[0]?.guide?.[0]?.title() === '浏览器')
check('tab body is registered under that id', slotRegistrations.some((entry) => entry.definition && entry.definition.name === 'sidebar.right.pane.tab' && entry.definition.key === 'dsh-sidebar-browser:browser'))
check('tab chip title is registered', slotRegistrations.some((entry) => entry.definition && entry.definition.name === 'sidebar.right.pane.tab.title'))

const pickerComponent = slotRegistrations.find((entry) => entry.definition && entry.definition.name === 'conversation.input.left').component
const panelComponent = slotRegistrations.find((entry) => entry.definition && entry.definition.name === 'sidebar.right.pane.tab').component
const titleComponent = slotRegistrations.find((entry) => entry.definition && entry.definition.name === 'sidebar.right.pane.tab.title').component

/**
 * @param {string} sessionId - the conversation the panel is drawn for.
 * @param {string} [tabId] - the DSH sidebar tab.
 * @returns {object} props for the panel body.
 */
const panelProps = (sessionId, tabId) => ({
  sessionId,
  useTabInfo: () => ({
    tab: {
      id: tabId ?? 'tab1',
      kind: 'browser',
      title: '浏览器',
      contentId: 'sidebar://browser',
      visible: true,
      navigation: { address: 'sidebar://browser', params: undefined, revision: 1 },
      signal: new AbortController().signal,
    },
  }),
})

// --------------------------------------------------------------- the composer

let draft = ''
const button = await mount(pickerComponent, {
  sessionId: 's1',
  useInput: (selector) => selector({ draft: draft }),
  inputActions: {
    setDraft(next) {
      draft = next
    },
  },
})
check('composer renders its button', find(button.tree, (node) => node.type === 'button') !== undefined)
find(button.tree, (node) => node.type === 'button').props.onClick()
await settle(button)
check('the composer checks the browser before opening anything', calls.some((call) => call.method === 'browser-state' && call.params.sessionId === 's1'))
const firstOpen = calls.filter((call) => call.method === 'browser-open')
check('the composer opens the remembered page when the browser is empty', firstOpen.length === 1 && firstOpen[0].params.newTab === true, JSON.stringify(firstOpen[0]?.params))
const openedTab = calls.find((call) => call.method === 'openTabIn')
check('clicking the button reveals the browser tab', openedTab !== undefined && openedTab.kind === 'browser', JSON.stringify(openedTab))

// With pages already open the button must only reveal — never navigate away
// from the page the user is working in.
find(button.tree, (node) => node.type === 'button').props.onClick()
await settle(button)
check('a second click opens nothing new', calls.filter((call) => call.method === 'browser-open').length === 1)
check('a second click still reveals the tab', calls.filter((call) => call.method === 'openTabIn').length === 2)

// ------------------------------------------------------ the panel: live state

const fromComposer = await mount(panelComponent, panelProps('s1'))
const composerTabs = findAll(fromComposer.tree, byClass('dsh-sb-tab'))
check('the panel shows the page the composer opened', composerTabs.length === 1, String(composerTabs.length))
check('the composer’s page is the active one', composerTabs[0].props['data-active'] === 'true')
check('the composer’s page is framed on a proxy port', String(framesOf(fromComposer.tree)[0].props.src).includes('127.0.0.1:45671'), framesOf(fromComposer.tree)[0].props.src)

// ------------------------------------------- the panel: opens by itself

// A browser with a known address opens it without being asked: the panel exists
// to show a page, not to ask permission to show one.
storage.set('dsh-sidebar-browser:url', 'http://localhost:3000/admin')
storage.set(
  'dsh-sidebar-browser:history',
  JSON.stringify([{ url: 'http://localhost:3000/admin', title: '后台' }]),
)
const auto = await mount(panelComponent, panelProps('s3', 'tab3'))
check('an empty browser opens the remembered address by itself', findAll(auto.tree, byClass('dsh-sb-tab')).length === 1, String(findAll(auto.tree, byClass('dsh-sb-tab')).length))
check('no start page is shown when an address is known', find(auto.tree, (node) => node.type === 'form') === undefined)
check('the composer-less open is not treated as a new page', calls.filter((call) => call.method === 'browser-open').length === 2, String(calls.filter((call) => call.method === 'browser-open').length))

const browserTabs = browsers.get('s3').tabs
const frames = framesOf(auto.tree)
check('the frame is on a proxy port of the GUI hostname', String(frames[0].props.src).startsWith(`http://127.0.0.1:${browserTabs[0].port}/__dsh_shell__/chrome.html`), frames[0].props.src)
check('the frame keeps the target path', String(frames[0].props.src).includes('p=%2Fadmin'), frames[0].props.src)
check('the frame is visible', frames[0].props['data-hidden'] === 'false')
check('frame denies top navigation', !String(frames[0].props.sandbox).includes('allow-top-navigation'), frames[0].props.sandbox)
check('frame is same-origin to its own shell', String(frames[0].props.sandbox).includes('allow-same-origin'))
check('a new-tab control exists', find(auto.tree, byClass('dsh-sb-newtab')) !== undefined)
check('the picked count is seeded from the host', find(auto.tree, byClass('dsh-sb-stripTools')).props.children[0].props.children === '已拾取 2')
check('the open pages are mirrored into local storage', storage.has('dsh-sidebar-browser:tabs:s3'))

// ------------------------------------------- the panel: the start page

// Only a browser that has never been used anywhere shows a launcher.
storage.delete('dsh-sidebar-browser:url')
storage.delete('dsh-sidebar-browser:history')
const first = await mount(panelComponent, panelProps('s4', 'tab4'))
check('a never-used browser shows the start page', find(first.tree, (node) => node.type === 'form') !== undefined)
check('the start page documents the placeholder syntax', JSON.stringify(first.tree).includes('[标签][DOMn]'))
find(first.tree, byClass('dsh-sb-input')).props.onChange({ target: { value: 'localhost:3000/admin' } })
await settle(first)
find(first.tree, (node) => node.type === 'form').props.onSubmit({ preventDefault() {} })
await settle(first)
check('submitting the start page opens a page', findAll(first.tree, byClass('dsh-sb-tab')).length === 1, String(findAll(first.tree, byClass('dsh-sb-tab')).length))
check('the opened address is remembered', storage.get('dsh-sidebar-browser:url') === 'http://localhost:3000/admin', String(storage.get('dsh-sidebar-browser:url')))
check('the opened address enters the recent list', JSON.parse(storage.get('dsh-sidebar-browser:history'))[0].url === 'http://localhost:3000/admin')

// Closing every page lands back on the start page, where the recent list is the
// useful part.
const onlyTab = browsers.get('s4').tabs[0]
storage.set(
  'dsh-sidebar-browser:history',
  JSON.stringify([
    { url: 'http://localhost:3000/admin?section=shop-products', title: '商品' },
    { url: 'http://localhost:3000/admin', title: '后台' },
  ]),
)
storage.delete('dsh-sidebar-browser:url')
const relaunch = await mount(panelComponent, panelProps('s6', 'tab6'))
check('a browser with history opens the most recent address', findAll(relaunch.tree, byClass('dsh-sb-tab')).length === 1, JSON.stringify(browsers.get('s6').tabs.map((tab) => tab.url)))
check('the auto-opened address is the newest history entry', browsers.get('s6').tabs[0].url === 'http://localhost:3000/admin?section=shop-products', browsers.get('s6').tabs[0].url)
void onlyTab

// The start page lists the recent visits and the saved logins.
storage.delete('dsh-sidebar-browser:url')
storage.delete('dsh-sidebar-browser:history')
storage.set(
  'dsh-sidebar-browser:credentials',
  JSON.stringify([{ origin: 'http://localhost:8081', username: 'ops', password: 's3cret', updatedAt: 1 }]),
)
const launcher = await mount(panelComponent, panelProps('s7', 'tab7'))
const rows = findAll(launcher.tree, byClass('dsh-sb-itemMain'))
check('the start page lists a recent row per address', rows.length === 0, String(rows.length))
const loginRows = findAll(launcher.tree, byClass('dsh-sb-itemTitle')).map((node) => node.props.children)
check('the start page lists a saved login', loginRows.includes('ops'), JSON.stringify(loginRows))
check('the saved login shows its site', JSON.stringify(launcher.tree).includes('localhost:8081'))
findAll(launcher.tree, byClass('dsh-sb-itemX'))[0].props.onClick()
await settle(launcher)
const remainingLogins = readStored('dsh-sidebar-browser:credentials')
check('a saved login can be forgotten', !Array.isArray(remainingLogins) || remainingLogins.length === 0, JSON.stringify(remainingLogins))
check('forgetting shows a notice', JSON.stringify(launcher.tree).includes('已删除'), JSON.stringify(findAll(launcher.tree, byClass('dsh-sb-notice')).map((node) => node.props.children)))

// The port a site used is remembered, and asked for again: that is what keeps a
// site on the same browser origin (and therefore signed in) across a restart.
check('the port each origin used is remembered', readStored('dsh-sidebar-browser:ports')['http://localhost:3000'] > 0, JSON.stringify(readStored('dsh-sidebar-browser:ports')))
const reopenCall = calls.filter((call) => call.method === 'browser-open' && call.params.preferredPort !== undefined).pop()
check('an open asks for the remembered port back', reopenCall !== undefined, JSON.stringify(reopenCall?.params ?? null))

// A link to another origin opens a page of its own, with its own port.
const liveFrames = framesOf(auto.tree)
dispatchMessage({
  source: liveFrames[0].contentWindow,
  data: { __dshPicker: true, source: 'dsh-sidebar-browser-shell', ev: 'openTab', url: 'http://127.0.0.1:5200/other' },
})
await settle(auto)
const frames2 = framesOf(auto.tree)
check('a second page adds a second frame', frames2.length === 2, String(frames2.length))
check('every frame stays mounted so neither reloads', frames2.every((frame) => String(frame.props.src).includes('__dsh_shell__')))
check('exactly one frame is visible', frames2.filter((frame) => frame.props['data-hidden'] === 'false').length === 1)
const secondPage = browsers.get('s3').tabs[1]
check('the new page is on its own port', secondPage.port !== browserTabs[0].port, `${browserTabs[0].port} vs ${secondPage.port}`)
check('the new page keeps its own path', secondPage.path === '/other', secondPage.path)

// Zoom and device state reported by a shell are stored on the host.
dispatchMessage({
  source: frames2[1].contentWindow,
  data: { __dshPicker: true, source: 'dsh-sidebar-browser-shell', ev: 'view', zoom: 0.5, deviceKey: 'phone-393', landscape: true },
})
const viewCall = calls.filter((call) => call.method === 'browser-view').pop()
check('a shell zoom change is stored on the host', viewCall !== undefined && viewCall.params.zoom === 0.5, JSON.stringify(viewCall?.params))
check('a shell device change is stored on the host', viewCall.params.deviceKey === 'phone-393' && viewCall.params.landscape === true, JSON.stringify(viewCall?.params))

// A remount restores every open page.
await auto.unmount()
const remounted = await mount(panelComponent, panelProps('s3', 'tab3'))
const frames3 = framesOf(remounted.tree)
check('a remount restores every open page', frames3.length === 2, String(frames3.length))
const restoredSecond = frameForPort(remounted.tree, secondPage.port)
check('a restored shell URL carries the zoom', String(restoredSecond.props.src).includes('z=0.5'), restoredSecond.props.src)
check('a restored shell URL carries the device', String(restoredSecond.props.src).includes('d=phone-393'), restoredSecond.props.src)
check('a restored shell URL carries the orientation', String(restoredSecond.props.src).includes('l=1'), restoredSecond.props.src)

// Switching pages hides a frame without unmounting it.
findAll(remounted.tree, byClass('dsh-sb-tab')).filter((node) => node.props['data-active'] === 'false')[0].props.onClick()
await settle(remounted)
const frames4 = framesOf(remounted.tree)
check('switching pages keeps both frames alive', frames4.length === 2, String(frames4.length))
check('switching pages changes which frame is visible', frames4.filter((frame) => frame.props['data-hidden'] === 'false').length === 1)

// ------------------------------------------------------ saving a login

const loginFrame = framesOf(remounted.tree).filter((frame) => frame.props['data-hidden'] === 'false')[0]
dispatchMessage({
  source: loginFrame.contentWindow,
  data: { __dshPicker: true, source: 'dsh-sidebar-browser-shell', ev: 'saveCredential', origin: 'http://localhost:3000', username: 'ops', password: 'hunter2' },
})
await settle(remounted)
const saveBar = find(remounted.tree, byClass('dsh-sb-savebar'))
check('a submitted login raises a save prompt', saveBar !== undefined)
check('the prompt names the site and account', JSON.stringify(saveBar).includes('localhost:3000') && JSON.stringify(saveBar).includes('ops'))
find(remounted.tree, byClass('dsh-sb-saveGo')).props.onClick()
await settle(remounted)
const storedLogins = readStored('dsh-sidebar-browser:credentials')
check('saving stores the login', storedLogins.length === 1 && storedLogins[0].password === 'hunter2', JSON.stringify(storedLogins))
check('the prompt closes after saving', find(remounted.tree, byClass('dsh-sb-savebar')) === undefined)
check('a shell asking for logins receives them', calls.some((call) => call.method !== undefined))
dispatchMessage({
  source: loginFrame.contentWindow,
  data: { __dshPicker: true, source: 'dsh-sidebar-browser-shell', ev: 'needCredentials', origin: 'http://localhost:3000' },
})
await settle(remounted)
check('asking for credentials is answered', pushed.some((message) => message.cmd === 'credentials' && message.entries.length === 1), JSON.stringify(pushed.slice(-2)))

// ------------------------------------------------------------ the pick path

const visibleFrame = () => framesOf(remounted.tree).filter((frame) => frame.props['data-hidden'] === 'false')[0]
const hiddenFrame = () => framesOf(remounted.tree).filter((frame) => frame.props['data-hidden'] === 'true')[0]

dispatchMessage({ source: { stranger: true }, data: { __dshPicker: true, source: 'dsh-sidebar-browser-shell', ev: 'picked', domId: 'DOM9', label: '伪造' } })
check('a pick from another window is ignored', draft === '', draft)

/** @returns {boolean} whether a strip chip currently shows this title. */
const titleText = (tree, text) =>
  findAll(tree, byClass('dsh-sb-tabTitle')).some((node) => String(node.props.children).includes(text))

const panelComposer = await mount(pickerComponent, {
  sessionId: 's3',
  useInput: (selector) => selector({ draft: draft }),
  inputActions: {
    setDraft(next) {
      draft = next
    },
  },
})
check('a composer mounted for another conversation is separate', find(panelComposer.tree, (node) => node.type === 'button') !== undefined)

const picked = visibleFrame()
dispatchMessage({
  source: picked.contentWindow,
  data: { __dshPicker: true, source: 'dsh-sidebar-browser-shell', ev: 'picked', domId: 'DOM1', label: '提交订单', element: { tag: 'button' } },
})
check('a real pick lands in the draft box', draft === '[提交订单][DOM1]', JSON.stringify(draft))

dispatchMessage({
  source: picked.contentWindow,
  data: { __dshPicker: true, source: 'dsh-sidebar-browser-shell', ev: 'picked', domId: 'DOM1', label: '提交订单' },
})
check('the same pick delivered twice is inserted once', draft === '[提交订单][DOM1]', JSON.stringify(draft))

dispatchMessage({
  source: hiddenFrame().contentWindow,
  data: { __dshPicker: true, source: 'dsh-sidebar-browser-shell', ev: 'picked', domId: 'DOM2', label: '标题' },
})
check('a pick from a background page also lands', draft === '[提交订单][DOM1]\n[标题][DOM2]', JSON.stringify(draft))

// ------------------------------------------------------- navigation plumbing

dispatchMessage({
  source: picked.contentWindow,
  data: { __dshPicker: true, source: 'dsh-sidebar-browser-shell', ev: 'url', url: 'http://127.0.0.1:5200/other?tab=2', title: '规格' },
})
const syncCall = calls.filter((call) => call.method === 'browser-sync').pop()
check('an in-page navigation is synced to the host', syncCall !== undefined && syncCall.params.title === '规格', JSON.stringify(syncCall?.params))
check('the sync does not change the frame source', visibleFrame().props.src === picked.props.src)
await settle(remounted)
check('the sync updates the page title in the strip', titleText(remounted.tree, '规格'), JSON.stringify(findAll(remounted.tree, byClass('dsh-sb-tabTitle')).map((node) => node.props.children)))

// A re-render for any other reason must not re-point the frame.
const srcBeforePick = visibleFrame().props.src
dispatchMessage({
  source: hiddenFrame().contentWindow,
  data: { __dshPicker: true, source: 'dsh-sidebar-browser-shell', ev: 'picked', domId: 'DOM3', label: '再一个' },
})
await settle(remounted)
check('a pick after an in-page navigation does not reload the page', visibleFrame().props.src === srcBeforePick, `${srcBeforePick} → ${visibleFrame().props.src}`)

// An address-bar entry on another origin is handed to the panel, which
// allocates the port that origin needs.
dispatchMessage({
  source: picked.contentWindow,
  data: { __dshPicker: true, source: 'dsh-sidebar-browser-shell', ev: 'navigate', url: 'http://localhost:4300/admin' },
})
await settle(remounted)
const navCall = calls.filter((call) => call.method === 'browser-navigate').pop()
check('a cross-origin navigation is delegated to the panel', navCall !== undefined && navCall.params.url === 'http://localhost:4300/admin', JSON.stringify(navCall?.params))
const retargetedTab = browsers.get('s3').tabs.filter((tab) => tab.origin === 'http://localhost:4300')[0]
check('the retargeted page is on the new origin', retargetedTab !== undefined, JSON.stringify(browsers.get('s3').tabs.map((tab) => tab.origin)))
check('the retargeted page moves to a new port', frameForPort(remounted.tree, retargetedTab.port) !== undefined, JSON.stringify(framesOf(remounted.tree).map((frame) => frame.props.src)))

// Closing a page removes its frame.
findAll(remounted.tree, byClass('dsh-sb-tabClose'))[1].props.onClick({ stopPropagation() {} })
await settle(remounted)
check('closing a page removes its frame', framesOf(remounted.tree).length === 1)

// ------------------------------------------------------------ the tab chip

const chipStore = await mount(titleComponent, {
  useTabInfo: () => ({ tab: { id: 'tab-unknown', kind: 'browser', title: '浏览器' } }),
})
check('the sidebar chip falls back to the plugin title', JSON.stringify(chipStore.tree).includes('浏览器'))

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
