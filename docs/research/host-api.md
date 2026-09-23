# DSH 0.1.5-rc.2 — Host-side (Node.js / Cordis) plugin API

Reference for authoring a **host-half** DSH plugin that registers HTTP routes and agent tools.

**Primary reference (read first, quoted throughout):**
`/Users/ravooo/Library/Application Support/dsh-desktop/harness/profiles/web/node_modules/dsh-webpage-element-picker/`
(`lib/index.js` = host half, `lib/client.js` = browser half, `README.md`, `cordis.patch.yml`, `package.json`)

**Framework packages (shipped JS, no `.d.ts` on disk):**
`/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/`
Notably `dsh-host-webserver`, `dsh-web`, `dsh-web-app`, `dsh-api-gateway`, `dsh-client-connection`,
`dsh-client-modules`, `dsh-host-frontend-static`, `dsh-tools`, `dsh-system-prompt`, `dsh-subprocess`,
`dsh-subprocess-local`, `dsh-fs`, `dsh-sandbox-policy`, `dsh-settings`.

Everything quoted below is verbatim from disk with file path + line numbers. Where I could not prove
something from source I say so in §5 rather than guessing.

---

## 1. Executive summary — the exact recipe (25 points, one line-item each)

1. **Shape.** A host plugin is an ESM module exporting `name`, `inject`, `apply(ctx, config)`. The
   exported `name` must equal the package name **and** the Loader row `name` — that one string is what
   both the host Loader and the client-modules scanner key on (`dsh-webpage-element-picker/lib/index.js:4–5`;
   `cordis.patch.yml` header comment).
2. **`inject` is the wait-list.** `var inject = ["subprocess","webServer","sandboxPolicy","fs","tools","systemPrompt","timer"];`
   — Cordis will not call `apply` until all seven services exist. Read them with `ctx.get("<name>")`
   (`index.js:5`, `23–29`). A missing name means the plugin silently never runs.
3. **HTTP routes:** `ctx.get("webServer").register({ kind: "exact" | "prefix", path, handler })`
   returns a disposer. Wrap every registration in `ctx.effect(() => register(...), "label")` so it is
   torn down with the fiber (`index.js:293–324`; framework: `dsh-host-webserver/lib/index.js:176–183`).
4. **The handler receives raw Node `(req, res)`** — `IncomingMessage` / `ServerResponse`, **not**
   WHATWG `Request`/`Response`. Proof: the framework calls `await route.handler(req, res)` straight out
   of `createServer((req, res) => …)` (`dsh-host-webserver/lib/index.js:228–259`).
5. **Reading a body:** accumulate `req.on("data")` / `req.on("end")`, or `for await (const chunk of req)`.
   The working plugin buffers manually with a 1 MB overflow guard (`index.js:329–351`).
6. **Status / headers:** `res.writeHead(200, { "Content-Type": "application/json" })` then `res.end(JSON.stringify(result))`
   (`index.js:390–391`); `res.writeHead(404, {...})` for unknown methods (`index.js:385–386`).
7. **Streaming:** keep the `res` open and call `res.write(...)` / `res.end(...)` later. The working
   plugin's `/poll` route parks the response in a waiter list resolved by a timer after 25 s
   (`index.js:296–323`) — de-facto long-poll/SSE shape.
8. **Path matching:** exact-table hit first, else **longest-prefix-wins**; a prefix route `/foo` matches
   `/foo` and `/foo/bar` but **not** `/foobar` (`dsh-host-webserver/lib/index.js:321–331`).
9. **Prefix rule of thumb:** reserve one top-level segment per plugin, e.g. `/dsh-webpage-element-picker/...`.
   Duplicate `(kind, path)` **throws** — cross-profile double-registration is a real failure mode
   (`dsh-host-webserver/lib/index.js:178`; working plugin `index.js:401–403`).
10. **`ctx.webServer.port` / `.host`** give the bound listener; use `port` to tell a subprocess where to
    call back (`index.js:510–511`; framework getters `dsh-host-webserver/lib/index.js:162–169`).
11. **Raw HTTP upgrade (WebSocket) IS reachable:** `ctx.webServer.registerUpgrade({ path, handler(req, socket, head) })`
    (`dsh-host-webserver/lib/index.js:190–196`). `ws@8.21.3` is importable from a plugin.
12. **The in-tree precedent** is `@deepseek-ai/dsh-api-gateway`, which holds `new WebSocketServer({ noServer: true })`
    and calls `mux.handleUpgrade(req, socket, head)` from inside a `registerUpgrade` route
    (`dsh-api-gateway/lib/index.js:7, 203, 223–225, 460–472`). Confirmed end-to-end.
13. **Agent tool:** `ctx.get("tools").register({ name, description, parameters, output: { schema, render }, async execute(args) {...} })`
    returns the disposer (`index.js:199–224`).
14. `parameters` is **raw JSON Schema** (`{type:"object", properties, required}`); `output.schema` must
    pass the enforced JSON-Schema subset (`{}` = unconstrained, accepted). `render(args, value)` returns
    content blocks, e.g. `[{ type: "text", text: JSON.stringify(value, null, 2) }]`
    (`index.js:202–212`; framework `dsh-tools/lib/index.js:2773–2786`, `dsh-tools/lib/types/index.js:449–470`).
15. `execute`'s value is validated against `output.schema` and deep-frozen before `render` runs; throwing
    inside `execute` is the error path (`dsh-tools/lib/types/index.js:1173–1180`).
16. **System prompt:** `systemPrompt.context({ name, order, text: () => buildSummary() })` — `text` is a
    **thunk**, re-evaluated per assembly (`index.js:190–194`; `dsh-system-prompt/lib/index.js:264–266`).
17. Set `name` to something unique; `order` must be a **finite number** (it throws otherwise).
18. **Subprocess:** `subprocess.spawn({ argv, cwd, stdio: { stdin, stdout, stderr }, graceMs })` returns a
    handle synchronously; `handle.stdout` is an async iterable, `handle.stdin.write(...)`,
    `handle.done.then(outcome => outcome.exitCode)`, `handle.terminate()` (`index.js:55–60, 513–518, 523–538, 646–650`).
19. `stderr: { maxBytes: 65536 }` selects bounded **collected** output, read non-consumingly via
    `handle.collected.stderr.readFrom(0)` → `{ text, nextOffset, lossy, spillPath? }` (`index.js:440–443`).
20. **Plugin-relative resources:** `fileURLToPath(new URL("../resources/", import.meta.url))` — there is
    **no** `ctx.baseDir` anywhere in DSH or cordis. The working plugin also probes external fallbacks and
    validates the directory with `fs.resolve` + `fs.stat` (`index.js:42–48, 95–133`).
21. **Workspace root:** `ctx.get("sandboxPolicy").workspaceRoot` (used as `cwd` for spawns) —
    `index.js:29, 103, 515`.
22. **Client half static assets are served by the framework, not by you:** `dsh-client-modules` claims the
    prefix route `/plugins` and serves `/plugins/<package-name>/client.js` (+ `.map`), driven by the
    package's `dsh.client` manifest (`dsh-client-modules/lib/index.js:506–512, 662–690`).
23. **CSP: DSH sets none.** There is no `Content-Security-Policy` and no `X-Frame-Options` on the DSH
    index page, on `/plugins/*`, or on plugin routes. The only CSP in the whole tree is on
    `/api/file` media responses: `"sandbox; default-src 'none'"` (`dsh-api-session-controller/lib/index.js:2361`).
24. **Plugin routes are unauthenticated by default.** The working plugin's `/invoke` has no fence. If you
    need the browser-auth/Host-Origin fence, call `ctx.connection.requestRejection(req)` yourself and
    answer `403`/`401` (`dsh-client-connection/lib/index.js:552–556, 604–618`).
25. **Body cap and gzip:** `dsh web` mounts the webserver with `compression: gzip` (threshold 1024 B);
    `content-type: text/event-stream` and `content-range` responses are auto-excluded from gzip
    (`dsh-web-app/cordis.patch.yml:135–142`; `dsh-host-webserver/lib/index.js:106–130`).

---

## 2. Verbatim API reference

### Q1 — Registering an HTTP route on DSH's own web server

**Service name: `webServer`** on `ctx`. There is **no** `ctx.webServer.get(...)` / `.post(...)` router
abstraction. The only three registration methods are `register`, `registerUpgrade`, `registerFallback`
(plus `tapIndex` and the index-injection machinery).

#### 2.1 The working plugin's three routes

`dsh-webpage-element-picker/lib/index.js:289–412` (verbatim, abridged only in log strings):

