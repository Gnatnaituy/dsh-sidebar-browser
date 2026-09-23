/**
 * End-to-end browser test: a real Chromium loads a page that embeds the shell
 * exactly the way the sidebar panel does, browses the real target through the
 * proxy, previews it at phone and tablet widths, zooms it, opens another page,
 * and picks an element.
 *
 * This is the only test that exercises `resources/chrome.js` — the same-origin
 * DOM read-back, the highlight, the capture-phase click interception, the zoom
 * transform and the pick POST — inside an actual browser. It needs the
 * `playwright-core` runtime the previous picker installed, plus any Chromium:
 *
 *   node resources/test/browser-e2e.mjs [target-origin]
 */
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ProxySession, mintToken } from '../proxy.js'
import { loadPlaywright, browserLaunchOptions } from './driver.mjs'
import { startFixtureTarget } from './fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const resources = join(here, '..')
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

const { chromium } = loadPlaywright()

const assets = {}
for (const [name, type] of [
  ['chrome.html', 'text/html; charset=utf-8'],
  ['chrome.css', 'text/css; charset=utf-8'],
  ['chrome.js', 'application/javascript; charset=utf-8'],
]) {
  assets[name] = { body: await readFile(join(resources, name)), type }
}

/** Picks as the simulated panel would have received them. */
const received = []

const session = new ProxySession({
  token: mintToken(),
  assets,
  onPick: (payload) => {
    received.push(payload)
    return { ok: true, domId: `DOM${received.length}`, label: payload.text ?? payload.tag }
  },
  log: (level, message) => console.log(`    [${level}] ${message}`),
})
await session.start()
session.setTarget(target)

// Stand in for the DSH GUI: an ordinary page that frames the shell and relays
// its messages, exactly as `BrowserPanel` does.
const panel = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><meta charset="utf-8"><title>panel</title>
<style>html,body{margin:0;height:100%}iframe{width:100%;height:100vh;border:0}</style>
<iframe id="shell" src="http://127.0.0.1:${session.port}/__dsh_shell__/chrome.html" sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-downloads"></iframe>
<script>
  window.picks = [];
  window.shellState = {};
  window.shellViews = [];
  window.shellOpens = [];
  window.shellNavigates = [];
  window.shellSaves = [];
  window.shellAsks = [];
  addEventListener('message', function (event) {
    if (event.source !== document.getElementById('shell').contentWindow) return;
    var data = event.data;
    if (!data || data.__dshPicker !== true) return;
    if (data.ev === 'picked') window.picks.push(data);
    else if (data.ev === 'view') window.shellViews.push(data);
    else if (data.ev === 'openTab') window.shellOpens.push(data.url);
    else if (data.ev === 'navigate') window.shellNavigates.push(data.url);
    else if (data.ev === 'saveCredential') window.shellSaves.push(data);
    else if (data.ev === 'needCredentials') {
      window.shellAsks.push(data.origin);
      event.source.postMessage({
        __dshPicker: true,
        source: 'dsh-sidebar-browser',
        cmd: 'credentials',
        entries: [{ origin: data.origin, username: 'saved-user', password: 'saved-pass' }]
      }, '*');
    } else window.shellState[data.ev] = data;
  });
</script>`)
})
await new Promise((resolve) => panel.listen(0, '127.0.0.1', resolve))
const panelPort = panel.address().port

const browser = await chromium.launch({ ...browserLaunchOptions(), headless: true })
const page = await browser.newPage()
page.on('console', (message) => {
  if (message.type() === 'error') console.log(`    [page error] ${message.text()}`)
})
await page.goto(`http://127.0.0.1:${panelPort}/`)

const shell = page.frameLocator('#shell')
const site = shell.frameLocator('#site')
/** @returns {object|undefined} the shell's own frame. */
const shellFrame = () => page.frames().find((frame) => frame.url().includes('/__dsh_shell__/chrome.html'))

await shell.locator('#url').waitFor({ timeout: 15000 })
check('shell rendered inside the panel frame', true)
check('shell reports itself ready', (await page.evaluate(() => Object.keys(window.shellState))).includes('ready'))

