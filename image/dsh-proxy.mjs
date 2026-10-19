// dsh auth auto-proxy: forwards all requests to the loopback dsh server.
// - Rewrites the Host header to the public lazycat domain (DSH_PUBLIC_HOST)
//   so dsh's browser-auth cookie name (dsh-auth-<sha256(authority)>) always
//   matches the domain the browser actually uses.
// - For the root path, injects the process launch token ONLY when the request
//   does not carry the cookie that is valid for the public host.
// - Forwards WebSocket upgrade requests (used by /api/remote.mux) preserving
//   the Connection: Upgrade / Upgrade: websocket headers.
// - Serves /dsh-img/<url> by proxying the image through GHPROXY so the
//   browser only talks to the lazycat domain (images.weserv.nl and direct
//   GitHub are unreachable from mainland networks).
import http from 'node:http'
import https from 'node:https'
import { createHash } from 'node:crypto'

const LISTEN = Number(process.env.PROXY_LISTEN || 3080)
const TARGET_HOST = process.env.DSH_TARGET_HOST || '127.0.0.1'
const TARGET_PORT = Number(process.env.DSH_TARGET_PORT || 3081)
const TOKEN = process.env.DSH_TOKEN || ''
const PUBLIC_HOST = process.env.DSH_PUBLIC_HOST || ''
const DEBUG = process.env.DSH_PROXY_DEBUG === '1'
const IMG_PREFIX = '/dsh-img/'
const GHPROXY = process.env.DSH_IMG_PROXY || 'https://gh-proxy.com'

function log(...args) {
  if (DEBUG) console.error('[proxy]', ...args)
}