```js
  const handlers = /* @__PURE__ */ new Map();
  ctx.effect(() => {
    const disposers = [];
    try {
      disposers.push(webServer.register({
        kind: "exact",
        path: "/dsh-webpage-element-picker/poll",
        handler: (req, res) => {
          if (commandQueue.length > 0) {
            const cmd = commandQueue.shift();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(cmd));
            return;
          }
          let finished = false;
          let timeoutDisposer = null;
          const entry = {
            finish: (cmd) => {
              if (finished) return;
              finished = true;
              if (timeoutDisposer) timeoutDisposer();
              const idx = pollWaiters.indexOf(entry);
              if (idx >= 0) pollWaiters.splice(idx, 1);
              try {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(cmd === null ? "null" : JSON.stringify(cmd));
              } catch {
              }
            }
          };
          timeoutDisposer = timer.timeout(() => entry.finish(null), 25e3);
          pollWaiters.push(entry);
          logDebug("长轮询挂起（当前等待者 " + pollWaiters.length + "）");
          req.on("close", () => entry.finish(null));
        }
      }));
      disposers.push(webServer.register({
        kind: "exact",
        path: "/dsh-webpage-element-picker/events",
        handler: (req, res) => {
          let body = "";
          let overflow = false;
          req.on("data", (d) => {
            if (overflow) return;
            body += String(d);
            if (body.length > 1e6) {
              overflow = true;
              body = "";
              logWarn("事件载荷超过 1MB，已丢弃");
            }
          });
          req.on("end", () => {
            if (!overflow) {
              let msg = null;
              try {
                msg = JSON.parse(body || "{}");
              } catch {
              }
              if (msg && msg.event) handleEvent(msg.event);
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end("{}");
          });
        }
      }));
      disposers.push(webServer.register({
        kind: "exact",
        path: "/dsh-webpage-element-picker/invoke",
        handler: (req, res) => {
          let body = "";
          let overflow = false;
          req.on("data", (d) => { /* … same 1MB guard … */ });
          req.on("end", () => {
            let msg = null;
            try { msg = JSON.parse(body || "{}"); } catch { }
            const method = msg && typeof msg.method === "string" ? msg.method : "";
            const params = msg && typeof msg.params === "object" && msg.params !== null ? msg.params : {};
            /* … logging … */
            const handler = handlers.get(method);
            if (!handler) {
              logWarn("未知调用方法: " + (method || "(空)"));
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: "未知方法: " + method }));
              return;
            }
            Promise.resolve().then(() => handler(params)).then((result) => {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify(result));
            }).catch((err) => {
              logError("调用 " + method + " 失败", err);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
            });
          });
        }
      }));
      logInfo("HTTP 路由已注册: /poll /events /invoke");
    } catch (err) {
      logError("路由注册失败（可能被本插件的另一个实例占用）", err);
    }
    return () => {
      for (const d of disposers) {
        try { d(); } catch { }
      }
    };
  });
```

Notes taken from this code:

* The service object is captured **once** at the top of `apply` — `const webServer = ctx.get("webServer");`
  (`index.js:24`) — and the registrations happen inside a single `ctx.effect(() => { … return disposer })`.
* `timer` is `ctx.get("timer")` (`index.js:25`), used as `timer.timeout(cb, ms)`. Framework:
  `cordis-plugin-timer/lib/index.js:4–6, 24` (this is the **deprecated** shim: the doc comments at
  `:16` and `:20` say *"@deprecated use `ctx.timeout()` instead"* — both work).
* A **failed** register (duplicate path) is caught and logged, not thrown — the plugin degrades.
* The client half calls exactly this route same-origin:
  `const INVOKE_PATH = "/dsh-webpage-element-picker/invoke";` (`lib/client.js:29`).

#### 2.2 The framework contract — `dsh-host-webserver/lib/index.js`

Service class registration:

```js
// dsh-host-webserver/lib/index.js:138–161
var WebServer = class extends Service {
	config;
	static Config = z.object({
		host: z.union([z.const("127.0.0.1"), z.const("0.0.0.0")]).required(),
		port: z.natural().max(65535).required(),
		compression: z.union([z.const("none"), z.const("gzip")]).default(DEFAULT_COMPRESSION),
		compressionLevel: z.number().step(1).min(0).max(9).default(DEFAULT_COMPRESSION_LEVEL),
		compressionThresholdBytes: z.natural().default(DEFAULT_COMPRESSION_THRESHOLD_BYTES)
	});
	exact = /* @__PURE__ */ new Map();
	prefixes = /* @__PURE__ */ new Map();
	upgrades = /* @__PURE__ */ new Map();
	upgradedSockets = /* @__PURE__ */ new Set();
	indexTaps = [];
	fallback;
	server;
	listenedPort;
	gzip;
	constructor(ctx, config) {
		super(ctx, "webServer");
		this.config = config;
		const resolved = config;
		this.gzip = resolved.compression === "gzip" ? createGzipMiddleware(resolved) : void 0;
	}
	/** The listening port (the OS-assigned value when config.port is 0). */
	get port() {
		return this.listenedPort;
	}
	/** The configured bind host (the loopback or all-interfaces literal). */
	get host() {
		return this.config.host;
	}
```

Route registration:

```js
// dsh-host-webserver/lib/index.js:170–183
	/**
	* Register a named route. Duplicate (kind, path) throws — route patterns are
	* a composition-level contract, so a collision is a misconfiguration.
	* @param route - kind, path, and the owning handler.
	* @returns the disposer removing the route.
	*/
	register(route) {
		const table = route.kind === "exact" ? this.exact : this.prefixes;
		if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
		table.set(route.path, route);
		return () => {
			table.delete(route.path);
		};
	}
```

Dispatch — **this is where "Node req/res, not WHATWG Request" is decided**:

```js
// dsh-host-webserver/lib/index.js:226–259
	/** Listen; resolves once the socket is bound (rejection = FAILED fiber). */
	async [Service.init]() {
		const handle = async (req, res) => {
			/* v8 ignore next -- `?? '/'` arm: node:http always sets url on server
			requests; the field is only optional on the client-side IncomingMessage type */
			const rawPath = new URL(req.url ?? "/", "http://x").pathname;
			const route = this.match(rawPath);
			if (route !== void 0) {
				await route.handler(req, res);
				return;
			}
			const fallback = this.fallback;
			if (fallback === void 0) {
				res.writeHead(404);
				res.end();
				return;
			}
			await fallback(req, res);
		};
		this.server = createServer((req, res) => {
			const next = () => {
				handle(req, res).catch((err) => {
					this.ctx.logger.warn(err instanceof Error ? err : new Error(String(err)));
					if (res.headersSent) {
						res.destroy();
						return;
					}
					res.writeHead(400);
					res.end();
				});
			};
			if (this.gzip === void 0) next();
			else this.gzip(req, res, next);
		});
```

Two consequences worth internalizing:

* A **thrown** handler is caught by the framework, logged via `ctx.logger.warn`, and answered `400`
  (or `res.destroy()` if headers were already sent). It never crashes the server.
* When gzip is on (it is, for `dsh web`), the compression middleware runs **before** your handler, so
  your `res` is the compression-wrapped response.

Prefix/exact matching:

```js
// dsh-host-webserver/lib/index.js:321–331
	/** Longest-prefix-wins over the prefix table after an exact-table miss. */
	match(pathname) {
		const exact = this.exact.get(pathname);
		if (exact !== void 0) return exact;
		let best;
		for (const [prefix, route] of this.prefixes) {
			if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
			if (best === void 0 || prefix.length > best.path.length) best = route;
		}
		return best;
	}
```

**Prefix rules, precisely:**

| registered `kind` | `path` | matches | not matched |
|---|---|---|---|
| `exact` | `/x` | `/x` only (query string ignored — pathname is used) | `/x/`, `/x/y` |
| `prefix` | `/x` | `/x`, `/x/y`, `/x/y/z` | `/xy` |
| `fallback` | — | anything no named route claimed | — |

The pathname is normalized through `new URL(req.url ?? "/", "http://x").pathname`, so the query string
never participates in matching.

#### 2.3 Reading a body, status, headers, streaming — the framework's own idioms

Body read (bounded, with `content-length` pre-check) from `dsh-host-open-in-app/lib/index.js:1373–1400+`
and `dsh-client-connection/lib/index.js:33–104`:

```js
// dsh-client-connection/lib/index.js:47–73 (buffered branch of bridge())
	if (bodyMode === "buffered") {
		const declaredLength = req.headers["content-length"];
		if (declaredLength !== void 0 && Number(declaredLength) > maxRequestBodyBytes) {
			res.writeHead(413, { connection: "close" });
			res.end();
			req.destroy();
			return;
		}
		const chunks = [];
		let received = 0;
		for await (const chunk of req) {
			const buffer = chunk;
			received += buffer.byteLength;
			if (received > maxRequestBodyBytes) {
				res.writeHead(413, { connection: "close" });
				res.end();
				req.destroy();
				return;
			}
			chunks.push(buffer);
		}
		request = new Request(url, { method, headers, ...chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}, signal: abort.signal });
	}
```

Headers + status, plus binary body, from `dsh-host-open-in-app/lib/index.js:1367–1370`:

```js
			res.statusCode = 200;
			res.setHeader("content-type", icon.contentType);
			res.setHeader("cache-control", "public, max-age=3600");
			res.end(icon.bytes);
```

**Streaming a response body out chunk-by-chunk** (the framework's own backpressure-aware loop,
`dsh-client-connection/lib/index.js:83–103`):

```js
	const responseHeaders = Object.fromEntries(response.headers.entries());
	res.writeHead(response.status, requestUnread ? {
		...responseHeaders,
		connection: "close"
	} : responseHeaders);
	if (response.body === null) {
		res.end();
		if (requestUnread) req.destroy();
		return;
	}
	for await (const chunk of response.body) if (!res.write(chunk)) await new Promise((resolve) => {
		const done = () => {
			res.off("drain", done);
			res.off("close", done);
			resolve();
		};
		res.once("drain", done);
		res.once("close", done);
	});
	res.end();
```

**Gzip is transparently excluded for SSE / ranged responses** — set `Content-Type: text/event-stream`
before the first write and the middleware declines (`dsh-host-webserver/lib/index.js:106–130`):

```js
function createGzipMiddleware(config) {
	const middleware = compressionMiddleware({
		level: config.compressionLevel,
		threshold: config.compressionThresholdBytes,
		filter(request, response) {
			if (response.getHeader("content-range") !== void 0) return false;
			const contentType = response.getHeader("content-type");
			if (typeof contentType === "string" && contentType.toLowerCase().startsWith("text/event-stream")) return false;
			return compressionMiddleware.filter(request, response);
		}
	});
	return (req, res, next) => {
		if (res.socket === void 0) {
			next();
			return;
		}
		const encoding = new Negotiator(req).encoding(["gzip", "identity"]);
		const gzipRequest = Object.create(req);
		Object.defineProperty(gzipRequest, "headers", { value: {
			...req.headers,
			"accept-encoding": encoding === "gzip" ? "gzip" : "identity"
		} });
		middleware(gzipRequest, res, next);
	};
}
```

