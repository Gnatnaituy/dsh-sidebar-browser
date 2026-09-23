/**
 * A per-tab reverse proxy on loopback.
 *
 * The sidebar browser needs *same-origin* access to the page it inspects: only
 * then can it read `contentDocument`, draw the hover highlight and snapshot a
 * clicked element. Framing the target URL directly would be cross-origin and
 * therefore opaque. This module makes one local origin stand in for one target
 * origin, so the browser shell and the inspected page share an origin while
 * remaining a *different* origin from the DSH GUI (which keeps the inspected
 * page out of the GUI's own DOM).
 *
 * Because the whole origin maps to the target root, no URL rewriting is
 * needed: `/admin/x?y=1` upstream is `/admin/x?y=1` here, and an app that
 * builds URLs from `location.origin` keeps working. Only headers that would
 * break framing (`X-Frame-Options`, CSP) or leak the mismatch
 * (`Set-Cookie: Domain=…`, absolute `Location`) are touched. Bodies stream
 * through untouched, and `Upgrade` connections are tunnelled raw so HMR and
 * any other WebSocket protocol work unmodified.
 */
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { randomBytes } from 'node:crypto'

/** Paths this proxy answers itself instead of forwarding. */
const ASSET_PREFIX = '/__dsh_picker__/'

/** Headers that belong to one hop and must never be forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/**
 * Response headers dropped before the browser sees them. Framing headers go
 * because the proxy is the only reason framing is possible at all; the
 * cross-origin isolation headers go because the nested page is same-origin
 * with its shell and their guarantees are meaningless (and their failures
 * noisy) in that shape.
 */
const STRIP_RESPONSE_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'strict-transport-security',
  'permissions-policy',
  'report-to',
  'nel',
  'expect-ct',
])

/**
 * One target origin served on one loopback port.
 */
export class ProxySession {
  /**
   * @param {object} options - session wiring.
   * @param {string} options.token - capability token gating every proxied request.
   * @param {Record<string, {body: Buffer, type: string}>} options.assets - files served under `/__dsh_picker__/`.
   * @param {(payload: object) => void} [options.onPick] - called for every posted element.
   * @param {(level: string, message: string) => void} [options.log] - diagnostics sink.
   */
  constructor(options) {
    this.token = options.token
    this.assets = options.assets ?? {}
    this.onPick = options.onPick
    this.log = options.log ?? (() => {})
    /** Absolute origin the port stands for, e.g. `http://localhost:3000`. */
    this.target = undefined
    /** Loopback port, known after {@link start}. */
    this.port = 0
    this.cookieName = ''
    this.server = undefined
    this.sockets = new Set()
  }

  /** Whether a target origin has been chosen and the port is listening. */
  get ready() {
    return this.port > 0 && this.target !== undefined
  }

  /** The origin a browser must use to reach this session. */
  originFor(hostname) {
    return `http://${hostname}:${this.port}`
  }

