/**
 * Render the panel's start page outside DSH and screenshot it, so the layout can
 * be looked at rather than guessed at. The `--dsw-*` tokens are DSH's; the
 * fallbacks here approximate its light and dark palettes.
 *
 *   node resources/test/start-page-preview.mjs [output.png]
 */
import { readFile, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { loadPlaywright, browserLaunchOptions } from './driver.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const resources = join(here, '..')

/** @returns {Promise<string>} the panel's own stylesheet, from the client bundle. */
export async function panelCss() {
  const client = await readFile(join(resources, '..', 'lib', 'client.js'), 'utf8')
  const styles = /var STYLE_CSS = (\[[\s\S]*?\])\.join\(''\)/.exec(client)
  if (styles === null) throw new Error('could not find STYLE_CSS in lib/client.js')
  return eval(styles[1]).join('')
}

const css = await panelCss()

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

const GLOBE = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.2"/><path d="M2 8h12M8 2c1.8 2 1.8 10 0 12M8 2c-1.8 2-1.8 10 0 12" stroke="currentColor" stroke-width="1.1"/></svg>`

const ROW = (title, url) => `
  <div class="dsh-sep-item">
    <button class="dsh-sep-itemMain" type="button">
      <span class="dsh-sep-itemBadge" aria-hidden="true">${GLOBE}</span>
      <span class="dsh-sep-itemText">
        <span class="dsh-sep-itemTitle">${title}</span>
        <span class="dsh-sep-itemUrl">${url}</span>
      </span>
    </button>
    <button class="dsh-sep-itemX" type="button">×</button>
  </div>`

const KEY_ROW = (username, site) => `
  <div class="dsh-sep-item">
    <span class="dsh-sep-itemBadge isKey" aria-hidden="true">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><circle cx="5.4" cy="10.6" r="2.6" stroke="currentColor" stroke-width="1.3"/><path d="M7.3 8.7 12.6 3.4M10.9 5.1l1.5 1.5M12.4 3.6l1.4 1.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
    </span>
    <span class="dsh-sep-itemText">
      <span class="dsh-sep-itemTitle">${username}</span>
      <span class="dsh-sep-itemUrl">${site}</span>
    </span>
    <button class="dsh-sep-itemX" type="button">×</button>
  </div>`

const CROSSHAIR = `<svg width="18" height="18" viewBox="0 0 16 16" fill="none"><path d="M8 1.6v3M8 11.4v3M1.6 8h3M11.4 8h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="8" r="3.1" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="0.9" fill="currentColor"/></svg>`
const KEY = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="5.4" cy="10.6" r="2.6" stroke="currentColor" stroke-width="1.3"/><path d="M7.3 8.7 12.6 3.4M10.9 5.1l1.5 1.5M12.4 3.6l1.4 1.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`

/** The panel body's markup, mirroring `BrowserPanel`'s idle branch. */
const PANEL = `
<div class="dsh-sep-pane">
  <div class="dsh-sep-start">
    <div class="dsh-sep-hero">
      <span class="dsh-sep-heroGlyph" aria-hidden="true">${CROSSHAIR}</span>
      <div class="dsh-sep-heroText">
        <p class="dsh-sep-heroTitle">打开一个网址开始</p>
        <p class="dsh-sep-heroHint">在下面的记录里点一个，或者直接输入。</p>
      </div>
    </div>
    <form class="dsh-sep-composer">
      <input class="dsh-sep-input" value="http://localhost:3000/admin" />
      <button class="dsh-sep-open" type="button">打开</button>
    </form>
    <section class="dsh-sep-section">
      <div class="dsh-sep-sectionHead"><span>最近访问</span><button class="dsh-sep-sectionAction" type="button">清空</button></div>
      <div class="dsh-sep-list">
        ${ROW('商品管理 · 规格', 'localhost:3000/admin?section=shop-products')}
        ${ROW('房型库存', 'localhost:3000/admin?section=hotel-inventory')}
        ${ROW('录制列表', 'localhost:8081/recordings')}
        <div class="dsh-sep-item">
          <button class="dsh-sep-itemMain" type="button">
            <span class="dsh-sep-itemBadge" aria-hidden="true">${GLOBE}</span>
            <span class="dsh-sep-itemText">
              <span class="dsh-sep-itemTitle">localhost:5173</span>
              <span class="dsh-sep-itemUrl">/draft/42</span>
            </span>
          </button>
          <button class="dsh-sep-itemX" type="button">×</button>
        </div>
      </div>
    </section>
    <section class="dsh-sep-section">
      <div class="dsh-sep-sectionHead"><span>已保存的账号密码</span><span class="dsh-sep-sectionCount">2</span></div>
      <div class="dsh-sep-list">
        ${KEY_ROW('ops', 'localhost:8081')}
        ${KEY_ROW('admin', 'localhost:3000')}
      </div>
    </section>
  </div>
</div>`

/** The page area with the save prompt, mirroring the non-empty branch. */
const PANEL_WITH_PROMPT = `
<div class="dsh-sep-pane">
  <div class="dsh-sep-savebar">
    <span class="dsh-sep-saveGlyph" aria-hidden="true">${KEY}</span>
    <div class="dsh-sep-saveText">
      <span class="dsh-sep-saveTitle">保存 localhost:8081 的账号密码？</span>
      <span class="dsh-sep-saveSub">账号：ops</span>
    </div>
    <button class="dsh-sep-saveGo" type="button">保存</button>
    <button class="dsh-sep-saveSkip" type="button">不用</button>
  </div>
  <div class="dsh-sep-strip">
    <div class="dsh-sep-tabs">
      <button class="dsh-sep-tab" data-active="true" type="button"><span class="dsh-sep-tabTitle">录制列表</span><span class="dsh-sep-tabClose">×</span></button>
      <button class="dsh-sep-tab" data-active="false" type="button"><span class="dsh-sep-tabTitle">商品管理 · 规格</span><span class="dsh-sep-tabClose">×</span></button>
      <button class="dsh-sep-newtab" type="button">＋</button>
    </div>
    <div class="dsh-sep-stripTools"><span>已拾取 3</span><button class="dsh-sep-link" type="button">清空</button></div>
  </div>
  <div class="dsh-sep-frames" style="background:#eef0f4">
    <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#9aa0ab;font-size:12px">（页面在这里）</div>
  </div>
</div>`

/**
 * @returns {string} a standalone page showing the start page and the save prompt
 * side by side. The markup mirrors `BrowserPanel`'s render, and the stylesheet is
 * the panel's own, so this is the real layout — only React is absent.
 */
export function startPageHtml() {
  return `<!doctype html><meta charset="utf-8"><style>${TOKENS}${css}body{margin:0;background:#e7e9ee;padding:18px;display:flex;gap:18px;font-family:var(--dsw-font-family)}.shot{width:380px;height:620px;background:var(--dsw-alias-bg-layer-1);border-radius:12px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,.18)}</style><div class="shot">${PANEL}</div><div class="shot">${PANEL_WITH_PROMPT}</div>`
}

/**
 * Render the start page to a PNG.
 * @param {string} output - where to write the image.
 */
export async function renderStartPage(output) {
  const { chromium } = loadPlaywright()
  const tmp = join(here, '.start-page-preview.html')
  await writeFile(tmp, startPageHtml())
  const browser = await chromium.launch({ ...browserLaunchOptions(), headless: true })
  const page = await browser.newPage({ viewport: { width: 830, height: 680 }, deviceScaleFactor: 2 })
  await page.goto(`file://${tmp}`)
  await page.screenshot({ path: output })
  await browser.close()
  await rm(tmp)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = process.argv[2] ?? join(here, 'start-page.png')
  await renderStartPage(output)
  console.log(`wrote ${output}`)
}