> Caveat: `filter` runs when the response headers are known (at `writeHead`/first `write`), not at
> request time. For a long-lived stream, set `Content-Type` **before** any body byte and consider
> `res.flushHeaders()`.

#### 2.4 The WHATWG alternative: `ctx.connection.fetch.register`

If you prefer `Request` → `Response`, the `connection` service exposes an exact-path fetch registry
(`dsh-client-connection/lib/index.js:539–551, 587–590`):

```js
	/** Exact Fetch-route registry scoped to the Context reading this service. */
	get fetch() {
		const owner = this.ctx;
		return { register: (route) => this.registerFetchRoute(owner, route) };
	}
```

…but it is mounted **only under the `/api` prefix** (`this.fetchRoutes.get(url.pathname)`,
`createSharedFetchHandler(channel)` at `:570–586`, mounted at `:767–781` with `path: API_PATH`).
`requestBodyMode()` returns `"buffered" | "streaming"` per route. This is a *harness RPC* channel, not
a general-purpose router; for a plugin-owned route, `webServer.register` is the intended API.

#### 2.5 Authentication: plugin routes are public by default

`dsh-host-open-in-app/lib/index.js` is the in-tree example of self-fencing an exact route:

```js
	/** Answer an untrusted/unauthenticated request; true when it was rejected. */
	const rejected = (req, res) => {
		const rejection = connectionOf(ctx).requestRejection(req);
		if (rejection === void 0) return false;
		res.statusCode = rejection;
		res.end();
		return true;
	};
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: OPEN_IN_APP_APPS_ROUTE,
		handler: async (req, res) => {
			if (rejected(req, res)) return;
			…
```

and the fence itself (`dsh-client-connection/lib/index.js:552–556`):

```js
	/** Apply the configured Host/Origin fence, then browser authentication. */
	requestRejection(request) {
		if (!isTrustedApiRequest(request, this.trustedHosts)) return 403;
		return this.browserAuth.isAuthenticated(request) ? void 0 : 401;
	}
```

`dsh-webpage-element-picker` does **not** do this — its `/invoke` is reachable by anything that can
reach the port (`index.js:293–399`). For a sidebar/picker plugin that is arguably fine (the DSH page
is same-origin), but if the picker proxies arbitrary URLs on the user's behalf, fence it.

---

### Q2 — Raw Node `http` upgrade / WebSocket support: **YES, definitively reachable**

**Evidence chain, all three links present in the shipped 0.1.5-rc.2 tree:**

**(1) The webserver exposes upgrade routes and wires `server.on("upgrade", …)`:**

```js
// dsh-host-webserver/lib/index.js:184–196
	/**
	* Register an exact-path HTTP upgrade route. Duplicate paths throw because
	* one socket can have only one protocol owner.
	* @param route - pathname and handler owning negotiation plus socket use.
	* @returns the disposer removing the route.
	*/
	registerUpgrade(route) {
		if (this.upgrades.has(route.path)) throw new Error(`webserver: duplicate upgrade route "${route.path}"`);
		this.upgrades.set(route.path, route);
		return () => {
			this.upgrades.delete(route.path);
		};
	}
```

```js
// dsh-host-webserver/lib/index.js:260–293
		this.server.on("upgrade", (req, socket, head) => {
			const onError = (error) => {
				this.ctx.logger.warn(error);
				socket.destroy();
			};
			socket.on("error", onError);
			socket.once("close", () => {
				socket.off("error", onError);
				this.upgradedSockets.delete(socket);
			});
			let route;
			try {
				/* v8 ignore next -- node:http always sets url on server requests. */
				route = this.upgrades.get(new URL(req.url ?? "/", "http://x").pathname);
			} catch (error) {
				this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
				socket.destroy();
				return;
			}
			if (route === undefined) {
				socket.destroy();
				return;
			}
			this.upgradedSockets.add(socket);
			try {
				Promise.resolve(route.handler(req, socket, head)).catch((error) => {
					this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
					socket.destroy();
				});
			} catch (error) {
				this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
				socket.destroy();
			}
		});
```

Note: upgrade routing is **exact-path only** (a `Map.get`), and upgraded sockets are tracked so
`webServer` shutdown destroys them (`:305–319`).

**(2) `ws` is imported by a shipped DSH package and driven exactly this way:**

```js
// dsh-api-gateway/lib/index.js:7
import WebSocket, { WebSocketServer } from "ws";
```

```js
// dsh-api-gateway/lib/index.js:11
/** Exact WebSocket route carrying every Typert Remote stream. */
const REMOTE_STREAM_MUX_PATH = "/api/remote.mux";
```

```js
// dsh-api-gateway/lib/index.js:199–204
/** Own the no-server WebSocket acceptor and every active logical stream. */
var RemoteStreamMuxServer = class {
	open;
	failure;
	heartbeatIntervalMs;
	server = new WebSocketServer({ noServer: true });
```

```js
// dsh-api-gateway/lib/index.js:215–225
	/**
	* Upgrade one trusted request and begin serving its logical streams.
	* @param req - authenticated HTTP upgrade request.
	* @param socket - carrier socket transferred to the WebSocket server.
	* @param head - bytes already read after the HTTP upgrade headers.
	*/
	handleUpgrade(req, socket, head) {
		this.server.handleUpgrade(req, socket, head, (websocket) => {
			this.missedHeartbeats.set(websocket, 0);
			websocket.on("pong", () => {
				this.missedHeartbeats.set(websocket, 0);
			});
			this.startHeartbeat();
```

```js
// dsh-api-gateway/lib/index.js:460–473  (the plugin-side registration)
		ctx.inject(["connection", "webServer"], (webCtx) => {
			const mux = new RemoteStreamMuxServer((endpoint, payload, signal) => this.openWireStream(endpoint, payload, signal), this.wireStream.failure, resolved.websocketHeartbeatIntervalMs);
			webCtx.effect(() => {
				const route = {
					path: REMOTE_STREAM_MUX_PATH,
					handler: (req, socket, head) => {
						const rejection = webCtx.connection.requestRejection(req);
						if (rejection !== undefined) {
							rejectRemoteStreamUpgrade(socket, rejection);
							return;
						}
						mux.handleUpgrade(req, socket, head);
					}
				};
				const unregister = webCtx.webServer.registerUpgrade(route);
				return async () => {
					unregister();
					await mux.close();
				};
			}, `api-gateway: ${REMOTE_STREAM_MUX_PATH} WebSocket`);
		});
```

**(3) `ws` resolves from a plugin installed in the web profile.** Empirically verified:

```console
$ node --input-type=module -e 'import {createRequire} from "node:module"; …'
OK   ws -> /Applications/DSH Desktop.app/Contents/Resources/app/node_modules/ws/index.js
OK   @deepseek-ai/dsh-host-webserver -> …/dsh-host-webserver/lib/index.js
OK   @deepseek-ai/cordis -> …/cordis/lib/index.js
ws keys: CONNECTING,OPEN,CLOSING,CLOSED,createWebSocketStream,extension,PerMessageDeflate,
         Receiver,Sender,Server,subprotocol,WebSocket,WebSocketServer | version 8.21.3
```

because Node's resolution chain from
`…/harness/profiles/web/node_modules/<plugin>/lib/` reaches
`…/harness/profiles/node_modules/`, where `ws` and every `@deepseek-ai/*` package are **symlinks**
into the app bundle:

```console
$ ls -la "…/harness/profiles/node_modules/ws"
lrwxr-xr-x@ … ws -> /Applications/DSH Desktop.app/Contents/Resources/app/node_modules/ws
$ ls -la "…/harness/profiles/node_modules/@deepseek-ai/dsh-host-webserver"
lrwxr-xr-x@ … -> …/app/node_modules/@deepseek-ai/dsh-host-webserver
```

**Answer:** yes. From a host plugin: `ctx.webServer.registerUpgrade({ path: "/your-plugin/mux", handler(req, socket, head) { … } })`,
then either speak the WebSocket handshake yourself or (recommended) hold a
`new WebSocketServer({ noServer: true })` imported from `"ws"` and call
`server.handleUpgrade(req, socket, head, cb)`. Also: `import "ws"` needs no `package.json` dependency
declaration for the profile install shape, **but** declaring it in `dependencies` is the portable
choice. And note `ctx.connection.requestRejection(req)` works on upgrade requests too (see above).

There is **no** `inject` entry needed beyond `"webServer"` (plus `"connection"` if you fence).

---

### Q3 — Registering an agent tool

Exact call from `dsh-webpage-element-picker/lib/index.js:198–228` (verbatim; the Chinese strings are
the tool description shown to the model):

```js
  try {
    ctx.effect(() => tools.register({
      name: "read_picked_element",
      description: "读取「添加页面元素」功能从内置浏览器中选中的页面元素完整信息（HTML、CSS 选择器、DOM 路径、属性、位置尺寸、页面 URL 等）。系统提示中的页面元素列表给出了可用的 DOM 编号，用户消息中的 [DOMn] 占位符与之一一对应；需要元素细节时按编号读取。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "DOM 编号，如 DOM1（见系统提示中的页面元素列表）" }
        },
        required: ["id"]
      },
      output: {
        schema: {},
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
      },
      async execute(args) {
        const id = String(args && args.id || "");
        logInfo("工具调用 read_picked_element: id=" + (id || "(空)"));
        if (!id) throw new Error("read_picked_element 需要参数 id（如 DOM1）");
        const entry = domRegistry.find((e) => e.id === id);
        if (!entry) {
          logDebug("元素编号未命中: " + id + "（当前可用 " + domRegistry.length + " 个）");
          return { ok: false, error: "未找到元素 " + id + "，可用编号: " + domRegistry.map((e) => e.id).join(", ") };
        }
        return { ok: true, id: entry.id, element: entry.payload };
      }
    }));
    logInfo("动态工具 read_picked_element 已注册");
  } catch (err) {
    logError("工具注册失败（模型将无法读取页面元素详情）", err);
  }
```

