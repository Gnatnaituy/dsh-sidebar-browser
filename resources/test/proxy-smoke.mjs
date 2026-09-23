/**
 * Standalone smoke test for the reverse proxy: binds a port, points it at a
 * target origin, and asserts the framing-relevant behaviour without DSH in the
 * loop. Runs against its own fixture target, or a real origin when one is given:
 * `node resources/test/proxy-smoke.mjs [target-origin]`.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ProxySession, mintToken } from '../proxy.js'
import { startFixtureTarget } from './fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const resources = join(here, '..')
const fixture = process.argv[2] === undefined ? await startFixtureTarget() : undefined
const target = process.argv[2] ?? fixture.origin

const assets = {}
for (const [name, type] of [
  ['chrome.html', 'text/html; charset=utf-8'],
  ['chrome.css', 'text/css; charset=utf-8'],
  ['chrome.js', 'application/javascript; charset=utf-8'],
]) {
  assets[name] = { body: await readFile(join(resources, name)), type }
}

const session = new ProxySession({
  token: mintToken(),
  assets,
  onPick: (payload) => ({ ok: true, domId: 'DOM1', label: payload.label }),
  log: (level, message) => console.log(`[${level}] ${message}`),
})
await session.start()
session.setTarget(target)

let failures = 0
const check = (name, condition, detail) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!condition) failures += 1
}

const shell = await fetch(`http://127.0.0.1:${session.port}/__dsh_picker__/chrome.html`)
const setCookie = shell.headers.get('set-cookie') ?? ''
check('shell serves', shell.status === 200)
check('shell mints capability cookie', setCookie.includes(session.cookieName), setCookie.split(';')[0])
const cookie = setCookie.split(';')[0]
check('shell is same-origin framed by itself', (await shell.text()).includes('/__dsh_picker__/chrome.js'))

const denied = await fetch(`http://127.0.0.1:${session.port}/`)
check('proxying requires the capability cookie', denied.status === 403, `status ${denied.status}`)

const page = await fetch(`http://127.0.0.1:${session.port}/deep/page?x=1`, { headers: { cookie } })
const html = await page.text()
check('target document proxies', page.status === 200, `status ${page.status}`)
check('the target query and path reach the upstream', fixture === undefined || fixture.requests.includes('/deep/page?x=1'), JSON.stringify(fixture?.requests.slice(-3)))
check('the frame-ancestors policy is stripped', page.headers.get('content-security-policy') === null)
check('X-Frame-Options is stripped', page.headers.get('x-frame-options') === null)
const cookieHeader = page.headers.get('set-cookie') ?? ''
check('the target cookie survives', cookieHeader.includes('fixture_session=xyz'), cookieHeader)
check('the cookie Domain is stripped', !/domain=/i.test(cookieHeader), cookieHeader)
check('body is the target document', html.includes('<html'))

// Absolute paths must resolve back through the proxy, which is the whole
// reason the port maps the target's root instead of a prefix.
const assetPath = (html.match(/(?:src|href)="(\/[^"]+\.(?:js|css))"/) ?? [])[1]
check('the document references an absolute asset path', assetPath !== undefined, String(assetPath))
if (assetPath !== undefined) {
  const asset = await fetch(`http://127.0.0.1:${session.port}${assetPath}`, { headers: { cookie } })
  check('subresource proxies', asset.status === 200, `${assetPath} → ${asset.status}`)
  check('subresource keeps a body', (await asset.text()).length > 0)
}

// A real browser stores the target's cookies under the proxy host, so they
// travel back up in the same Cookie header as the capability cookie.
const echo = await fetch(`http://127.0.0.1:${session.port}/api/echo?a=1`, {
  headers: { cookie: `${cookie}; fixture_session=xyz` },
})
const echoBody = await echo.json()
check('an api call keeps its query', echoBody.query === '?a=1', JSON.stringify(echoBody))
check('a cookie the browser stored for the proxy is forwarded upstream', String(echoBody.cookie).includes('fixture_session=xyz'), echoBody.cookie)

const redirect = await fetch(`http://127.0.0.1:${session.port}/go`, { headers: { cookie }, redirect: 'manual' })
const location = redirect.headers.get('location') ?? ''
check('a redirect is answered', redirect.status === 302, String(redirect.status))
check('an absolute redirect is rewritten to the proxy origin', location === '/deep/page?from=go', location)

const pick = await fetch(`http://127.0.0.1:${session.port}/__dsh_picker__/pick`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ label: '提交订单', tag: 'button' }),
})
check('pick sink answers', (await pick.json()).domId === 'DOM1')

const missing = await fetch(`http://127.0.0.1:${session.port}/__dsh_picker__/nope`)
check('unknown picker paths 404', missing.status === 404, `status ${missing.status}`)

session.close()
fixture?.close()
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