  /**
   * Point the port at a target origin. Safe to call repeatedly; each tab owns
   * one port and changing target is how the user retypes the URL.
   * @param {string} origin - absolute `http(s)://host[:port]` origin.
   */
  setTarget(origin) {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`unsupported protocol: ${url.protocol}`)
    }
    this.target = `${url.protocol}//${url.host}`
  }

  /**
   * Bind the loopback port. A preferred port is honoured when it is free, which
   * is what keeps one target origin on the same browser origin across restarts:
   * the same origin means the same cookies, `localStorage` and `IndexedDB`, so
   * an app that keeps its session token in web storage is still signed in.
   * @param {number} [preferredPort] - the port this origin used before, if any.
   * @returns {Promise<number>} the port actually bound.
   */
  async start(preferredPort) {
    if (this.server !== undefined) return this.port
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        this.log('warn', `proxy request failed: ${String(error && error.message || error)}`)
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        try {
          res.end('proxy error')
        } catch {
          /* the client is already gone */
        }
      })
    })
    server.on('upgrade', (req, socket, head) => this.tunnel(req, socket, head))
    server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })
    const candidate =
      Number.isInteger(preferredPort) && preferredPort >= 1024 && preferredPort <= 65535 ? preferredPort : 0
    const listen = (port) =>
      new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, '127.0.0.1')
      })
    try {
      await listen(candidate)
    } catch (error) {
      if (candidate === 0) throw error
      this.log('info', `port ${candidate} is taken, falling back to an ephemeral one`)
      await listen(0)
    }
    server.on('error', (error) => this.log('warn', `proxy server error: ${String(error)}`))
    this.port = server.address().port
    this.cookieName = `dsh_picker_${this.port}`
    this.server = server
    this.log('info', `proxy listening on 127.0.0.1:${this.port}`)
    return this.port
  }

  /** Stop listening and drop every socket, including tunnelled upgrades. */
  close() {
    const server = this.server
    this.server = undefined
    if (server === undefined) return
    for (const socket of this.sockets) {
      try {
        socket.destroy()
      } catch {
        /* already gone */
      }
    }
    this.sockets.clear()
    try {
      server.close()
    } catch {
      /* already closed */
    }
    this.port = 0
  }

  /**
   * The capability cookie value for this port.
   * @returns {string} the `name=value` pair the browser must present.
   */
  get capabilityPair() {
    return `${this.cookieName}=${this.token}`
  }

  /**
   * Whether a request carries this port's capability. Cookies ignore ports, so
   * the name embeds the port: a session only trusts the cookie minted for its
   * own name, and being `HttpOnly` the value cannot be read and replayed by
   * page script.
   * @param {http.IncomingMessage} req - the incoming request.
   * @returns {boolean} true when the request may use the proxy.
   */
  hasCapability(req) {
    const header = req.headers.cookie
    if (typeof header !== 'string') return false
    for (const part of header.split(';')) {
      const eq = part.indexOf('=')
      if (eq < 0) continue
      if (part.slice(0, eq).trim() !== this.cookieName) continue
      return part.slice(eq + 1).trim() === this.token
    }
    return false
  }

  /**
   * Serve one HTTP request: local asset, pick callback, or a proxied target.
   * @param {http.IncomingMessage} req - the incoming request.
   * @param {http.ServerResponse} res - the response to own.
   */
  async handle(req, res) {
    let pathname
    try {
      pathname = new URL(req.url ?? '/', 'http://proxy').pathname
    } catch {
      res.writeHead(400).end()
      return
    }

    if (pathname.startsWith(ASSET_PREFIX)) {
      await this.handleAsset(req, res, pathname)
      return
    }

    if (this.target === undefined) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' })
      res.end(noTargetPage())
      return
    }

    if (!this.hasCapability(req)) {
      res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
      res.end(forbiddenPage())
      return
    }

    this.forward(req, res)
  }

  /**
   * Answer the picker's own paths: the shell page, its assets, its metadata
   * and the element sink.
   * @param {http.IncomingMessage} req - the incoming request.
   * @param {http.ServerResponse} res - the response to own.
   * @param {string} pathname - path after the asset prefix.
   */
  async handleAsset(req, res, pathname) {
    const name = pathname.slice(ASSET_PREFIX.length)

    if (name === 'chrome.html' || name === '') {
      const asset = this.assets['chrome.html']
      if (asset === undefined) {
        res.writeHead(500).end('missing asset')
        return
      }
      const headers = {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      }
      if (!this.hasCapability(req)) {
        headers['set-cookie'] =
          `${this.capabilityPair}; Path=/; HttpOnly; SameSite=Lax`
      }
      res.writeHead(200, headers)
      res.end(asset.body)
      return
    }

    if (name === 'meta') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ target: this.target ?? '', port: this.port }))
      return
    }

    if (name === 'pick') {
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      if (!this.hasCapability(req)) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        res.end('{"ok":false,"error":"forbidden"}')
        return
      }
      const body = await readBody(req, 4 * 1024 * 1024)
      let payload
      try {
        payload = JSON.parse(body === '' ? '{}' : body)
      } catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end('{"ok":false,"error":"bad json"}')
        return
      }
      let result = { ok: true }
      try {
        result = (await this.onPick?.(payload)) ?? { ok: true }
      } catch (error) {
        result = { ok: false, error: String(error && error.message || error) }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(result))
      return
    }

    const asset = this.assets[name]
    if (asset === undefined) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' })
    res.end(asset.body)
  }

  /**
   * Stream one request to the target and rewrite only what framing requires.
   * @param {http.IncomingMessage} req - the incoming request.
   * @param {http.ServerResponse} res - the response to own.
   */
  forward(req, res) {
    const target = new URL(this.target)
    const upstreamUrl = new URL(req.url ?? '/', this.target)
    const secure = target.protocol === 'https:'
    const headers = { ...req.headers }
    for (const name of Object.keys(headers)) {
      if (HOP_BY_HOP.has(name)) delete headers[name]
    }
    // Keep the incoming Host: the inspected app sees the same host in `Host`
    // and `Origin`, which is what dev servers' cross-origin checks compare.
    const upstreamReq = (secure ? http : http).request(
      {
        protocol: secure ? 'https:' : 'http:',
        hostname: target.hostname,
        port: target.port === '' ? (secure ? 443 : 80) : target.port,
        path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
        method: req.method,
        headers,
        ...(secure ? { rejectUnauthorized: false } : {}),
      },
      (upstreamRes) => {
        const out = {}
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          if (value === undefined) continue
          if (HOP_BY_HOP.has(key)) continue
          if (STRIP_RESPONSE_HEADERS.has(key)) continue
          if (key === 'set-cookie') continue
          out[key] = value
        }
        if (upstreamRes.headers['set-cookie'] !== undefined) {
          out['set-cookie'] = upstreamRes.headers['set-cookie'].map((cookie) => this.rewriteCookie(cookie))
        }
        if (upstreamRes.headers.location !== undefined) {
          out.location = this.rewriteLocation(upstreamRes.headers.location)
        }
        res.writeHead(upstreamRes.statusCode ?? 502, out)
        if (req.method === 'HEAD') {
          res.end()
          upstreamRes.resume()
          return
        }
        upstreamRes.pipe(res)
      },
    )
    upstreamReq.on('error', (error) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' })
      res.end(upstreamErrorPage(this.target, String(error && error.message || error)))
    })
    res.on('close', () => {
      if (!res.writableEnded) upstreamReq.destroy()
    })
    req.pipe(upstreamReq)
  }

  /**
   * Drop `Domain` from a target cookie: the browser stores it for the proxy
   * host, and a target-scoped domain would be rejected outright.
   * @param {string} cookie - one `Set-Cookie` value from the target.
   * @returns {string} the same cookie without a `Domain` attribute.
   */
  rewriteCookie(cookie) {
    return cookie
      .split(';')
      .filter((part) => !/^\s*domain=/i.test(part))
      .join(';')
  }

  /**
   * Point an absolute target redirect back at the proxy, so a login redirect
   * cannot throw the framed page onto the real origin (and out of the picker).
   * @param {string} location - the target's `Location` header.
   * @returns {string} a proxy-relative or untouched location.
   */
  rewriteLocation(location) {
    if (this.target === undefined) return location
    const target = new URL(this.target)
    let parsed
    try {
      parsed = new URL(location)
    } catch {
      return location
    }
    if (parsed.host !== target.host) return location
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  }

  /**
   * Tunnel an `Upgrade` connection to the target over raw TCP/TLS. Nothing is
   * parsed: whatever protocol the page negotiated (Vite HMR, Next's dev
   * socket, a game) reaches the same bytes it would have reached directly.
   * @param {http.IncomingMessage} req - the upgrade request.
   * @param {net.Socket} socket - the client socket.
   * @param {Buffer} head - bytes already read past the request headers.
   */
  tunnel(req, socket, head) {
    if (this.target === undefined) {
      socket.destroy()
      return
    }
    const target = new URL(this.target)
    const secure = target.protocol === 'https:'
    const port = target.port === '' ? (secure ? 443 : 80) : Number(target.port)
    const connect = secure ? tls.connect : net.connect
    const upstream = connect(
      {
        host: target.hostname,
        port,
        ...(secure ? { servername: target.hostname, rejectUnauthorized: false } : {}),
      },
      () => {
        const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`]
        const raw = req.rawHeaders
        for (let i = 0; i + 1 < raw.length; i += 2) {
          if (raw[i].toLowerCase() === 'host') {
            lines.push(`Host: ${target.host}`)
            continue
          }
          lines.push(`${raw[i]}: ${raw[i + 1]}`)
        }
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
        if (head !== undefined && head.length > 0) upstream.write(head)
        socket.pipe(upstream)
        upstream.pipe(socket)
      },
    )
    const kill = () => {
      upstream.destroy()
      socket.destroy()
    }
    upstream.on('error', kill)
    socket.on('error', kill)
    upstream.on('close', kill)
    socket.on('close', kill)
  }
}

/**
 * Read a request body into a string, refusing to grow past a limit.
 * @param {http.IncomingMessage} req - the request to drain.
 * @param {number} limit - maximum accepted byte length.
 * @returns {Promise<string>} the body, or `''` when it overflows.
 */
function readBody(req, limit) {
  return new Promise((resolve) => {
    let text = ''
    let overflow = false
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      if (overflow) return
      text += chunk
      if (text.length > limit) {
        overflow = true
        text = ''
      }
    })
    req.on('end', () => resolve(overflow ? '' : text))
    req.on('error', () => resolve(''))
  })
}

/** @returns {string} the page shown before a target has been chosen. */
function noTargetPage() {
  return `<!doctype html><meta charset="utf-8"><title>侧边栏浏览器</title>
<body style="font:13px/1.6 system-ui;padding:24px;color:#444">尚未指定网址。</body>`
}

/** @returns {string} the page shown when the capability cookie is missing. */
function forbiddenPage() {
  return `<!doctype html><meta charset="utf-8"><title>侧边栏浏览器</title>
<body style="font:13px/1.6 system-ui;padding:24px;color:#444">
该地址只能通过侧边栏浏览器打开（缺少访问凭据）。</body>`
}

/**
 * @param {string} target - the unreachable origin.
 * @param {string} message - the transport error.
 * @returns {string} a readable failure page.
 */
function upstreamErrorPage(target, message) {
  const safe = message.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
  return `<!doctype html><meta charset="utf-8"><title>无法连接</title>
<body style="font:13px/1.6 system-ui;padding:24px;color:#444">
<p>无法连接 <code>${target}</code>。</p><p style="color:#888">${safe}</p></body>`
}

/**
 * Mint the capability token for one session.
 * @returns {string} 32 hex characters.
 */
export function mintToken() {
  return randomBytes(16).toString('hex')
}