**`dsh-tools/lib/index.js:2767–2786` — the whole validation contract of `register`:**

```js
	/**
	* Register globally or in the calling agent scope. Scoped tools shadow
	* globals; duplicates within one layer and the reserved `run_code` name fail.
	* @param definition - tool schema, execution, and optional finalization/presentation callbacks.
	* @returns the exact disposer that unregisters the tool.
	*/
	register(definition) {
		const name = definition.name;
		const output = definition.output;
		if (output === void 0 || typeof output !== "object" || typeof output.render !== "function" || output.presentationMeta !== void 0 && typeof output.presentationMeta !== "function") throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
		assertSupportedJsonSchema(output.schema);
		const timeoutMs = definition.timeoutMs;
		if (timeoutMs !== void 0 && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`);
		if (name === "run_code") throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the PTC mode presentation transport and cannot be registered or shadowed`);
		return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, definition), { label: "tools.register()" });
	}
```

**Definition shape (assembled from the framework):**

| field | required | shape / semantics |
|---|---|---|
| `name` | ✔ | string; `"run_code"` is reserved and throws |
| `description` | ✔ (used by `schemaOf`) | string shown to the model |
| `parameters` | ✔ | **raw JSON Schema**, object-rooted; must be lossless JSON — `schemaOf` throws `tool "<n>" parameters must be lossless JSON before schema projection` otherwise (`dsh-tools/lib/types/index.js`, `schemaOf`) |
| `output` | ✔ | `{ schema, render, presentationMeta? }`; `render` must be a function; `schema` must pass `assertSupportedJsonSchema` (`{}` is accepted as unconstrained JSON) |
| `execute` | ✔ | `async (args, exec) => value` — `exec` is the execution context (`dsh-tools/lib/types/index.js:933`: `const returned = await tool.execute(exec.arguments, exec);`) |
| `timeoutMs` | ✘ | positive finite number |
| `finalizeContent`, `presentCall`, `presentResult`, `isConcurrencySafe` | ✘ | optional presentation/lifecycle callbacks |

**Return-value shape:** `execute` returns a plain JSON value (the working plugin returns
`{ ok: true, id, element }` or `{ ok: false, error }`). The registry snapshots it, validates it against
`output.schema`, **deep-freezes** it, then calls `output.render(args, value)` and snapshots the
resulting content blocks (`dsh-tools/lib/types/index.js:1165–1200`):

```js
    createSuccessResult(exec, tool, candidate) {
        const detached = snapshotToolValue(tool.name, candidate);
        const violations = validateJsonSchemaValue(tool.output.schema, detached, 'value');
        if (violations.length > 0) {
            throw new ToolOutputError(tool.name, violations);
        }
        const value = deepFreeze(detached);
        let rendered;
        try {
            rendered = tool.output.render(exec.arguments, value);
        }
        catch (error) {
            throw projectionError(tool.name, 'render', error);
        }
        const content = snapshotProjection(tool.name, 'render', rendered);
```

`render` returns content blocks; the working plugin's `[{ type: "text", text: … }]` is the canonical
text form.

**Typed alternative — `defineTool`** (`dsh-tools`, exported from `lib/types/schema.js:274`): compiles a
schemastery-flavoured `parameters` spec + `output.schema` into the same raw JSON Schema and adds
argument validation:

```js
export function defineTool(options) {
    …
    const parameters = parameterSchemaSpecToJsonSchema(options.parameters);
    const outputSchema = valueSchemaSpecToJsonSchema(options.output.schema);
    const validate = (args) => validateJsonSchemaValue(parameters, args, '');
    const tool = {
        name: options.name,
        description: options.description,
        parameters: parameters,
        output: {
            schema: outputSchema,
            render(args, value) { return userRender(args, value); },
            …
        },
        …
        async execute(args, exec) {
            const violations = validate(args);
            if (violations.length > 0) throw new ToolArgsError(violations);
            return userExecute(args, exec);
        },
    };
```

Importing it from a profile-installed plugin works (`@deepseek-ai/dsh-tools` resolves — see Q2). The
working plugin does **not** use it; it passes raw JSON Schema.

---

### Q4 — Injecting text into the system prompt

Exact call from `dsh-webpage-element-picker/lib/index.js:189–197`:

```js
  try {
    ctx.effect(() => systemPrompt.context({
      name: "webpage-element-picker",
      order: 60,
      text: () => buildSummary()
    }));
  } catch (err) {
    logError("系统提示上下文注册失败（页面元素列表将不会出现在系统提示中）", err);
  }
```

with `buildSummary()` producing the flat list (`index.js:174–188`):

```js
  const buildSummary = () => {
    if (domRegistry.length === 0) return "";
    const lines = ["页面元素列表（用户消息中的 [DOMn] 占位符与下列编号一一对应）："];
    for (const e of domRegistry) {
      const p = e.payload || {};
      const parts = [String(p.tagName || "?")];
      if (p.id) parts.push("#" + p.id);
      if (p.textContent) parts.push("“" + String(p.textContent).slice(0, 40) + "”");
      lines.push(e.id + "=" + parts.join(" ") + " (" + (p.pageUrl || "") + ")");
    }
    lines.push(
      '需要某个元素的完整信息（HTML/CSS选择器/属性/位置尺寸）时，调用 read_picked_element 工具，参数如 {"id":"DOM1"}。'
    );
    return lines.join("\n");
  };
```

**`systemPrompt.context(context)` — `dsh-system-prompt/lib/index.js:259–266`:**

```js
	/**
	* Register ordered dynamic context in the calling context's scope. Scoped
	* …
	*/
	context(context) {
		if (!Number.isFinite(context.order)) throw new TypeError(`prompt context "${context.name}" order must be a finite number`);
		return this.layers.effect(this.ctx, (layer) => layer.contexts.insert(context.name, context), { label: "systemPrompt.context()" });
	}
```

**Arguments:** `{ name: string, order: number, text: () => string }`. `text` is a **thunk** — it is
re-evaluated every time the prompt is assembled, which is why the working plugin can mutate
`domRegistry` and have the prompt follow. Return `""` to contribute nothing (the working plugin's
empty-registry case).

There is a sibling API for static/ordered **sections** — `systemPrompt.section({ name, order, text })`
(`:231–240`) — used by `dsh-web-app` (`dsh-web-app/lib/index.js:180–184`):

```js
			promptCtx.systemPrompt.section({
				name: "app:web-surface",
				order: promptCtx.systemPrompt.getSectionOrder("WEB_SURFACE"),
				text: () => webSurfacePrompt(localWebUrl(promptCtx))
			});
```

`getSectionOrder(name)` / `getContextOrder(name)` (`:245–257`) map symbolic names to the framework's
reserved numeric slots; `CONTEXT_ORDERS` at `:43–47` currently only defines
`SANDBOX_POLICY: 110`, `APPROVAL_POLICY: 115`, `SUBAGENT_DELEGATION: 120`. **`60` is a safe custom
slot** — it sits below those and above nothing reserved, so the plugin's block appears early and
deterministically. Note the working plugin hard-codes `60` rather than calling `getContextOrder`.

Also available, seen in the same package: a **`{{variable}}`** substitution layer
(`VARIABLE_NAME = /^[a-z][a-z0-9_]*$/` at `:58`) — not used by the working plugin.

---

### Q5 — Spawning a subprocess + resolving plugin-relative resources

#### 5.1 Spawn

Exact call from `dsh-webpage-element-picker/lib/index.js:502–522` (inside `ensureHelper`):

```js
    starting = (async () => {
      try {
        const startedAt = Date.now();
        const resourceDir = await resolveResourceDir();
        const res = await loadResources(resourceDir);
        const payloadText = res.helper + "\n<<<DSH_SPLIT>>>\n" + res.inspector + "\n<<<DSH_END>>>\n";
        const node = await subprocess.resolveExecutable("node");
        const launcher = await resolveNpmCli(node);
        const port = typeof webServer.port === "number" && webServer.port > 0 ? webServer.port : 0;
        if (port === 0) throw new Error("DSH web 服务器端口不可用");
        logDebug("启动参数: node=" + node + " npmCli=" + launcher + " webPort=" + port);
        const boot = subprocess.spawn({
          argv: [node, resourceDir + "/bootstrap.cjs", launcher, String(port)],
          cwd: workspaceRoot,
          stdio: { stdin: "pipe", stdout: "pipe", stderr: { maxBytes: 65536 } },
          graceMs: 3e3
        });
        handle = boot;
        payloadSent = false;
        lineBuf = "";
```

A minimal one-shot variant, same file `:55–60`:

```js
        const probe = subprocess.spawn({
          argv: [node, "-e", "console.log(process.env.USERPROFILE || process.env.HOME || '')"],
          cwd: workspaceRoot,
          stdio: { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
          graceMs: 3e3
        });
```

**Getting stdio.** Async-iterate `stdout` (raw pipe, `:70–79, 413–437`):

```js
          (async () => {
            for await (const chunk of probe.stdout) {
              buf += String(chunk);
              const i = buf.indexOf("\n");
              if (i >= 0) {
                finish(buf.slice(0, i).replace(/\r$/, "").trim());
                break;
              }
            }
          })().catch(() => finish(""));
```

Write to `stdin` (`:427`): `boot.stdin.write(payloadText);`

Read bounded collected stderr — **offset-based, non-consuming** (`:438–449`):

```js
  const stderrTail = (boot) => {
    try {
      const c = boot.collected && boot.collected.stderr;
      if (!c) return "";
      const read = c.readFrom(0);
      const lines = String(read.text || "").split("\n").map((s) => s.trim()).filter(Boolean);
      return lines.length ? lines[lines.length - 1].slice(0, 300) : "";
    } catch {
      logDebug("读取 helper stderr 尾部失败");
      return "";
    }
  };
```

Exit + teardown (`:523–537`, `:643–653`):