// Type the target and open it, the way a user would. `localhost:3000` without a
// scheme is the placeholder's own example and must be understood.
await shell.locator('#url').fill(target.replace(/^https?:\/\//, ''))
await shell.locator('#url').press('Enter')
await page.waitForFunction(() => window.shellState.url !== undefined, undefined, { timeout: 20000 }).catch(() => {})
const reportedUrl = await page.evaluate(() => window.shellState.url && window.shellState.url.url)
check('a scheme-less address is understood', String(reportedUrl).startsWith('http'), reportedUrl)
check('shell reports the target URL, not the proxy URL', String(reportedUrl).startsWith(target), reportedUrl)

await site.locator('body').first().waitFor({ timeout: 20000 }).catch(() => {})
const sameOrigin = await shellFrame().evaluate(() => {
  const frame = document.getElementById('site')
  try {
    return frame.contentDocument !== null && frame.contentDocument.body !== null
  } catch (error) {
    return false
  }
})
check('shell can read the inspected document (same origin)', sameOrigin)
const bodyText = await site.locator('body').innerText().catch(() => '')
check('the real target rendered through the proxy', bodyText.length > 0, `${bodyText.length} chars`)

// ---------------------------------------------------------- device preview

/**
 * @param {string} key - a device preset value.
 */
async function pickDevice(key) {
  await shell.locator('#device').selectOption(key)
  await page.waitForTimeout(300)
}

await pickDevice('phone-393')
const phone = await shellFrame().evaluate(() => {
  const frame = document.getElementById('site')
  return {
    width: frame.contentWindow.innerWidth,
    narrow: frame.contentWindow.matchMedia('(max-width: 420px)').matches,
    probe: frame.contentDocument.getElementById('mq')?.textContent ?? '(no probe)',
    size: document.getElementById('size').textContent,
    framed: document.getElementById('canvas').classList.contains('hasFrame'),
  }
})
check('phone preview gives the page a phone-width viewport', Math.abs(phone.width - 393) <= 1, String(phone.width))
check('phone preview fires the page’s media queries', phone.narrow === true)
check('the page itself observes the narrow viewport', phone.probe === 'phone', String(phone.probe))
check('phone preview shows a device frame and its size', phone.framed === true && phone.size === '393×852', `${phone.framed} ${phone.size}`)

await pickDevice('tablet-834')
const tablet = await shellFrame().evaluate(() => {
  const frame = document.getElementById('site')
  return {
    width: frame.contentWindow.innerWidth,
    narrow: frame.contentWindow.matchMedia('(max-width: 420px)').matches,
    size: document.getElementById('size').textContent,
  }
})
check('tablet preview gives the page a tablet-width viewport', Math.abs(tablet.width - 834) <= 1, String(tablet.width))
check('tablet preview stops matching the phone query', tablet.narrow === false)
check('tablet preview reports its own size', tablet.size === '834×1194', tablet.size)

await shell.locator('#rotate').click()
await page.waitForTimeout(300)
const rotated = await shellFrame().evaluate(() => ({
  width: document.getElementById('site').contentWindow.innerWidth,
  size: document.getElementById('size').textContent,
}))
check('rotating swaps the preview box', rotated.size === '1194×834' && Math.abs(rotated.width - 1194) <= 1, `${rotated.size} ${rotated.width}`)

// ------------------------------------------------------------------- zoom

check('the page observes a wide viewport again', (await site.locator('#mq').innerText()) === 'desktop')

await pickDevice('responsive')
await shell.locator('#zoom').selectOption('0.5')
await page.waitForTimeout(300)
const zoomedOut = await shellFrame().evaluate(() => {
  const frame = document.getElementById('site')
  const canvas = document.getElementById('canvas')
  const viewport = document.getElementById('viewport')
  return {
    width: frame.contentWindow.innerWidth,
    canvas: canvas.clientWidth,
    transform: getComputedStyle(viewport).transform,
  }
})
check('zooming out widens the page’s layout viewport', zoomedOut.width > zoomedOut.canvas * 1.5, JSON.stringify(zoomedOut))
check('the preview box is scaled instead of resized', /matrix\(0\.5/.test(zoomedOut.transform), zoomedOut.transform)
check('the zoom select shows the chosen stop', (await shell.locator('#zoom').inputValue()) === '0.5')

await shell.locator('#zoomIn').click()
await page.waitForTimeout(250)
check('the zoom-in button steps up a stop', (await shell.locator('#zoom').inputValue()) !== '0.5')
await shell.locator('#fitWidth').click()
await page.waitForTimeout(250)
check('fit width resets a responsive viewport', (await shell.locator('#zoom').inputValue()) === '1')

const viewEvents = await page.evaluate(() => window.shellViews)
check('the shell reports its preview to the panel', viewEvents.some((event) => event.deviceKey === 'phone-393'), JSON.stringify(viewEvents.slice(0, 3)))
check('the shell reports rotation to the panel', viewEvents.some((event) => event.landscape === true))

// -------------------------------------------------------------- navigation

// Same origin: navigated in place, with no request for a new port.
await shell.locator('#url').fill(`${target}/admin`)
await shell.locator('#url').press('Enter')
await page.waitForTimeout(800)
const inPlace = await page.evaluate(() => window.shellNavigates.length)
check('a same-origin address is navigated in place', inPlace === 0, String(inPlace))

// Another origin: the shell cannot show it, so the panel must allocate a port.
await shell.locator('#url').fill('http://localhost:4300/somewhere')
await shell.locator('#url').press('Enter')
await page.waitForFunction(() => window.shellNavigates.length > 0, undefined, { timeout: 8000 }).catch(() => {})
const navigates = await page.evaluate(() => window.shellNavigates)
check('a cross-origin address is handed to the panel', navigates[0] === 'http://localhost:4300/somewhere', JSON.stringify(navigates))

// The new-tab control is the same handoff.
await shell.locator('#url').fill(`${target}/admin?section=shop-products`)
await shell.locator('#open').click()
await page.waitForFunction(() => window.shellOpens.length > 0, undefined, { timeout: 8000 }).catch(() => {})
const opens = await page.evaluate(() => window.shellOpens)
check('the new-tab control asks the panel for a page', String(opens[0]).startsWith(target), JSON.stringify(opens))

// Back to the main page for the pick.
await shell.locator('#url').fill(target)
await shell.locator('#url').press('Enter')
await page.waitForTimeout(800)

// ----------------------------------------------------- picking, under preview

// Arm at phone width: the highlight and the recorded rectangle must still line
// up once the frame is a transformed, narrower box.
await pickDevice('phone-393')
await shell.locator('#pick').click()
await page
  .waitForFunction(() => window.shellState.armed !== undefined && window.shellState.armed.armed === true, undefined, { timeout: 10000 })
  .catch(() => {})
check('arming is reflected in the shell', (await page.evaluate(() => window.shellState.armed && window.shellState.armed.armed)) === true)

const clickable = site.locator('a, button, h1, h2, td, span, label, input').first()
await clickable.waitFor({ timeout: 20000 })
const clickedText = await clickable.innerText().catch(() => '')
await clickable.hover()
const highlight = await shellFrame().evaluate(() => {
  const overlay = document.getElementById('overlay')
  const box = document.getElementById('box')
  const frame = document.getElementById('site')
  const rect = frame.getBoundingClientRect()
  const boxRect = box.getBoundingClientRect()
  return {
    visible: overlay.hidden === false,
    insideFrame: boxRect.left >= rect.left - 2 && boxRect.right <= rect.right + 2 && boxRect.top >= rect.top - 2,
  }
})
check('hovering draws the highlight over the frame', highlight.visible)
check('the highlight stays inside a zoomed, device-sized frame', highlight.insideFrame, JSON.stringify(highlight))

await clickable.click()
await page.waitForFunction(() => window.picks.length > 0, undefined, { timeout: 15000 }).catch(() => {})
const picked = await page.evaluate(() => window.picks[0] ?? null)
check('clicking an element reaches the panel as a pick', picked !== null, JSON.stringify(picked).slice(0, 160))
check('the pick records the device-width viewport', Math.abs(picked?.element?.viewport?.width - 393) <= 1, String(picked?.element?.viewport?.width))
check('the pick carries a CSS selector', typeof picked?.element?.selector === 'string' && picked.element.selector !== '', picked?.element?.selector)
check('the pick carries the real page URL', String(picked?.element?.pageUrl).startsWith(target), picked?.element?.pageUrl)
check('the pick carries the element HTML', typeof picked?.element?.outerHTML === 'string' && picked.element.outerHTML.length > 0)
check('the pick carries its box', typeof picked?.element?.boundingRect?.width === 'number')
check(
  'the pick names an element inside the one under the cursor',
  clickedText.trim() === '' || clickedText.includes(String(picked?.element?.text)),
  `${JSON.stringify(clickedText.slice(0, 24))} vs ${JSON.stringify(picked?.element?.text)}`,
)
check('the host received the same pick', received.length === 1, `${received.length} pick(s)`)
await page
  .waitForFunction(() => window.shellState.armed !== undefined && window.shellState.armed.armed === false, undefined, { timeout: 10000 })
  .catch(() => {})
check('picking disarms itself', (await page.evaluate(() => window.shellState.armed && window.shellState.armed.armed)) === false)

// ------------------------------------------------- saved logins

await shell.locator('#url').fill(`${target}/login`)
await shell.locator('#url').press('Enter')
await site.locator('#login').waitFor({ timeout: 20000 })

// The shell asks the panel for this origin's logins, and fills the form itself.
await page.waitForFunction(() => window.shellAsks.length > 0, undefined, { timeout: 8000 }).catch(() => {})
check('the shell asks the panel for saved logins', (await page.evaluate(() => window.shellAsks)).length > 0, JSON.stringify(await page.evaluate(() => window.shellAsks)))
await page.waitForFunction(() => document.getElementById('pass') !== null, undefined, { timeout: 8000 }).catch(() => {})
const filled = await shellFrame().evaluate(() => {
  const frame = document.getElementById('site')
  const doc = frame.contentDocument
  return { user: doc.getElementById('user').value, pass: doc.getElementById('pass').value }
})
check('a saved login is filled into the page', filled.user === 'saved-user' && filled.pass === 'saved-pass', JSON.stringify(filled))

// Submitting a different set offers the panel the new pair — without stopping
// the app's own submit handler.
await site.locator('#user').fill('ops')
await site.locator('#pass').fill('hunter2')
await site.locator('#sign-in').click()
await page.waitForFunction(() => window.shellSaves.length > 0, undefined, { timeout: 8000 }).catch(() => {})
const saved = await page.evaluate(() => window.shellSaves[0] ?? null)
check('a submitted login is offered to the panel', saved !== null && saved.username === 'ops' && saved.password === 'hunter2', JSON.stringify(saved))
check('capturing a login does not block the submit', (await site.locator('#signed').innerText()) === 'signed in as ops', await site.locator('#signed').innerText())

// A password field must never carry its value into an element record.
await shell.locator('#pick').click()
await site.locator('#pass').click()
await page.waitForFunction(() => window.picks.length > 1, undefined, { timeout: 8000 }).catch(() => {})
const secretPick = await page.evaluate(() => window.picks[window.picks.length - 1] ?? null)
const secretJson = JSON.stringify(secretPick)
check('picking a password field is allowed', secretPick !== null && secretPick.element?.tag === 'input', JSON.stringify(secretPick?.element?.tag))
check('a password field is redacted in the record', !secretJson.includes('hunter2'), secretJson.slice(0, 200))
check('a password field carries no value attribute', secretPick?.element?.attributes?.value === undefined, JSON.stringify(secretPick?.element?.attributes))

// The shell must not be able to reach the harness window: it is cross-origin
// from the panel, and top navigation is denied by the sandbox.
const escaped = await shellFrame().evaluate(() => {
  try {
    void window.top.document.body
    return true
  } catch (error) {
    return false
  }
})
check('the shell cannot script the GUI window it is framed by', escaped === false)

const frameCount = await page.evaluate(() => document.querySelectorAll('iframe').length)
check('the panel frame is still alive after picking', frameCount > 0)

await browser.close()
panel.close()
session.close()
fixture?.close()
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
