/**
 * A target site for the test suites, so they do not depend on whatever the
 * developer happens to have running on a port. It exists to be awkward in
 * exactly the ways a real app is:
 *
 *   - absolute asset paths (`/assets/…`) that only survive a root-mapped proxy;
 *   - a `Set-Cookie` with a `Domain` a reverse proxy must strip;
 *   - `X-Frame-Options: DENY` and `frame-ancestors 'none'`, which would make
 *     framing impossible without the proxy;
 *   - a redirect to an absolute URL on its own origin, which must come back as
 *     a proxy-relative location;
 *   - a query string and a deep path;
 *   - a media query the preview is supposed to trigger.
 *
 * `startFixtureTarget()` returns the running server and its origin.
 */
import http from 'node:http'

const PAGE = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Fixture 目标站点</title>
    <link rel="stylesheet" href="/assets/app.css" />
    <script src="/assets/app.js" defer></script>
  </head>
  <body>
    <header class="top">
      <a class="brand" id="brand-link" href="/deep/page?x=1">Fixture <b>Brand</b></a>
    </header>
    <main>
      <h1 id="title">测试目标站点</h1>
      <form id="order-form">
        <label for="amount">金额</label>
        <input id="amount" name="amount" value="100" />
        <button id="submit-order" type="submit">提交订单</button>
      </form>
      <table>
        <thead><tr><th>规格</th><th>价格</th></tr></thead>
        <tbody><tr><td>规格 A</td><td>10</td></tr></tbody>
      </table>
      <div id="mq">desktop</div>
      <p id="path"></p>
      <p><a id="external" href="http://127.0.0.1:4300/external">站外链接</a></p>
      <p><a id="blank-link" href="/deep/page?x=1" target="_blank">新标签页链接</a></p>
    </main>
  </body>
</html>
`

const LOGIN_PAGE = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>Fixture 登录</title>
  </head>
  <body>
    <form id="login" method="post" action="/login">
      <label for="user">账号</label>
      <input id="user" name="username" type="text" />
      <label for="pass">密码</label>
      <input id="pass" name="password" type="password" />
      <button id="sign-in" type="submit">登录</button>
    </form>
    <p id="signed"></p>
    <script>
      document.getElementById('login').addEventListener('submit', function (event) {
        event.preventDefault()
        document.getElementById('signed').textContent =
          'signed in as ' + document.getElementById('user').value
      })
    </script>
  </body>
</html>
`


/**
 * A plausible-looking admin page, used for the listing screenshots (and useful
 * as a wider target). It is still an ordinary response from this fixture: the
 * screenshots show the real proxy, the real shell and a real render of this
 * document, never a drawing.
 *
 * The copy is deliberately generic: these screenshots are published in the
 * README and the plugin listing, so nothing in them may name a real customer,
 * brand or product line.
 */
const DEMO_PAGE = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>示例商城 · 商品管理</title>
    <link rel="stylesheet" href="/assets/demo.css" />
  </head>
  <body>
    <header class="top">
      <span class="brand">示例商城 · 管理后台</span>
      <span class="who">ops</span>
    </header>
    <div class="shell">
      <nav class="side">
        <a class="on" href="#">商品管理</a>
        <a href="#">库存</a>
        <a href="#">订单</a>
        <a href="#">设置</a>
      </nav>
      <main class="main">
        <h1>商品规格</h1>
        <form class="card" id="spec-form">
          <label for="name">规格名称</label>
          <input id="name" value="示例商品 · 标准装" />
          <label for="price">规格售价（元）</label>
          <input id="price" value="128" />
          <div class="row">
            <button class="ghost" type="button">取消</button>
            <button class="primary" id="save-spec" type="submit">保存</button>
          </div>
        </form>
        <table class="card">
          <thead><tr><th>规格</th><th>SKU 编码</th><th>售价</th><th>库存</th></tr></thead>
          <tbody>
            <tr><td>标准装</td><td>SKU-101</td><td>128</td><td>320</td></tr>
            <tr><td>家庭装</td><td>SKU-102</td><td>198</td><td>150</td></tr>
            <tr><td>组合装</td><td>SKU-103</td><td>98</td><td>860</td></tr>
          </tbody>
        </table>
      </main>
    </div>
  </body>