```js
        boot.done.then((outcome) => {
          if (handle === boot) {
            handle = null;
            const tail = stderrTail(boot);
            const detail = "浏览器进程已退出 (code " + outcome.exitCode + ")" + (tail ? " · " + tail : "");
            if (outcome.exitCode === 0) logInfo(detail);
            else logWarn(detail);
            status = { state: "closed", message: detail };
            for (const [id, w] of Array.from(waiters)) {
              waiters.delete(id);
              w.reject(new Error("浏览器进程已退出"));
            }
          }
        }, () => {
        });
```

```js
  ctx.effect(() => () => {
    if (handle) {
      try {
        if (handle.stdin) handle.stdin.end();
      } catch {
      }
      handle.terminate();
      handle = null;
      logInfo("插件卸载，helper 子进程已终止");
    }
  });
```

**Service contract** (`dsh-subprocess/lib/index.js:57–90`):

```js
/**
* Abstract subprocess service. Subclass, implement {@link spawn}, and load the
* subclass as a plugin — it registers as `ctx.subprocess` (one implementation
* per context; loading a second throws, which is cordis' standard
* duplicate-service behavior).
*
* Implementations must honor these semantics:
* - Executable paths belong to one execution world shared with the mounted
*   filesystem provider.
* - {@link spawn} returns a live handle synchronously. Target identity remains
*   provider-private; `done` resolves with the spawned command's exit facts and
*   may reject for spawn or provider failures.
* - Collect-mode readers are offset-based and non-consuming, so independent
*   readers never consume one another's output; lossy reads report truncation
*   and the spill file holding the complete stream when one exists. Piped
*   streams are handed to the caller raw and never buffered here.
* - {@link SubprocessHandle.terminate} (and the spec's abort signal) starts the
*   provider's documented procedure against its managed range.
*   …
*/
var SubprocessRuntime = class extends Service {
	constructor(ctx) {
		super(ctx, "subprocess");
	}
};
```

Concrete provider is `@deepseek-ai/dsh-subprocess-local`
(`lib/index.js:908–1010`, fallback engine in `lib/runner-launch-COYGu0Dl.js:1133–1160`):

```js
	async resolveExecutable(command, env, signal) {
		if (command.length === 0) throw new Error("subprocess-local: executable must be non-empty");
		signal?.throwIfAborted();
		const environment = childEnv(env);
		const absolute = isAbsolute(command);
		if (!absolute && (command.includes("/") || process.platform === "win32" && command.includes("\\"))) throw new Error(`subprocess-local: command ${JSON.stringify(command)} is a relative path; use an absolute path or a bare PATH name`);
		…
		throw new Error(absolute ? `subprocess-local: command ${JSON.stringify(command)} is not an executable file` : `subprocess-local: command ${JSON.stringify(command)} was not found on PATH`);
	}
	…
	spawn(spec) {
		validateSubprocessSpec(spec);
		const env = targetEnvironment(spec);
```

```js
// lib/runner-launch-COYGu0Dl.js:878–888
function validateSubprocessSpec(spec) {
	if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0 || spec.graceMs > MAX_TIMER_DELAY_MS) throw new Error(`subprocess graceMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	if (spec.signal?.aborted) { … }
	const [program] = spec.argv;
	if (program === void 0 || program.length === 0) throw new Error("invalid argv: expected a non-empty program name at argv[0]");
}
```

and the collected reader result shape (`lib/runner-launch-COYGu0Dl.js:793–800`):

```js
	readFrom(fromByte) {
		const windowStart = this.total - this.bytes;
		const buffer = Buffer.concat(this.chunks);
		const lossy = fromByte < windowStart;
		return {
			text: (lossy ? buffer : buffer.subarray(fromByte - windowStart)).toString("utf8"),
			nextOffset: this.total,
			lossy,
			...this.spillFile !== void 0 ? { spillPath: this.spillFile } : {}
		};
	}
```

**Gotchas:** `graceMs` is **required** and must be a positive finite number ≤ `MAX_TIMER_DELAY_MS`.
`argv[0]` must be an absolute path or a bare PATH name — a *relative path with a slash is rejected*.
`resolveExecutable` resolves bare names against `PATH` and `X_OK`-checks candidates.

#### 5.2 Plugin-relative resource paths

**The working plugin uses `import.meta.url` — and there is no `ctx.baseDir` anywhere in DSH or cordis.**
I grepped every `dsh-*/lib/*.js` and `cordis/lib/` for `baseDir`: **zero matches**.

`dsh-webpage-element-picker/lib/index.js:1–2, 42–48`:

```js
// src/host/index.ts
import { dirname, join } from "path";
import { fileURLToPath } from "url";
```
```js
  const pkgResourceDir = (() => {
    try {
      return fileURLToPath(new URL("../resources/", import.meta.url));
    } catch {
      return "";
    }
  })();
```

Because the built file is `lib/index.js` and resources live in `resources/`, the URL is
`"../resources/"`. This is the correct, portable idiom — it works regardless of `cwd` and regardless of
where the package is installed (npm, pnpm link, git URL, tarball).

The plugin then adds **fallback candidates** (home dir, workspace) and validates the directory by
probing all four needed files with the `fs` service (`:95–133`):

```js
  const resourceDirCandidates = async () => {
    const dirs = [];
    if (pkgResourceDir) dirs.push(pkgResourceDir);
    const home = await discoverHome();
    if (home) {
      dirs.push(home + "/.dsh/_dsh-webpage-element-picker");
      dirs.push(home + "/.dph/_dsh-webpage-element-picker");
    }
    dirs.push(workspaceRoot + "/_dsh-webpage-element-picker");
    return dirs;
  };
  const resolveResourceDir = async () => {
    const needFiles = ["bootstrap.cjs", "helper-playwright.js", "inspector.js", "browser-probe.cjs"];
    const candidates = await resourceDirCandidates();
    for (const c of candidates) {
      let ok = true;
      for (const name2 of needFiles) {
        try {
          const target = await fs.resolve(c + "/" + name2);
          const info = await fs.stat(target);
          if (!info) {
            ok = false;
            break;
          }
        } catch {
          ok = false;
          break;
        }
      }
      if (ok) {
        logInfo("资源目录: " + c);
        return c;
      }
      logDebug("资源候选不完整，跳过: " + c);
    }
    throw new Error(…);
  };
```

…and reads files through the `fs` service, **not** `node:fs` (`:134–143`):

```js
  const loadResources = async (resourceDir) => {
    const readFile = async (name2) => {
      const target = await fs.resolve(resourceDir + "/" + name2);
      return await fs.readText(target);
    };
    return {
      helper: await readFile("helper-playwright.js"),
      inspector: await readFile("inspector.js")
    };
  };
```

`fs` service shapes: `fs.resolve(path, opts?) → Promise<{ targetKey, displayPath }>`,
`fs.stat(target, signal?)`, `fs.readText(target, signal?)`
(`dsh-fs-local/lib/index.js:737–790`); the abstract seam is `dsh-fs/lib/index.js:60`
(`super(ctx, "fs")`).

`subprocess.resolveExecutable` is reused as a *file-exists* probe for npm-cli candidates
(`:475–487`) — a neat trick since it returns the resolved absolute path or throws.

**Workspace root for `cwd`** (`:29`): `const workspaceRoot = ctx.get("sandboxPolicy").workspaceRoot;`
— from `dsh-sandbox-policy/lib/index.js:103–113`
(`workspaceRoot: z$1.string()` … `this.workspaceRoot = resolveWorkspaceRoot(config.workspaceRoot ?? process.cwd())`).

---

### Q6 — The `inject` list

`dsh-webpage-element-picker/lib/index.js:4–5` (lines 1–5 verbatim):

```js
// src/host/index.ts
import { dirname, join } from "path";
import { fileURLToPath } from "url";
var name = "dsh-webpage-element-picker";
var inject = ["subprocess", "webServer", "sandboxPolicy", "fs", "tools", "systemPrompt", "timer"];
```

**How it is declared:** as a module-level `export`ed `const` (here a plain `var` in the built ESM
bundle) named exactly `inject`, a plain array of **service name strings**. The bundle's tail confirms
the export surface (`index.js:655–659`):

```js
export {
  apply,
  inject,
  name
};
```

The module is the Cordis plugin: `name` (stable plugin id, must equal the package name and the Loader
row name), `inject` (dependency gate), `apply(ctx, config)` (the body). Cordis will not call `apply`
until *all* injected services are present; entry into `apply` is the readiness signal.

Each entry is then read at the top of `apply` with `ctx.get("<name>")`
(`index.js:23–29`):

```js
function apply(ctx) {
  const subprocess = ctx.get("subprocess");
  const webServer = ctx.get("webServer");
  const timer = ctx.get("timer");
  const fs = ctx.get("fs");
  const tools = ctx.get("tools");
  const systemPrompt = ctx.get("systemPrompt");
  const workspaceRoot = ctx.get("sandboxPolicy").workspaceRoot;
```

`ctx.get(name)` returns `undefined` rather than throwing for an absent service, so the `inject` list is
the only guarantee; a typo in `inject` makes the plugin silently never run. Note `sandboxPolicy` is
read for a *property*, not a service handle.

The client half declares its own, much shorter list — `inject: ["slots"]`
(`dsh-webpage-element-picker/lib/client.js`, tail):

```js
module.exports = {
  name: PLUGIN_ID,
  inject: ["slots"],
  apply
};
```

---

### Q7 — CSP: **DSH sets none on its own pages or plugin routes**

#### 7.1 The exhaustive grep

```console
$ grep -rn "Content-Security-Policy|contentSecurityPolicy|frame-ancestors|X-Frame-Options" \
    /Applications/DSH\ Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai --include=*.js
dsh-api-session-controller/lib/index.js:2361:  "Content-Security-Policy": "sandbox; default-src 'none'"
dsh-api-session-controller/lib/types/media-references.js:14: 'Content-Security-Policy': "sandbox; default-src 'none'",
```

**Two matches, one constant, one file.** No `frame-ancestors`, no `X-Frame-Options`, no CSP anywhere
else in any shipped DSH package.

#### 7.2 The only CSP, in full

`dsh-api-session-controller/lib/types/media-references.js:1–17`:

```js
/**
* Authenticated GET/HEAD /api/file reads bounded file responses through
* the composed filesystem provider. Paths and MIME types do not restrict access;
* the connection service authenticates requests before this handler.
* @module @deepseek-ai/dsh-api-session-controller/media-references
*/
const BASE_HEADERS = {
	'Cache-Control': 'private, no-store',
	'X-Content-Type-Options': 'nosniff',
	// HTML and SVG files may be opened directly on the authenticated API origin.
	'Content-Security-Policy': "sandbox; default-src 'none'",
};
```

**Exact value: `sandbox; default-src 'none'`** — and it is scoped to `/api/file` responses only (files
served *out of* the workspace), never to the app shell.

#### 7.3 The index page and static assets set no CSP

`dsh-host-frontend-static/lib/index.js:49–75` is the whole serve path — the only header it ever writes
is `content-type`:

```js
async function serveStatic(pathname, res, distRoot, distIndex, authorizeIndex, renderIndex) {
	const target = resolve(normalize(join(distRoot, pathname)));
	…
	let body;
	let type;
	try {
		if (target === distRoot || target === distIndex) {
			if (!authorizeIndex()) return;
			body = await renderIndex();
			type = HTML_MIME;
		} else {
			body = await readFile(target);
			type = MIME[extname(target)] ?? "application/octet-stream";
		}
	} catch (error) { … }
	res.writeHead(200, { "content-type": type });
	res.end(body);
}
```

The shipped `dist/index.html` carries **no `<meta http-equiv="Content-Security-Policy">`**:

```console
$ cat …/dsh-web-frontend/dist/index.html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="manifest" href="./manifest.webmanifest" />
    <link rel="icon" type="image/png" href="/dsh-desktop-logo.png" />
    <title>DeepSeek Harness</title>
    <script type="module" crossorigin src="./assets/index-BKQ_L1z6.js"></script>
    <link rel="modulepreload" crossorigin href="./assets/vendor-CCJJTK99.js">
    <link rel="stylesheet" crossorigin href="./assets/vendor-BNsW4eBh.css">
    <link rel="stylesheet" crossorigin href="./assets/index-DPX2bQLO.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
