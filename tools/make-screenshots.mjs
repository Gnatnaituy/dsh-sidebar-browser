/**
 * Build the screenshots a listing shows, for real: the browser surface is the
 * actual `chrome.html` served by an actual proxy port against the fixture site,
 * framed by the same markup and stylesheet the sidebar panel renders (only React
 * is absent — the strip's DOM and CSS are the ones `BrowserPanel` produces).
 *
 *   node tools/make-screenshots.mjs
 *
 * Writes `assets/screenshot-*.png` and `screenshots.json`, which is the file the
 * awesome-dsh-plugin list and dsh-market read (paths are relative to the repo).
 */
import http from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ProxySession, mintToken } from '../resources/proxy.js'
import { startFixtureTarget } from '../resources/test/fixture.mjs'
import { loadPlaywright, browserLaunchOptions } from '../resources/test/driver.mjs'
import { panelCss, startPageHtml } from '../resources/test/start-page-preview.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const assets = join(root, 'assets')

/** DSH's own design tokens, which the panel stylesheet expects. */
const TOKENS = `
  :root{
    --dsw-alias-bg-layer-1:#ffffff; --dsw-alias-bg-layer-2:#f5f6f8; --dsw-alias-border-l1:#e9eaee;
    --dsw-alias-border-l3:#d8dae0; --dsw-alias-border-l4:#c9ccd4; --dsw-alias-label-primary:#1d1f24;
    --dsw-alias-label-secondary:#6a6f7a; --dsw-alias-label-caption:#9aa0ab;
    --dsw-alias-interactive-bg-hover:#f0f1f4; --dsw-alias-button-primary-fill:#3b3f47;
    --dsw-alias-button-primary-hover:#2c2f36; --dsw-alias-label-primary-foreground:#ffffff;
    --dsw-alias-state-business-primary:#4d6bfe; --dsw-alias-state-error-primary:#e5484d;
    --dsw-font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
  }`

const KEY = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="5.4" cy="10.6" r="2.6" stroke="currentColor" stroke-width="1.3"/><path d="M7.3 8.7 12.6 3.4M10.9 5.1l1.5 1.5M12.4 3.6l1.4 1.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`

/**
 * The tab strip, mirroring `BrowserPanel`'s render.
 * @param {string[]} titles - the open pages.
 * @param {number} active - which one is showing.
 * @param {number} picked - how many elements the conversation has picked.
 * @returns {string} the strip markup.
 */
function strip(titles, active, picked) {
  const tabs = titles
    .map(
      (title, index) =>
        `<button class="dsh-sb-tab" data-active="${index === active ? 'true' : 'false'}" type="button"><span class="dsh-sb-tabTitle">${title}</span><span class="dsh-sb-tabClose">×</span></button>`,
    )
    .join('')
  const tools =
    picked > 0
      ? `<span>已拾取 ${picked}</span><button class="dsh-sb-link" type="button">清空</button>`
      : ''
  return `<div class="dsh-sb-strip"><div class="dsh-sb-tabs">${tabs}<button class="dsh-sb-newtab" type="button">＋</button></div><div class="dsh-sb-stripTools">${tools}</div></div>`
}

/**
 * @param {object} options - what to draw.
 * @param {string} options.frame - the shell URL to embed.
 * @param {string[]} options.titles - tab titles.
 * @param {number} options.active - the visible tab.
 * @param {number} options.picked - picked-element count.
 * @param {number} [options.width] - panel width.
 * @param {number} [options.height] - panel height.
 * @returns {Promise<string>} a full HTML page.
 */
async function panelPage(options) {
  const css = await panelCss()
  return `<!doctype html><meta charset="utf-8"><style>${TOKENS}${css}
    body{margin:0;background:#e7e9ee;padding:16px;font-family:var(--dsw-font-family)}
    .shot{width:${options.width ?? 420}px;height:${options.height ?? 660}px;background:var(--dsw-alias-bg-layer-1);border-radius:12px;overflow:hidden;box-shadow:0 10px 34px rgba(0,0,0,.2)}
    .dsh-sb-frames iframe{width:100%;height:100%;border:0;display:block}
  </style><div class="shot"><div class="dsh-sb-pane">${strip(options.titles, options.active, options.picked)}<div class="dsh-sb-frames"><iframe src="${options.frame}"></iframe></div></div></div>`
}

const fixture = await startFixtureTarget()
const session = new ProxySession({
  token: mintToken(),
  assets: {
    'chrome.html': { body: await readFile(join(root, 'resources', 'chrome.html')), type: 'text/html; charset=utf-8' },
    'chrome.css': { body: await readFile(join(root, 'resources', 'chrome.css')), type: 'text/css; charset=utf-8' },
    'chrome.js': { body: await readFile(join(root, 'resources', 'chrome.js')), type: 'application/javascript; charset=utf-8' },
  },
  onPick: () => ({ ok: true, domId: 'DOM1', label: '提交订单' }),
  log: () => {},
})
await session.start()
session.setTarget(fixture.origin)
const shell = (query) => `http://127.0.0.1:${session.port}/__dsh_shell__/chrome.html${query}`

const { chromium } = loadPlaywright()
const browser = await chromium.launch({ ...browserLaunchOptions(), headless: true })
await mkdir(assets, { recursive: true })

// The composed page is served over loopback rather than opened as `file://`, so
// the shell's capability cookie is same-site and therefore actually sent — the
// same reason the real panel sits on the GUI's own host.
let pageSource = '<!doctype html><meta charset="utf-8">'
const stage = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(pageSource)
})
await new Promise((resolve) => stage.listen(0, '127.0.0.1', resolve))
const stageOrigin = `http://127.0.0.1:${stage.address().port}`

/**
 * Serve one HTML page, shoot it.
 * @param {string} html - the page source.
 * @param {string} file - the output basename under `assets/`.
 * @param {object} size - the viewport.
 * @param {(page: object) => Promise<void>} [prepare] - interaction before the shot.
 */
async function shoot(html, file, size, prepare) {
  pageSource = html
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 2 })
  await page.goto(`${stageOrigin}/`)
  await page.waitForTimeout(1200)
  if (prepare !== undefined) await prepare(page)
  await page.screenshot({ path: join(assets, file) })
  await page.close()
}

const TITLES = ['商品管理 · 高县文旅', 'Fixture 登录']
const SIZE = { width: 452, height: 692 }

// 1. Browsing through the picker, with an element highlighted before the click.
await shoot(
  await panelPage({ frame: shell('?p=/demo'), titles: TITLES, active: 0, picked: 0 }),
  'screenshot-1.png',
  SIZE,
  async (page) => {
    const shellFrame = page.frameLocator('iframe')
    await shellFrame.locator('#pick').click()
    await shellFrame.frameLocator('#site').locator('#save-spec').hover()
    await page.waitForTimeout(400)
  },
)

// 2. The same page previewed at a phone viewport.
await shoot(
  await panelPage({ frame: shell('?p=/demo&d=phone-393'), titles: TITLES, active: 0, picked: 2 }),
  'screenshot-2.png',
  SIZE,
)

// 3. The start page, rendered from the panel's own stylesheet and markup.
await shoot(startPageHtml(), 'screenshot-3.png', { width: 830, height: 680 })

await writeFile(
  join(root, 'screenshots.json'),
  `${JSON.stringify(['assets/screenshot-1.png', 'assets/screenshot-2.png', 'assets/screenshot-3.png'], null, 2)}\n`,
)

await browser.close()
stage.close()
session.close()
fixture.close()
console.log('wrote assets/screenshot-1..3.png and screenshots.json')
void KEY