</html>
`

const DEMO_CSS = `*{box-sizing:border-box}
body{margin:0;font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#20242c;background:#f4f6f9}
.top{display:flex;align-items:center;justify-content:space-between;height:48px;padding:0 16px;background:#1f2733;color:#fff}
.top .brand{font-weight:600}
.top .who{opacity:.7;font-size:12px}
.shell{display:flex;align-items:flex-start;gap:16px;padding:16px}
.side{display:flex;flex-direction:column;gap:2px;width:150px;flex:none}
.side a{padding:8px 10px;border-radius:8px;color:#4a5261;text-decoration:none}
.side a.on{background:#e4ebff;color:#2c4bd8;font-weight:600}
.main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:14px}
h1{margin:0;font-size:17px}
.card{margin:0;padding:14px;background:#fff;border:1px solid #e6e9ef;border-radius:12px}
label{display:block;margin:6px 0 4px;font-size:12px;color:#6a7280}
input{width:100%;height:34px;padding:0 10px;border:1px solid #d7dbe3;border-radius:8px;font:inherit}
.row{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
button{height:32px;padding:0 14px;border-radius:8px;font:inherit;cursor:pointer}
.primary{border:none;background:#2c4bd8;color:#fff}
.ghost{border:1px solid #d7dbe3;background:#fff;color:#4a5261}
table{border-collapse:collapse;font-size:13px}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #eef1f5}
th{color:#6a7280;font-weight:500}
@media (max-width:700px){
  .shell{flex-direction:column;padding:12px;gap:12px}
  .side{flex-direction:row;width:auto;overflow-x:auto}
  .side a{white-space:nowrap}
}
`

const SCRIPT = `var probe = document.getElementById('mq')
var update = function () {
  probe.textContent = matchMedia('(max-width: 420px)').matches ? 'phone' : 'desktop'
}
update()
addEventListener('resize', update)
document.getElementById('path').textContent = location.pathname + location.search
`

const STYLE = `.top{display:flex;padding:8px}.brand{color:#123;font-weight:600}main{padding:8px 16px}h1{font-size:20px}`

/** Headers that make the fixture deliberately unframeable and cookie-bearing. */
const HOSTILE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'set-cookie': 'fixture_session=xyz; Domain=localhost; Path=/; HttpOnly',
}

/**
 * Start the fixture site.
 * @returns {Promise<{origin: string, close: () => void, requests: string[]}>} the running server.
 */
export async function startFixtureTarget() {
  /** Every path the fixture was asked for, for proxy assertions. */
  const requests = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture')
    requests.push(`${url.pathname}${url.search}`)

    if (url.pathname === '/assets/app.css') {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' })
      res.end(STYLE)
      return
    }
    if (url.pathname === '/assets/demo.css') {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' })
      res.end(DEMO_CSS)
      return
    }
    if (url.pathname === '/demo') {
      res.writeHead(200, HOSTILE_HEADERS)
      res.end(DEMO_PAGE)
      return
    }
    if (url.pathname === '/assets/app.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' })
      res.end(SCRIPT)
      return
    }
    if (url.pathname === '/login') {
      res.writeHead(200, HOSTILE_HEADERS)
      res.end(LOGIN_PAGE)
      return
    }
    if (url.pathname === '/api/echo') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: true, path: url.pathname, query: url.search, cookie: req.headers.cookie ?? '' }))
      return
    }
    if (url.pathname === '/go') {
      // An absolute redirect on the fixture's own origin.
      res.writeHead(302, { location: `http://localhost:${server.address().port}/deep/page?from=go` })
      res.end()
      return
    }
    if (url.pathname === '/deep/page' || url.pathname === '/' || url.pathname.startsWith('/deep/')) {
      res.writeHead(200, HOSTILE_HEADERS)
      res.end(PAGE)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    origin: `http://localhost:${port}`,
    requests,
    close: () => server.close(),
  }
}
