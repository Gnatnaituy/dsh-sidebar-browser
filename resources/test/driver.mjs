/**
 * Resolve the browser driver the browser-dependent tests and the screenshot
 * tool need, in a way that works in a fresh clone:
 *
 *   1. `playwright-core` / `playwright` installed in this package;
 *   2. the runtime the previous, window-based picker used to keep in the temp
 *      directory (a convenience on a machine that already ran it);
 *   3. otherwise a clear instruction.
 *
 * `DSH_TEST_CHROME` overrides the browser binary; the default is Chrome on
 * macOS, and a plain `chromium` lookup elsewhere (Playwright's own download, or
 * whatever is on PATH through `channel`).
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const require = createRequire(import.meta.url)

/** Where the legacy picker cached its playwright-core install. */
const LEGACY_CACHE = join(
  process.env.TMPDIR ?? '/tmp',
  'dsh-webpage-element-picker',
  'pw-node',
  'node_modules',
  'playwright-core',
)

/**
 * @returns {object} the `playwright` (or `playwright-core`) module.
 */
export function loadPlaywright() {
  try {
    return require('playwright-core')
  } catch (error) {
    /* not installed here */
  }
  try {
    return require('playwright')
  } catch (error) {
    /* not installed here either */
  }
  if (existsSync(LEGACY_CACHE)) return require(LEGACY_CACHE)
  throw new Error(
    'browser tests need a driver: run `npm i -D playwright-core`, or set DSH_TEST_CHROME and install playwright',
  )
}

/**
 * @returns {{executablePath?: string, channel?: string}} launch options.
 */
export function browserLaunchOptions() {
  const configured = process.env.DSH_TEST_CHROME
  if (configured !== undefined && configured !== '') return { executablePath: configured }
  if (process.platform === 'darwin') {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    if (existsSync(chrome)) return { executablePath: chrome }
  }
  // Anywhere else: let Playwright pick its own download, or Chrome if it is on
  // PATH under the usual names.
  return { channel: 'chromium' }
}
