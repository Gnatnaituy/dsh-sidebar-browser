/**
 * Test the `Upgrade` tunnel with raw sockets: the handshake must survive the
 * proxy (including the `Host` rewrite) and bytes must flow both ways, because
 * that is what dev servers' hot-reload sockets need.
 *
 * Run with `node resources/test/tunnel-smoke.mjs`.
 */
import http from 'node:http'
import net from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { ProxySession, mintToken } from '../proxy.js'

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

/** What the target saw and sent. */
const seen = { host: '', key: '' }

// A target that speaks just enough of RFC 6455 to prove the tunnel: it accepts
// the handshake, greets, then echoes raw bytes back.
const target = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('http ok')
})
target.on('upgrade', (req, socket) => {
  seen.host = String(req.headers.host ?? '')
  seen.key = String(req.headers['sec-websocket-key'] ?? '')
  const accept = createHash('sha1')
    .update(`${seen.key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  socket.write(Buffer.concat([Buffer.from([0x81, 0x05]), Buffer.from('hello')]))
  socket.on('data', (chunk) => socket.write(chunk))
})
await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve))
const targetPort = target.address().port

const session = new ProxySession({
  token: mintToken(),
  assets: {},
  log: (level, message) => console.log(`    [${level}] ${message}`),
})
await session.start()
session.setTarget(`http://127.0.0.1:${targetPort}`)

const key = randomBytes(16).toString('base64')
const socket = net.connect(session.port, '127.0.0.1')
const received = []
const done = new Promise((resolve) => {
  socket.on('data', (chunk) => {
    received.push(chunk)
    if (Buffer.concat(received).includes(Buffer.from('hello')) === false) return
    if (Buffer.concat(received).length >= 60) resolve()
  })
  socket.on('error', () => resolve())
  setTimeout(resolve, 4000)
})

await new Promise((resolve) => socket.on('connect', resolve))
socket.write(
  'GET /_next/webpack-hmr?token=abc HTTP/1.1\r\n' +
    `Host: 127.0.0.1:${session.port}\r\n` +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Key: ${key}\r\n` +
    'Sec-WebSocket-Version: 13\r\n\r\n',
)

await done
const text = Buffer.concat(received).toString('latin1')
check('the upgrade is answered with 101', text.startsWith('HTTP/1.1 101'), text.split('\r\n')[0])
check('the accept header survives the tunnel', text.includes('Sec-WebSocket-Accept:'))
check('the target saw the rewritten Host', seen.host === `127.0.0.1:${targetPort}`, seen.host)
check('the target saw the WebSocket key', seen.key === key)
check('the target reaches the client', text.includes('hello'))

// Client → target: a masked frame the target echoes verbatim.
const masked = Buffer.concat([Buffer.from([0x81, 0x84, 0x01, 0x02, 0x03, 0x04]), Buffer.from([0x70 ^ 1, 0x69 ^ 2, 0x6e ^ 3, 0x67 ^ 4])])
received.length = 0
socket.write(masked)
await new Promise((resolve) => setTimeout(resolve, 600))
const echoed = Buffer.concat(received)
check('client bytes reach the target and come back', echoed.length >= masked.length, `${echoed.length} bytes`)

socket.destroy()
session.close()
target.close()
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