```

`dsh-client-connection`'s auth paths (`authorizeIndex`, `writeUnauthorized`,
`dsh-client-connection/lib/index.js:386–450`) set only `cache-control`, `location`, `referrer-policy`,
`set-cookie`, `content-type`. The Electron shell's main process
(`/Applications/DSH Desktop.app/Contents/Resources/app/out/main/index.js`) contains **no**
`onHeadersReceived`, no `webRequest` hook, and no CSP string — only a
`setPermissionRequestHandler`.

**Corroborating live probe** (unauthenticated, so it only proves the header set on the pre-auth path —
but it is the same `webServer`):

```console
$ curl -sSI http://127.0.0.1:43129/
HTTP/1.1 401 Unauthorized
cache-control: no-store
content-type: text/plain; charset=utf-8
Vary: Accept-Encoding
Date: Tue, 22 Sep 2026 15:23:10 GMT
```

No `content-security-policy`, no `x-frame-options`.

#### 7.4 What this means for the sidebar/element-picker plan

* **Inline `<script>` on the DSH page works.** No CSP blocks it. Independent corroboration: DSH's own
  `webserver/index-inject` machinery emits inline script by design — `renderRow` case `"script"`
  produces `` `<script>${row.text}<\/script>` `` and case `"global"` produces an inline assignment
  (`dsh-host-webserver/lib/index.js:24–52`), and `dsh-client-modules` pushes rows of both kinds
  (`dsh-client-modules/lib/index.js:439–453`). If a CSP forbade inline script, the framework's own boot
  would be broken.
* **DSH will not block being framed.** No `frame-ancestors`, no `X-Frame-Options`, so an external page
  *may* iframe `http://127.0.0.1:<port>/`. (Whether that is *desirable* is a separate question — the
  401/303 auth dance and cookies make it awkward.)
* **A plugin may inject `Content-Security-Policy` itself** via `webServer.register` (you own the `res`),
  or via a `tapIndex` / index-injection row for the shell page.
* **The blocker for iframing *external* pages is the third party, not DSH.** `dsh-better-sidebar.md`
  §2.5 already catalogs `X-Frame-Options` / `frame-ancestors` refusals; that finding stands unchanged —
  DSH's own headers are simply not part of the problem.
* **One residual risk:** `/api/file` responses carry `sandbox; default-src 'none'`. If the picker loads
  a workspace HTML file through `/api/file` into an iframe, that content is sandboxed and cannot script
  its parent. Serve picker pages from your own route, not `/api/file`.

---

### Q8 — How client-plugin static / extra files are served

#### 8.1 The mechanism: `dsh.client` manifest + framework-owned `/plugins` prefix route

**You do not register a route for your client bundle.** `dsh-client-modules` claims the prefix `/plugins`
and serves everything under it:

```js
// dsh-client-modules/lib/index.js:506–517
		const registerWebCarrier = (webCtx) => {
			webCtx.effect(() => webCtx.webServer.register({
				kind: "prefix",
				path: "/plugins",
				handler: this.serveBundle
			}), "client-modules: bundle route");
		};
		if (ctx.get("webServer") === void 0) ctx.inject(["webServer"], registerWebCarrier);
		else registerWebCarrier(ctx);
		ctx.on("webserver/index-inject", (table) => {
			table.push(...bootInjections(this.composed));
		});
```

```js
// dsh-client-modules/lib/index.js:906
	serveBundle = (req, res) => {
		/* v8 ignore next -- node:http always sets url on server requests. */
		const response = this.bundleResource(req.method, req.url ?? "/");
		res.writeHead(response.status, response.headers);
		res.end(response.body);
	};
```

**Manifest scan** — the package's `dsh.client` declaration is read out of its `package.json`
(`dsh-client-modules/lib/index.js:663–690`):

```js
	resolveMeta(loaderName, baseUrl) {
		…
		const { packageName, path: pkgPath } = located;
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
		const dsh = pkg.dsh;
		const decl = parseDshClient(packageName, dsh !== null && typeof dsh === "object" ? dsh.client : void 0);
		if (decl === void 0 || decl.platform !== "web") {
			this.pkgMeta.set(sourceKey, null);
			return null;
		}
		const clientRel = clientExportOf(packageName, pkg.exports);
		if (clientRel === void 0) throw new Error(`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`);
		const resolved = {
			packageName,
			meta: {
				clientPath: join(dirname(pkgPath), clientRel),
				...decl.inject !== void 0 ? { inject: decl.inject } : {},
				external: decl.external ?? [],
				immediately: decl.immediately === true
			}
		};
```

and the declaration itself is validated at `:140–152`:

```js
/** Narrow an unknown parsed JSON value to the `dsh.client` declaration, throwing on malformed fields. */
function parseDshClient(pkgName, decl) {
	…
	if (typeof decl.platform !== "string") throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`);
	const inject = optionalStringArray(pkgName, "dsh.client.inject", decl.inject);
	const external = optionalStringArray(pkgName, "dsh.client.external", decl.external);
	if (decl.immediately !== void 0 && typeof decl.immediately !== "boolean") throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`);
```

**URL shape** — `/plugins/<package-name>/client.js` and `…/client.js.map`, batched for preload
(`dsh-client-modules/lib/index.js:183`):

```js
	return `/plugins/??${ids.map((id) => `${id}/client.js${sourceMap ? ".map" : ""}`).join(",")}&rev=${rev}`;
```

…and the fallback single-file path at `:213`:

```js
	const fallbackSource = sourceUrl === void 0 ? `/plugins/${record.entry.id}/client.js` : /^(?:[A-Za-z][A-Za-z\d+.-]*:|\/)/.test(sourceUrl) ? sourceUrl : `/${sourceUrl}`;
```

Note the `??` batching syntax: `/plugins/??id1/client.js,id2/client.js&rev=<hash>` — that is the
**resource-batch** form the shell preloads. The plain single-bundle form also works.

#### 8.2 What the working plugin declares

`dsh-webpage-element-picker/package.json`:

```json
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "platform": "web",
      "external": [
        "@deepseek-ai/dsh-client-ui-primitives"
      ]
    }
  }
```

**The three load-bearing keys:**

| key | effect |
|---|---|
| `exports["./client"]` | what `clientExportOf(packageName, pkg.exports)` resolves to; missing ⇒ hard error |
| `dsh.client.platform: "web"` | must be `"web"` or the package is ignored for the browser roster |
| `dsh.client.external` | specifiers the shell must supply from the **module table** instead of bundling. Here: the official `Modal`/`Button` primitives. `dsh.client.external` is also the host's boot-graph edge set — change one and the other must change (`README.md:54`) |

Optional: `dsh.client.inject` (host-service names the client half needs) and
`dsh.client.immediately` (boolean; load before the rest).

#### 8.3 The bundle wrapper the loader expects

`dsh-webpage-element-picker/lib/client.js:1–5` and the tail:

```js
window.__ModuleLoader__.load({
  id: "dsh-webpage-element-picker",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
```

```js
module.exports = {
  name: PLUGIN_ID,
  inject: ["slots"],
  apply
};

    return module.exports;
  },
});
```

i.e. the client half is a **CJS factory** wrapped in `window.__ModuleLoader__.load({ id, factory })`,
where `require` is the harness module table (only `dsh.client.external` specifiers plus React et al. are
answerable). `dsh-client-modules` owns the in-page loader that implements `__ModuleLoader__`
(`dsh-client-modules/lib/index.js:413–430`):

