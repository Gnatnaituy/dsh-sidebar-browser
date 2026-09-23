/**
 * Integration test for the host half, with DSH's three services stubbed.
 *
 * Drives the real plugin body: the `/invoke` route, the `/__dsh_shell__/pick`
 * sink on a real proxy port, the recorded context, the `read_picked_element`
 * tool and the system-prompt block. Run with `node resources/test/host-smoke.mjs
 * [target-origin]`.
 */
import http from 'node:http'
import { apply, name, inject } from '../../lib/index.js'
import { startFixtureTarget } from './fixture.mjs'

const fixture = process.argv[2] === undefined ? await startFixtureTarget() : undefined
const target = process.argv[2] ?? fixture.origin
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

/** The routes the plugin registered, and the effects it asked to keep. */
const routes = new Map()
const effects = []
const tools = new Map()
const prompts = new Map()

/** A DSH-shaped context over the three stubs. */
const ctx = {
  get(service) {
    if (service === 'webServer') {
      return {
        register(route) {
          if (routes.has(route.path)) throw new Error(`duplicate ${route.path}`)
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      }
    }
    if (service === 'tools') {
      return {
        register(definition) {
          tools.set(definition.name, definition)
          return () => tools.delete(definition.name)
        },
      }
    }
    if (service === 'systemPrompt') {
      return {
        context(contribution) {
          prompts.set(contribution.name, contribution)
          return () => prompts.delete(contribution.name)
        },
      }
    }
    throw new Error(`unexpected service: ${service}`)
  },
  effect(body) {
    const dispose = body()
    effects.push(dispose)
    return dispose
  },
}

check('plugin declares its name', name === 'dsh-sidebar-browser', name)
check('plugin declares its services', inject.includes('webServer') && inject.includes('tools'), inject.join(','))

apply(ctx)

// The registered handler is exercised through a real HTTP server, so the
// request/response shapes are the ones DSH would hand it.
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname
  const route = routes.get(pathname)
  if (route === undefined) {
    res.writeHead(404).end()
    return
  }
  route.handler(req, res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const dshPort = server.address().port

/**
 * @param {string} method - the host method.
 * @param {object} params - its parameters.
 * @returns {Promise<object>} the answer.
 */
async function invoke(method, params) {
  const response = await fetch(`http://127.0.0.1:${dshPort}/dsh-sidebar-browser/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  })
  return response.json()
}

check('invoke route registered', routes.has('/dsh-sidebar-browser/invoke'))
check('tool registered', tools.has('read_picked_element'))
check('prompt context registered', prompts.has('dsh-sidebar-browser'))

const unknown = await invoke('nope', {})
check('unknown method is refused', unknown.ok === false, JSON.stringify(unknown))

const opened = await invoke('browser-open', { sessionId: 's1', url: `${target}/admin/articles/10/edit` })
check('browser-open opens a tab', opened.ok === true && opened.tabs.length === 1, JSON.stringify(opened).slice(0, 160))
check('the tab keeps the target path', opened.tabs[0].path === '/admin/articles/10/edit', opened.tabs[0].path)
check('the tab reports its target origin', opened.tabs[0].origin === new URL(target).origin, opened.tabs[0].origin)
check('the tab is active', opened.activeId === opened.tabs[0].id, opened.activeId)
const port1 = opened.tabs[0].port
check('the tab got a proxy port', port1 > 0, String(port1))

const shell = await fetch(`http://127.0.0.1:${port1}/__dsh_shell__/chrome.html`)
check('shell page served on the allocated port', shell.status === 200, `status ${shell.status}`)
const cookie = (shell.headers.get('set-cookie') ?? '').split(';')[0]
check('shell mints the capability cookie', cookie.startsWith('dsh_picker_'), cookie)

const picked = await fetch(`http://127.0.0.1:${port1}/__dsh_shell__/pick`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({
    tag: 'button',
    id: 'submit-order',
    classes: ['btn', 'primary'],
    text: '提交订单',
    selector: '#submit-order',
    domPath: 'body > form > button',
    boundingRect: { left: 12, top: 40, width: 120, height: 32 },
    pageUrl: `${target}/admin/articles/10/edit`,
    outerHTML: '<button id="submit-order">提交订单</button>',
  }),
})
const pickAnswer = await picked.json()
check('pick is recorded and numbered', pickAnswer.ok === true && pickAnswer.domId === 'DOM1', JSON.stringify(pickAnswer))
check('pick gets its label from the text', pickAnswer.label === '提交订单', pickAnswer.label)

const listed = await invoke('context-list', { sessionId: 's1' })
check('context-list sees the pick', listed.ok === true && listed.count === 1, JSON.stringify(listed))

const read = tools.get('read_picked_element').execute({ id: 'DOM1' })
check('tool returns the element', read.ok === true && read.element.selector === '#submit-order', JSON.stringify(read).slice(0, 120))
const missing = tools.get('read_picked_element').execute({ id: 'DOM9' })
check('tool reports an unknown number', missing.ok === false, JSON.stringify(missing))

const summary = prompts.get('dsh-sidebar-browser').text()
check('prompt lists the element', summary.includes('DOM1=') && summary.includes('提交订单'), summary.split('\n')[1])
check('prompt names the tool', summary.includes('read_picked_element'))

// A second page on another origin gets its own port, so the two sites cannot
// share cookies or web storage.
const second = await invoke('browser-open', { sessionId: 's1', url: 'http://127.0.0.1:9/other', newTab: true })
check('a second tab is appended and activated', second.ok === true && second.tabs.length === 2 && second.activeId === second.tabs[1].id, JSON.stringify(second).slice(0, 200))
check('a second origin gets its own port', second.tabs[1].port > 0 && second.tabs[1].port !== port1, `${port1} vs ${second.tabs[1].port}`)

const sameOriginTab = await invoke('browser-open', { sessionId: 's1', url: `${target}/admin?section=shop-products`, newTab: true })
check('a tab on the first origin reuses its port', sameOriginTab.tabs[2].port === port1, `${port1} vs ${sameOriginTab.tabs[2].port}`)
check('three tabs are listed', sameOriginTab.tabs.length === 3, String(sameOriginTab.tabs.length))

const selected = await invoke('browser-select', { sessionId: 's1', id: sameOriginTab.tabs[0].id })
check('browser-select switches the active tab', selected.activeId === sameOriginTab.tabs[0].id, selected.activeId)

const synced = await invoke('browser-sync', { sessionId: 's1', id: sameOriginTab.tabs[0].id, url: `${target}/admin/deep`, title: '规格' })
check('browser-sync stores the path and title', synced.ok === true, JSON.stringify(synced))
const afterSync = await invoke('browser-state', { sessionId: 's1' })
check('the synced title is kept', afterSync.tabs[0].title === '规格', afterSync.tabs[0].title)
check('the synced path is kept', afterSync.tabs[0].path === '/admin/deep', afterSync.tabs[0].path)

const navBefore = (await invoke('browser-state', { sessionId: 's1' })).tabs[0].nav
const syncedAgain = await invoke('browser-sync', { sessionId: 's1', tabId: undefined, id: sameOriginTab.tabs[0].id, url: `${target}/admin/deeper`, title: '更深' })
const navAfterSync = (await invoke('browser-state', { sessionId: 's1' })).tabs[0].nav
check('a shell sync does not count as a navigation', syncedAgain.ok === true && navAfterSync === navBefore, `${navBefore} → ${navAfterSync}`)

const navigated = await invoke('browser-navigate', { sessionId: 's1', id: sameOriginTab.tabs[0].id, url: `${target}/admin/deepest` })
check('an explicit navigation bumps the counter', navigated.ok === true && navigated.tabs[0].nav > navAfterSync, `${navAfterSync} → ${navigated.tabs[0].nav}`)
check('an explicit same-origin navigation keeps the port', navigated.tabs[0].port === port1, `${port1} vs ${navigated.tabs[0].port}`)
check('an explicit same-origin navigation moves the path', navigated.tabs[0].path === '/admin/deepest', navigated.tabs[0].path)

const viewed = await invoke('browser-view', { sessionId: 's1', id: sameOriginTab.tabs[0].id, zoom: 0.5, deviceKey: 'phone-393', landscape: true })
check('browser-view stores the preview', viewed.ok === true, JSON.stringify(viewed))
const afterView = await invoke('browser-state', { sessionId: 's1' })
check('zoom survives a state read', afterView.tabs[0].zoom === 0.5, String(afterView.tabs[0].zoom))
check('device survives a state read', afterView.tabs[0].deviceKey === 'phone-393', afterView.tabs[0].deviceKey)
check('orientation survives a state read', afterView.tabs[0].landscape === true)

// Closing a tab releases its port only when its origin is no longer in use.
const closed = await invoke('browser-close', { sessionId: 's1', id: sameOriginTab.tabs[1].id })
check('closing a tab drops it from the list', closed.ok === true && closed.tabs.length === 2, JSON.stringify(closed).slice(0, 160))
const portGone = await fetch(`http://127.0.0.1:${second.tabs[1].port}/__dsh_shell__/chrome.html`).then(() => true).catch(() => false)
check('the freed origin\'s port is closed', portGone === false)
const sharedStillUp = await fetch(`http://127.0.0.1:${port1}/__dsh_shell__/chrome.html`, { headers: { cookie } })
check('an origin still in use keeps its port', sharedStillUp.status === 200, `status ${sharedStillUp.status}`)

// A restore snapshot rebuilds a browser after a DSH restart.
const restored = await invoke('browser-state', {
  sessionId: 's2',
  restore: { activeId: 'x2', tabs: [{ id: 'x1', url: `${target}/a`, zoom: 1.5 }, { id: 'x2', url: `${target}/b`, deviceKey: 'tablet-820' }] },
})
check('a snapshot restores the pages', restored.ok === true && restored.tabs.length === 2, JSON.stringify(restored).slice(0, 200))
check('a restored page gets a port', restored.tabs[0].port > 0, String(restored.tabs[0].port))
check('a restored zoom is kept', restored.tabs[0].zoom === 1.5, String(restored.tabs[0].zoom))
check('a restored device is kept', restored.tabs[1].deviceKey === 'tablet-820', restored.tabs[1].deviceKey)
check('a restored active id maps to a real tab', restored.activeId === restored.tabs[1].id, restored.activeId)
const liveWins = await invoke('browser-state', { sessionId: 's1', restore: { tabs: [{ url: 'http://127.0.0.1:9/ignored' }] } })
check('live state beats a stale snapshot', liveWins.tabs.length === 2, String(liveWins.tabs.length))

// A port that an origin used before is honoured when it is free, which is what
// keeps a target on the same browser origin across a restart — and therefore
// keeps the app's cookies and web storage.
const beforeRestart = (await invoke('browser-open', { sessionId: 's9', url: `${target}/deep/page` })).tabs[0].port
await invoke('browser-close', { sessionId: 's9', all: true })
const afterRestart = await invoke('browser-open', { sessionId: 's9', url: `${target}/deep/page`, preferredPort: beforeRestart })
check('a freed port is reused when it is preferred', afterRestart.tabs[0].port === beforeRestart, `${beforeRestart} → ${afterRestart.tabs[0].port}`)

const taken = await invoke('browser-open', { sessionId: 's9', url: 'http://127.0.0.1:9/elsewhere', newTab: true, preferredPort: beforeRestart })
check('a busy preferred port falls back instead of failing', taken.ok === true && taken.tabs[1].port > 0, JSON.stringify(taken).slice(0, 120))
check('the fallback port differs from the busy one', taken.tabs[1].port !== beforeRestart, `${beforeRestart} vs ${taken.tabs[1].port}`)

const gated = await fetch(`http://127.0.0.1:${port1}/admin`)
check('proxied content needs the capability cookie', gated.status === 403, `status ${gated.status}`)

const proxied = await fetch(`http://127.0.0.1:${port1}/deep/page?x=1`, { headers: { cookie } })
check('the target path proxies', proxied.status === 200, `status ${proxied.status}`)
check('the proxied page is the target document', (await proxied.text()).includes('<html'))

const cleared = await invoke('context-clear', { sessionId: 's1' })
check('context-clear empties the list', cleared.ok === true && cleared.count === 0, JSON.stringify(cleared))
check('prompt goes quiet after clearing', prompts.get('dsh-sidebar-browser').text() === '')

const status = await invoke('browser-status', { sessionId: 's1' })
check('browser-status reports the open pages', status.ok === true && status.running === true && status.count === 2, JSON.stringify(status))
const closedAll = await invoke('browser-close', { sessionId: 's1', all: true })
check('browser-close all empties the browser', closedAll.ok === true && closedAll.tabs.length === 0, JSON.stringify(closedAll))
const afterClose = await invoke('browser-status', { sessionId: 's1' })
check('status is empty after closing everything', afterClose.ok === false && afterClose.running === false, JSON.stringify(afterClose))

for (const dispose of effects.reverse()) {
  if (typeof dispose === 'function') dispose()
}
server.close()
fixture?.close()
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