function encodeBase64Url(buf) {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function expectedCookieName() {
  if (PUBLIC_HOST === '') return ''
  const authority = PUBLIC_HOST.toLowerCase()
  return 'dsh-auth-' + encodeBase64Url(createHash('sha256').update(authority).digest())
}

function hasValidCookie(req) {
  if (PUBLIC_HOST === '') return false
  const cookie = req.headers.cookie ?? ''
  const name = expectedCookieName()
  const segments = cookie.split(';').map((s) => s.trim())
  return segments.some((seg) => seg.startsWith(name + '='))
}

function withToken(path) {
  const url = new URL(path, 'http://dsh.local')
  if (url.pathname !== '/' || url.searchParams.has('token')) return path
  return url.search === '' ? '/?token=' + encodeURIComponent(TOKEN) : url.search + '&token=' + encodeURIComponent(TOKEN)
}

function targetHeaders(req) {
  const headers = { ...req.headers, connection: 'close' }
  if (PUBLIC_HOST !== '') headers.host = PUBLIC_HOST
  // dsh 的 isTrustedApiRequest 要求：Host ∈ trustedHosts、Origin 的 host === Host、
  // sec-fetch-site !== cross-site。懒猫 ingress 会把 Host 改成内部地址（我们已改写回
  // 公网域名），但浏览器带来的 Origin 可能是懒猫域名、内嵌 iframe 场景甚至 cross-site，
  // 导致 /api/* 一律 403（前端表现为 settings/模型目录加载失败）。应用本身在懒猫门禁
  // 之后、且已完成 launch-token 认证，这里统一改写使校验通过。
  if (headers.origin !== undefined) headers.origin = 'https://' + PUBLIC_HOST
  if (headers['sec-fetch-site'] === 'cross-site') headers['sec-fetch-site'] = 'same-origin'
  return headers
}

function upgradeHeaders(req) {
  const headers = { ...req.headers }
  if (PUBLIC_HOST !== '') {
    headers.host = PUBLIC_HOST
    if (headers.origin !== undefined) headers.origin = 'https://' + PUBLIC_HOST
    if (headers['sec-fetch-site'] === 'cross-site') headers['sec-fetch-site'] = 'same-origin'
  }
  return headers
}

// /dsh-img/<https-url> -> fetch through GHPROXY, stream back to browser.
function proxyImage(req, res) {
  let raw = decodeURIComponent(req.url.slice(IMG_PREFIX.length))
  // tolerate a missing protocol
  if (!/^https?:\/\//.test(raw)) raw = 'https://' + raw
  const target = GHPROXY + '/' + raw
  log('IMG', raw, '->', target)
  const proxyReq = https.get(target, (upRes) => {
    const status = upRes.statusCode ?? 502
    if (status >= 300 && status < 400 && upRes.headers.location) {
      // follow one redirect
      const loc = upRes.headers.location
      const next = /^https?:/.test(loc) ? loc : new URL(loc, target).href
      const r2 = https.get(next, (upRes2) => {
        const h2 = { ...upRes2.headers, 'cache-control': 'public, max-age=3600' }
        res.writeHead(upRes2.statusCode ?? 502, h2)
        upRes2.pipe(res)
      })
      r2.on('error', (e) => { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('img proxy err: ' + e.message) })
      return
    }
    const headers = { ...upRes.headers, 'cache-control': 'public, max-age=3600' }
    res.writeHead(status, headers)
    upRes.pipe(res)
  })
  proxyReq.on('error', (err) => {
    log('IMG ERR', err.message)
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('img proxy error: ' + err.message)
  })
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://dsh.local')

  // Image proxy route: browser hits same-origin /dsh-img/<url>.
  if (url.pathname.startsWith(IMG_PREFIX) && (req.method === 'GET' || req.method === 'HEAD')) {
    proxyImage(req, res)
    return
  }

  const isRoot = url.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')
  let path = req.url ?? '/'

  if (isRoot) {
    // 若浏览器已带当前 PUBLIC_HOST 的有效 cookie，直接透传，避免多余探测
    if (hasValidCookie(req) || url.searchParams.has('token')) {
      log('root-pass', req.url, 'host=' + (req.headers.host || ''), 'cookie=' + ((req.headers.cookie || '').slice(0, 40) || '-'))
    } else if (TOKEN !== '') {
      // 先原样转发；若 dsh 返回 401（无有效 cookie / 残留旧 cookie），自动重试带 token。
      // 这样任何残留 cookie 状态都能被兜底，不再卡在 authentication required。
      path = withToken(path)
      log('root-token', req.url, 'host=' + (req.headers.host || ''), '->', path)
    }
  } else {
    log(req.method, req.url, 'host=' + (req.headers.host || ''), 'cookie=' + ((req.headers.cookie || '').slice(0, 40) || '-'))
  }

  const proxyReq = http.request(
    { host: TARGET_HOST, port: TARGET_PORT, path, method: req.method, headers: targetHeaders(req) },
    (proxyRes) => {
      log('  <-', proxyRes.statusCode, req.url)
      // 根路径且未带 token 的请求若被 401 拒绝：用 launch token 重试握手。
      // 注意：不能排除 hasValidCookie 的情况——浏览器可能残留匹配当前域名
      // 但签名已失效的旧 cookie（上次实例种的），hasValidCookie 为 true 但 dsh
      // 仍会 401。必须无条件重试带 token，让 dsh 种下新的有效 cookie。
      if (isRoot && proxyRes.statusCode === 401 && !url.searchParams.has('token') && TOKEN !== '') {
        log('  root 401 -> retry with token')
        proxyRes.resume()
        const retryPath = withToken(url.pathname === '/' && url.search === '' ? '/' : url.pathname + url.search)
        const retryReq = http.request(
          { host: TARGET_HOST, port: TARGET_PORT, path: retryPath, method: 'GET', headers: targetHeaders(req) },
          (retryRes) => {
            log('  retry <-', retryRes.statusCode)
            const h2 = { ...retryRes.headers }
            const c2 = String(h2['content-type'] || '').toLowerCase()
            if (c2.includes('text/html')) h2['cache-control'] = 'no-store'
            if (retryRes.url?.includes('/plugins/')) h2['cache-control'] = 'no-cache'
            res.writeHead(retryRes.statusCode ?? 502, h2)
            retryRes.pipe(res)
          },
        )
        retryReq.on('error', (err) => {
          log('  retry ERR', err.message)
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('proxy retry error: ' + err.message)
        })
        retryReq.end()
        return
      }
      const headers = { ...proxyRes.headers }
      const ct = String(headers['content-type'] || '').toLowerCase()
      // Force no-cache on HTML responses so the browser always fetches the
      // newest index.html (which carries the plugin bundle revision). The
      // previous index had no cache-control and browsers kept serving a
      // stale page whose bundle still referenced the old image host.
      if (ct.includes('text/html')) {
        headers['cache-control'] = 'no-store'
      }
      // Plugin combo bundles carry "max-age=31536000, immutable" from the
      // host. That lets both the browser and the lazycat CDN cache the OLD
      // bundle (whose thumbnails still point at unreachable hosts) for a
      // year. Strip the long cache so every page load revalidates and gets
      // the newest bundle revision.
      if (req.url?.includes('/plugins/')) {
        headers['cache-control'] = 'no-cache'
        delete headers.etag
      }
      res.writeHead(proxyRes.statusCode ?? 502, headers)
      proxyRes.pipe(res)
    },
  )
  proxyReq.on('error', (err) => {
    log('  ERR', err.message)
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('proxy error: ' + err.message)
  })
  if (req.method === 'GET' || req.method === 'HEAD') {
    proxyReq.end()
  } else {
    req.pipe(proxyReq)
  }
})

server.on('upgrade', (req, socket, head) => {
  log('WS', req.method, req.url, 'host=' + (req.headers.host || ''), 'upgrade=' + (req.headers.upgrade || ''))
  const headers = upgradeHeaders(req)
  const proxyReq = http.request({
    host: TARGET_HOST,
    port: TARGET_PORT,
    path: req.url ?? '/',
    method: req.method ?? 'GET',
    headers,
  })
  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    log('  WS <- 101 for', req.url)
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${proxyRes.headers['sec-websocket-accept'] ?? ''}\r\n\r\n`,
    )
    proxySocket.on('data', (chunk) => socket.write(chunk))
    socket.on('data', (chunk) => proxySocket.write(chunk))
    if (proxyHead && proxyHead.length > 0) socket.write(proxyHead)
    socket.on('close', () => proxySocket.destroy())
    proxySocket.on('close', () => socket.destroy())
    socket.on('error', () => proxySocket.destroy())
    proxySocket.on('error', () => socket.destroy())
  })
  proxyReq.on('response', (proxyRes) => {
    log('  WS <- non-upgrade response', proxyRes.statusCode, req.url)
    socket.write(`HTTP/1.1 ${proxyRes.statusCode ?? 502} ${proxyRes.statusMessage ?? ''}\r\n`)
    for (const [k, v] of Object.entries(proxyRes.headers)) socket.write(`${k}: ${v}\r\n`)
    socket.write('\r\n')
    proxyRes.pipe(socket)
  })
  proxyReq.on('error', (err) => {
    log('  WS ERR', err.message)
    socket.destroy()
  })
  proxyReq.end(head)
})

server.listen(LISTEN, '0.0.0.0', () => {
  console.error(`dsh-auth-proxy listening on 0.0.0.0:${LISTEN} -> ${TARGET_HOST}:${TARGET_PORT} public=${PUBLIC_HOST || '(passthrough)'} img=${IMG_PREFIX}->${GHPROXY} debug=${DEBUG ? 'on' : 'off'}`)
})