```js
    if(registration===undefined)throw new Error("client-modules: HTML did not preload ${CLIENT_MODULES_ID}/client.js")
    …
      throw new Error('client-modules: ${CLIENT_MODULES_ID}/client.js requested external "'+specifier+'" before the module system existed')
```

#### 8.4 **Extra** static files (images, wasm, worker scripts) — the honest answer

There is **no first-class "plugin static directory" service.** `/plugins` is a hard-coded prefix mounted
by `dsh-client-modules`, and `bundleResource(req.method, req.url)` serves only
`<id>/client.js` and `<id>/client.js.map` (`dsh-client-modules/lib/index.js:183, 213, 227, 257`).

To ship extra bytes you have two sanctioned options:

1. **Register your own prefix route** — `ctx.webServer.register({ kind: "prefix", path: "/your-plugin/assets", handler })`
   and serve from `pkgResourceDir` (i.e. `fileURLToPath(new URL("../resources/", import.meta.url))`).
   This is exactly the shape `dsh-better-sidebar` uses for `/sidebar/html` and `/sidebar/bundle`
   (see `better-sidebar.md` §2.8). Downside: **no auth fence unless you add one** — see §2.5.
2. **Inline everything into `lib/client.js`.** The working plugin does this: `STYLE_CSS` is a string
   constant inside the bundle and injected as a `<style data-plugin="…">` tag at runtime
   (`lib/client.js` tail, `ctx.effect` → `document.createElement("style")`). Zero extra routes, zero
   packaging questions, and it survives the client-HMR rebuild path unchanged.

> **Do not target `/api/*`.** `dsh-client-connection` owns the `/api` prefix (and `/api/file`,
> `/api/remote.mux`). A second `register({kind:"prefix", path:"/api"})` **throws** on the duplicate;
> a deeper prefix like `/api/mine` would be shadowed by longest-prefix-wins only if it is longer — but
> the shared-channel interceptor design makes this a trap, not a feature.

#### 8.5 Where the Host and Client halves are joined

`dsh-webpage-element-picker/cordis.patch.yml` (whole file) — one row serves both halves:

```yaml
# dsh-webpage-element-picker bundle 补丁层。
#
# 一行同时服务于包的两半：
#   - Loader 将包 main（lib/index.js，由 src/host/index.ts 构建）作为
#     普通 host 插件行导入（subprocess/webServer/tools/systemPrompt/… 服务）；
#   - web client 模块系统（dsh-client-modules）看到同一行，解析包的
#     `dsh.client` 声明，并将其 exports["./client"] bundle（lib/client.js，
#     由 src/client/index.ts 构建）服务到 /plugins/<id>/client.js。
#
# 行名必须与包名完全一致：这是 Loader 解析包以及 client-modules 扫描器
# 查找 package.json 时使用的键。
- insert:
    - id: webpage-element-picker
      name: dsh-webpage-element-picker
```

The framework's own patch confirms the same dual-face design
(`dsh-web-app/cordis.patch.yml:42–43, 176–177`):

```yaml
# `dsh.client` rows are the browser roster the modules node half scans into
# window.__DSH_BOOT__; the modules row is simultaneously a host row.
```
```yaml
    - id: modules
      name: '@deepseek-ai/dsh-client-modules'
```

---

## 3. Minimal working host-plugin skeleton

A complete, self-contained host half that registers a fenced GET route, a streaming SSE route, a
WebSocket upgrade, a tool, and a prompt context. **Copy the file layout of the working plugin:**

```
my-dsh-plugin/
  package.json
  cordis.patch.yml
  lib/index.js        ← host half  (main)
  lib/client.js       ← browser half (exports["./client"])   [optional]
  resources/          ← your extra assets, read via import.meta.url
```

### `package.json`

```json
{
  "name": "dsh-my-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": ["lib", "resources", "cordis.patch.yml"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "external": [] }
  },
  "license": "MIT"
}
```

`"type": "module"` is required — the host half is loaded as ESM (the working plugin uses
`import.meta.url`). Drop the `"client"` key and `exports["./client"]` if you have no browser half.

### `cordis.patch.yml`

```yaml
- insert:
    - id: my-plugin
      name: dsh-my-plugin
```

`name` must equal both the package name and the module's exported `name`.

### `lib/index.js`

```js
// Host half. ESM. Plugin triple: name / inject / apply.
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws"; // resolvable from a profile-installed plugin; declare it anyway

export const name = "dsh-my-plugin";

// Cordis will not call apply() until ALL of these services exist.
export const inject = ["webServer", "connection", "tools", "systemPrompt", "fs", "subprocess", "timer"];

const LOG = "[dsh-my-plugin]";
const ROUTE_PREFIX = "/dsh-my-plugin";

// Resolve plugin-relative resources. There is no ctx.baseDir — this is the idiom.
const pkgResourceDir = (() => {
  try {
    return fileURLToPath(new URL("../resources/", import.meta.url));
  } catch {
    return "";
  }
})();

export function apply(ctx) {
  const webServer = ctx.get("webServer");
  const connection = ctx.get("connection");
  const tools = ctx.get("tools");
  const systemPrompt = ctx.get("systemPrompt");

  // ---- mutable plugin state the prompt thunk re-reads -------------------
  let notes = [];

  // ---- 1. system prompt (thunk, re-evaluated per assembly) --------------
  ctx.effect(() => systemPrompt.context({
    name: "my-plugin",
    order: 60,                                  // finite number; 60 is a free custom slot
    text: () => notes.length === 0 ? "" : notes.join("\n")
  }), "my-plugin: prompt context");

  // ---- 2. agent tool ----------------------------------------------------
  ctx.effect(() => tools.register({
    name: "my_plugin_note",
    description: "Record a note visible to this plugin.",
    parameters: {                                // RAW JSON Schema, object-rooted
      type: "object",
      properties: { text: { type: "string", description: "Note body." } },
      required: ["text"]
    },
    output: {
      schema: {},                                // {} == unconstrained JSON (accepted)
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
    },
    async execute(args /*, exec */) {            // second arg = execution context
      const text = String(args?.text ?? "");
      if (!text) throw new Error("my_plugin_note requires a non-empty text");
      notes = [...notes, text].slice(-50);
      return { ok: true, count: notes.length };  // value is validated + deep-frozen
    }
  }), "my-plugin: tool");

  // ---- 3. HTTP routes ---------------------------------------------------
  ctx.effect(() => {
    const disposers = [];

    // 3a. exact JSON route, fenced by the Host/Origin + browser-auth check.
    disposers.push(webServer.register({
      kind: "exact",
      path: `${ROUTE_PREFIX}/notes`,
      handler: (req, res) => {                   // ← Node req/res, NOT WHATWG
        const rejection = connection.requestRejection(req); // 403 host fence / 401 auth
        if (rejection !== undefined) { res.writeHead(rejection); res.end(); return; }
        if (req.method !== "GET") {
          res.writeHead(405, { "content-type": "application/json", allow: "GET" });
          res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: true, notes }));
      }
    }));

    // 3b. exact POST route: read the body manually.
    //     NOTE: duplicate (kind, path) THROWS — every route needs a distinct path.
    disposers.push(webServer.register({
      kind: "exact",
      path: `${ROUTE_PREFIX}/add`,
      handler: (req, res) => {
        const rejection = connection.requestRejection(req);
        if (rejection !== undefined) { res.writeHead(rejection); res.end(); return; }
        if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
        let body = "", overflow = false;
        req.on("data", (chunk) => {
          if (overflow) return;
          body += String(chunk);
          if (body.length > 1e6) { overflow = true; body = ""; }
        });
        req.on("end", () => {
          if (overflow) { res.writeHead(413, { "content-type": "application/json" }); res.end("{}"); return; }
          let msg = null;
          try { msg = JSON.parse(body || "{}"); } catch {}
          notes = [...notes, String(msg?.text ?? "")].slice(-50);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, count: notes.length }));
        });
        req.on("close", () => { /* client vanished */ });
      }
    }));

    // 3c. streaming (SSE). Content-Type text/event-stream opts out of gzip.
    const streams = new Set();
    disposers.push(webServer.register({
      kind: "exact",
      path: `${ROUTE_PREFIX}/events`,
      handler: (req, res) => {
        const rejection = connection.requestRejection(req);
        if (rejection !== undefined) { res.writeHead(rejection); res.end(); return; }
        res.writeHead(200, {
          "content-type": "text/event-stream",     // ← gzip filter excludes this
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no"
        });
        res.flushHeaders?.();
        const send = (event, data) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        send("hello", { count: notes.length });
        const sink = { send };
        streams.add(sink);
        const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
        req.on("close", () => { clearInterval(heartbeat); streams.delete(sink); });
      }
    }));

    // 3d. raw WebSocket upgrade. No in-tree DSH-free equivalent; mirror dsh-api-gateway.
    const wss = new WebSocketServer({ noServer: true });
    disposers.push(webServer.registerUpgrade({
      path: `${ROUTE_PREFIX}/mux`,
      handler: (req, socket, head) => {           // ← (req, socket, head), exact path only
        const rejection = connection.requestRejection(req);
        if (rejection !== undefined) { socket.destroy(); return; }
        wss.handleUpgrade(req, socket, head, (websocket) => {
          websocket.on("message", (raw) => {
            websocket.send(JSON.stringify({ ok: true, echo: String(raw), count: notes.length }));
          });
        });
      }
    }));

    // 3e. plugin-relative static asset (extra files live in resources/).
    disposers.push(webServer.register({
      kind: "prefix",
      path: `${ROUTE_PREFIX}/assets`,
      handler: (req, res) => {
        const rel = new URL(req.url ?? "/", "http://x").pathname
          .slice(`${ROUTE_PREFIX}/assets`.length + 1);
        if (rel.includes("..")) { res.writeHead(403); res.end(); return; }
        // read via the fs service, not node:fs, so the sandbox policy applies
        const fs = ctx.get("fs");
        Promise.resolve()
          .then(() => fs.resolve(`${pkgResourceDir}/${rel}`))
          .then((target) => fs.readText(target))
          .then((text) => {
            res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
            res.end(text);
          })
          .catch(() => { res.writeHead(404); res.end(); });
      }
    }));

    return () => {                               // ← effect disposer
      for (const d of disposers) { try { d(); } catch {} }
      wss.close();
    };
  }, "my-plugin: HTTP routes");

  // ---- 4. spawn a helper process ---------------------------------------
  const spawnHelper = async () => {
    const subprocess = ctx.get("subprocess");
    const workspaceRoot = ctx.get("sandboxPolicy")?.workspaceRoot ?? process.cwd();
    const node = await subprocess.resolveExecutable("node");
    const handle = subprocess.spawn({
      argv: [node, `${pkgResourceDir}/helper.cjs`],   // argv[0] must be absolute or a bare PATH name
      cwd: workspaceRoot,
      stdio: { stdin: "pipe", stdout: "pipe", stderr: { maxBytes: 65536 } },
      graceMs: 3000                                  // REQUIRED, positive finite
    });
    handle.done.then((outcome) => {
      console.info(`${LOG} helper exited with code ${outcome.exitCode}`);
    }, () => {});
    (async () => {
      for await (const chunk of handle.stdout) {
        for (const line of String(chunk).split("\n")) {
          if (line.trim()) console.info(`${LOG} helper> ${line}`);
        }
      }
    })().catch(() => {});
    return handle;
  };

  // ---- 5. teardown ------------------------------------------------------
  ctx.effect(() => () => { /* close your own resources here */ }, "my-plugin: teardown");
}
```

The skeleton registers five distinct paths: `${ROUTE_PREFIX}/notes` (GET), `${ROUTE_PREFIX}/add`
(POST), `${ROUTE_PREFIX}/events` (SSE), `${ROUTE_PREFIX}/mux` (upgrade) and `${ROUTE_PREFIX}/assets`
(prefix). Re-registering the same `(kind, path)` **throws** — that is the one framework rule that most
easily bites during iterative development.

**Loader/install for the `web` profile** (mirrors `README.md:56–68`):

```sh
dsh plugin --profile web add ./my-dsh-plugin      # or a .tgz, or a git URL
dsh --profile web --dump-config                   # verify the row + layer appear
# then restart `dsh web`
```

---

## 4. CSP findings — consolidated

| Surface | Headers actually set | CSP? | Frameable? |
|---|---|---|---|
| `GET /` (index.html) | `content-type: text/html; charset=utf-8` only (`dsh-host-frontend-static/lib/index.js:73`) | **none** | yes (no `X-Frame-Options`, no `frame-ancestors`) |
| `GET /assets/*` (dist files) | `content-type` per extension; `text/javascript; charset=utf-8` for `.js` etc. (`dsh-host-frontend-static/lib/index.js:24–38`) | **none** | n/a |
| `GET /plugins/<id>/client.js` | from `bundleResource` (`dsh-client-modules/lib/index.js`) | **none** | n/a |
| `GET /api/file?path=…` | `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, **`Content-Security-Policy: sandbox; default-src 'none'`**, `Content-Type` (`dsh-api-session-controller/lib/types/media-references.js:12–17`) | **YES — the only one** | no (sandboxed) |
| Pre-auth `401` | `cache-control: no-store`, `content-type: text/plain; charset=utf-8` (`dsh-client-connection/lib/index.js:442–446`) | none | n/a |
| Plugin route (yours) | whatever you write | **none by default** | depends on you |
| Electron shell (`out/main/index.js`) | no `onHeadersReceived` / `webRequest`; only `setPermissionRequestHandler` | **none** | — |

**Implications for the plan:**

1. **Inline `<script>` injected into the DSH page runs.** The framework itself emits inline `<script>`
   at boot (`dsh-host-webserver/lib/index.js:24–52`, `dsh-client-modules/lib/index.js:439–453`).
2. **An external page can be iframed *from* DSH only as far as that page allows** — the DSH side imposes
   nothing. Third-party `X-Frame-Options: DENY` / `frame-ancestors 'none'` remain the real blocker
   (already documented in `better-sidebar.md` §2.5).
3. **Inlining a script *into* an external page** is not a CSP question at all — it is a cross-origin
   question. `dsh-webpage-element-picker` sidesteps it entirely by driving a **real, separately-launched
   Chromium via Playwright** (`resources/bootstrap.cjs`, `helper-playwright.js`, `inspector.js`) and
   shipping the inspector source to it out-of-band (stdin `READY` handshake, `index.js:413–437, 507,
   513–518`). If the sidebar plan needs script injection into an arbitrary third-party page, the
   Playwright route is the proven one; the iframe route is not.
4. **`/api/file` is a dead end for picker UI.** Its `sandbox; default-src 'none'` means any HTML/SVG
   served through it is fully sandboxed.

---

## 5. Open questions / uncertainties

1. **No `.d.ts` on disk.** `dsh-host-webserver/package.json` declares `"types": "lib/types/index.d.ts"`
   and lists `lib/types/**/*.d.ts` in `files`, but the installed tree contains only `lib/index.js`
   (`find` confirms). Same for most `@deepseek-ai/*`. Types must be hand-written; the JSDoc-rich
   `lib/types/*.js` files that *do* ship in `dsh-tools`, `dsh-client-connection`, `dsh-api-gateway` and
   `dsh-fs` are the closest thing to a type source. **Not resolved:** whether a `dsh`-provided
   type-generation path exists (`dsh-typert-*` packages hint at one).
2. **`Route` type is inferred, not declared.** I derived
   `{ kind: "exact" | "prefix", path: string, handler: (req, res) => void | Promise<void> }` from
   `register`'s body plus every observed call site. `registerFallback(handler)` is a bare function, not
   a route object. `registerUpgrade({ path, handler(req, socket, head) })` is likewise inferred from
   `registerUpgrade` + `server.on("upgrade")` + the api-gateway call site. No formal declaration was
   found.
3. **`ws` availability is an install-layout fact, not a guarantee.** I proved it resolves today because
   `harness/profiles/node_modules/ws` is a symlink into the app bundle. That symlink set is produced by
   the DSH Desktop installer. A non-Desktop `dsh` deployment, or a future version that stops hoisting
   `ws`, would break an undeclared `import "ws"`. **Recommendation: declare `"ws": "^8"` in your own
   `dependencies`** — but note I did not verify that the profile's pnpm/npm install flow tolerates a
   plugin-local `node_modules` (the working plugin has none, and no sibling plugin has one either).
4. **Upgrade-route auth is exact-path only and unauthenticated by default.** `requestRejection` works on
   `req` (verified by the api-gateway call site), but there is no framework-level guarantee that a
   plugin's upgrade route is fenced. Treat it as your responsibility.
5. **Gzip + streaming interaction is only partially proven.** The `filter` correctly excludes
   `text/event-stream` and `content-range`, but `compression` decides at header-write time and I did not
   test an unbounded stream through the real `dsh web` path. If SSE stalls, the first thing to try is
   setting `Content-Type` before any write and/or `Cache-Control: no-transform`.
6. **`ctx.timeout()` vs `timer.timeout()`.** The `timer` service's own doc comments mark both
   `timer.timeout` and `timer.interval` deprecated in favour of `ctx.timeout()` / `ctx.interval()`
   (`cordis-plugin-timer/lib/index.js:16, 20`). The working plugin uses the deprecated form and
   `inject`s `"timer"`. Whether `ctx.timeout()` is available on a plain plugin context in 0.1.5-rc.2
   without injecting `timer` was **not** verified.
7. **`requestBodyMode` / `ctx.connection.fetch.register` semantics.** `registerFetchRoute` is
   `assertFetchRoute`-validated and mounted under `/api`; I read its shape but did not enumerate
   `assertFetchRoute`'s full contract (methods / requestBody / fetch). A plugin wanting the WHATWG
   `Request`/`Response` ergonomics on a **non-`/api`** path has no in-tree precedent.
8. **Index-page injection from a plugin was not exercised.** `webServer.tapIndex(transform)` and the
   `webserver/index-inject` event are open to plugins (`dsh-host-webserver/lib/index.js:212–225,
   338–353`), and `dsh-client-modules` uses both. Using either from a third-party plugin is plausible
   but unproven — and `tapIndex` runs on **every** index response, so a mistake there breaks boot.
9. **`/api/file` CSP is the only CSP found by grep**, but I did not exhaustively inspect minified
   third-party bundles outside `@deepseek-ai/*` (e.g. a vendored `hono` middleware could add one).
   The live 401 response showed none, and the served `index.html` has no meta tag, which is the
   strongest available evidence short of an authenticated fetch.
10. **Authenticated header dump not obtained.** The GUI at `http://127.0.0.1:43129` returned
    `401 Unauthorized` to my unauthenticated `curl` (the launch URL carries a one-time token that
    exchanges for a cookie via a `303`; `dsh-client-connection/lib/index.js:386–421`). I therefore
    confirmed "no CSP" from source + static dist + the unauthenticated response, not from a fully
    authenticated response. Source is unambiguous, so this is a corroboration gap, not a doubt.

---

## Appendix — cross-references

* `picker-internals.md` — deep dive on the working plugin's host half (§3.1 routes, §3.3 tool, §3.4
  prompt) and its client half (§2.1 module wrapper, §2.2 slots, §2.3 `/invoke`).
* `better-sidebar.md` — the sibling plugin's `ctx.betterSidebar` **client-side** extension service
  (§3), its iframe framing limits (§2.5), and its host-side route pattern (§6) — note that
  `better-sidebar`'s host routes are an *extra-static-assets* precedent for §8.4 above.
* `dsh-webpage-element-picker/README.md:102–118` — the plugin's own architecture diagram (subprocess +
  HTTP long-poll + tools + prompt), which this document confirms against framework source.
