# `dsh-better-sidebar` v0.19.1 — embedded browser & `ctx.betterSidebar` extension service

Researched from the installed package at
`/Users/ravooo/Library/Application Support/dsh-desktop/harness/profiles/web/node_modules/dsh-better-sidebar/`
(`src/` TypeScript source preferred over `lib/`). No `docs/` directory ships in the npm package —
`README.md` links to `docs/plans/*.md` but those files are repo-only (verified: package root holds only
`LICENSE`, `README.md`, `README_EN.md`, `cordis.patch.yml`, `package.json`, `lib/`, `scripts/`, `src/`).

---

## 1. Executive summary — can the browser panel host an element picker?

1. The browser panel is `src/client/BrowserView.tsx` (289 lines): an address bar plus **one plain
   declarative `<iframe>`**. There is no host proxy, no injected script, and no RPC bridge into the framed page.
2. The iframe is `src={url}` — the **target URL directly**, third-party origin. No host route relays remote
   page content; the `/sidebar/*` routes serve only the plugin's own API/uploads/local files/chunks/WS.
3. Sandbox is set by `iframeSandboxFor()`; the default token set is
   `allow-scripts allow-forms allow-popups allow-downloads allow-modals allow-popups-to-escape-sandbox` and it
   deliberately **omits `allow-same-origin`**, so the framed page runs in an **opaque origin**.
4. Consequence: the framed page's DOM is **unreachable** from the sidebar — cross-origin, `contentWindow`
   access throws, and there is **no `postMessage` listener or sender anywhere in `src/`** (grep for
   `postMessage|contentWindow|document.domain|parent.document` returns **zero** matches).
5. Therefore the built-in browser tab **cannot host an element picker** (no way to inject a picker script,
   no way to read clicked elements back). It is a viewing surface only.
6. The only escape hatch is the global/local **"close browser sandbox"** pref (`browserNoSandbox`), which sets
   `sandbox={undefined}`. Even then the page is still cross-origin (a different origin from the GUI), so
   same-origin DOM access remains impossible; it only grants the *page* its own origin privileges.
7. Allowlisted loopback URLs additionally get `allow-same-origin` — but that is same-origin **with themselves**,
   never with the GUI (`selfOrigin` is explicitly forced back to the opaque-origin sandbox, lines 66–80).
8. Embedding-hostile sites (X-Frame-Options `DENY`/`SAMEORIGIN`, or CSP `frame-ancestors` without `*`) are
   detected by a **host-side header probe** (`browser.probe`) and replaced by a panel offering "open externally"
   or "load anyway". There is no proxy/rewrite to defeat them, so many real pages simply cannot be framed.
9. Back/forward/reload are **local React state** (`history`/`cursor` + an iframe `key` bump). Only address-bar
   navigations are tracked; in-frame link clicks are invisible (documented limitation) — so a picker flow that
   navigates inside the frame would desync the toolbar.
10. For an element picker the viable route is **not** to reuse this browser, but to register a **fully custom tab**
    via `ctx.betterSidebar.registerTab({ component })`: the host renders the descriptor's component as the whole
    tab body (`createElement(descriptor.component, props)` inside a `height:100%` host) with **no imposed chrome**.
11. That custom tab can render its **own toolbar + its own iframe** and run its own `postMessage` protocol —
    provided the target page is instrumented (or the picker script is injected by the app under test).
12. `ctx.betterSidebar` is a **client-only** service: `ctx.provide('betterSidebar', service)`
    (`src/client/index.tsx:143`); the host context comment says it is "undefined on the host side"
    (`src/context-types.ts:550–555`). A plugin must register in its **client half**.
13. Consumer contract: `import type {} from 'dsh-better-sidebar'` plus `export const inject = ['betterSidebar']`
    (`README_EN.md:179–180`); `README_EN.md:449` reaffirms "external consumers keep
    `inject: ['betterSidebar'] + ctx.betterSidebar`".
14. The plugin's own client half declares a different inject list (`['slots','sessions','locale','modules','connection']`,
    `src/client/index.tsx:44`) — that is the *provider* side, not the consumer requirement.
15. Registering returns a **disposer** that cordis auto-invokes on fiber disposal; wrapping in `ctx.effect(...)`
    is the documented idiom (`README_EN.md:182`). Duplicate ids **throw**.
16. Registered tabs automatically gain a per-type enable/disable switch in the Side card settings page and, when
    the native surface is installed, become DSH native tab types (`src/client/service.ts:892–939`).
17. Host HTTP routes use the **`ctx.webServer`** service: `ctx.effect(() => ctx.webServer.register({ kind:'prefix'|'exact',
    path, handler }))`, guarded by a shared trust fence. `src/bundle-route.ts:123–129` is the cleanest copyable example.
18. A picker plugin can therefore add its own `/sidebar/...` route for its own backend, but that route **cannot**
    proxy arbitrary third-party pages without running into the same X-Frame-Options/CSP and origin walls.
19. A plugin *can* observe the built-in browser's current URL: it is persisted on `tab.path`
    (`BrowserView.tsx:120–124`) and `SidebarSnapshot.state` exposes tabs (`src/client/state.ts:790–799`) — but
    only while that browser tab is open, and reading it buys no DOM access.
20. Bottom line: **"host an element picker inside the built-in browser tab" = not possible via the public API.**
    **"Ship a self-owned custom tab that renders its own iframe and picker" = fully supported.**

---

## 2. Embedded-browser implementation

### 2.1 The iframe markup (verbatim)

`src/client/BrowserView.tsx:245–253`:

```tsx
        <iframe
          key={`${reloadKey}:${noSandbox ? 'ns' : 'sb'}`}
          className={css.browserFrame}
          src={url}
          sandbox={noSandbox ? undefined : iframeSandboxFor(url, store.getPrefs().browserAllowedLoopback, window.location.origin)}
          referrerPolicy="no-referrer"
          allow=""
          title={url}
        />
```

Attribute inventory:

| Attribute | Value | Source |
|---|---|---|
| `src` | `url` — the raw target URL | line 248 |
| `sandbox` | computed token string, or `undefined` (attribute omitted) when unsandboxed | line 249 |
| `allow` | `""` (empty Permissions-Policy — no camera/mic/clipboard/geolocation delegation) | line 251 |
| `referrerPolicy` | `"no-referrer"` | line 250 |
| `title` | `url` | line 252 |
| `allowFullScreen` | **absent** — not declared anywhere | — |
| `key` | `` `${reloadKey}:${noSandbox ? 'ns' : 'sb'}` `` (remount trigger) | line 246 |

### 2.2 Sandbox tokens (verbatim)

`src/client/BrowserView.tsx:43–48`:

```ts
export const BROWSER_IFRAME_SANDBOX =
  'allow-scripts allow-forms allow-popups allow-downloads allow-modals allow-popups-to-escape-sandbox'

/** allow-same-origin appended for explicitly allowlisted local addresses. */
const BROWSER_IFRAME_SANDBOX_SAME_ORIGIN =
  `${BROWSER_IFRAME_SANDBOX} allow-same-origin`
```

`src/client/BrowserView.tsx:66–80`:

```ts
export function iframeSandboxFor(url: string | undefined, allowedLoopback: string, selfOrigin?: string): string | undefined {
  if (url === undefined) return undefined
  if (selfOrigin !== undefined) {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return BROWSER_IFRAME_SANDBOX
    }
    if (parsed.origin === selfOrigin) return BROWSER_IFRAME_SANDBOX
  }
  return isAllowedLoopbackUrl(url, allowedLoopback)
    ? BROWSER_IFRAME_SANDBOX_SAME_ORIGIN
    : BROWSER_IFRAME_SANDBOX
}
```

Key security statement from the file header, `src/client/BrowserView.tsx:1–18`:

```
 * Security model (see browser.ts + the sandbox tokens below): the iframe is
 * ALWAYS sandboxed without `allow-same-origin` (opaque origin — the visited
 * page can never sit on the GUI's origin, read its storage, or reach
 * /sidebar/api) and without `allow-top-navigation` (a page must not hijack
 * the GUI). ... The side card setting "关闭浏览器沙箱" drops the
 * sandbox attribute entirely for fully trusted sites — the visited page then
 * runs with the GUI's own origin and full session access, so a persistent
 * warning bar renders while it is off.
```

> Note the header claims the unsandboxed site "runs with the GUI's own origin"; for a third-party URL it
> still has its own origin, but the attribute is dropped entirely, so treat it as trusted-only. A warning bar
> (`SandboxStatusBar`) renders while unsandboxed; `localUnlock` allows a per-surface temporary unlock
> (lines 95–98, 229–235).

### 2.3 How the iframe `src` is built — direct URL, no proxy

`src/client/BrowserView.tsx:82–98,120–144`:

```tsx
export function BrowserView(props: TabComponentProps) {
  const { store, tab } = props
  // The current address (initialized from the persisted tab.path so a
  // reload restores the visited page).
  const [url, setUrl] = useState<string | undefined>(tab.path)
  ...
  const persist = (nextUrl: string): void => {
    let host = nextUrl
    try { host = new URL(nextUrl).hostname } catch { /* keep the URL as title */ }
    store.reduce(state => patchTab(state, tab.id, { path: nextUrl, title: host }))
  }

  const navigateTo = (raw: string): void => {
    const result = normalizeBrowserUrl(raw, window.location.origin, store.getPrefs().browserAllowedLoopback)
    if (result.kind === 'ok') {
      const next = result.url
      setUrl(next)
      setInput(next)
      setMessage(null)
      // Push onto the stack, dropping any stale forward entries.
      setHistory(previous => [...previous.slice(0, cursor + 1), next])
      setCursor(previous => previous + 1)
      setReloadKey(key => key + 1)
      persist(next)
      return
    }
    ...
```

- The URL is normalized by the pure policy module `src/client/browser.ts` (address-bar gate): http(s) only,
  forbidden schemes (`javascript:`, `data:`, `file:`, `blob:`, `ws:`, …) refused, loopback refused unless
  allowlisted, the GUI's **own origin explicitly allowed**.
  `src/client/browser.ts:80–84,120–167`.
- The resulting string is fed **straight into `src`**. **There is no proxy route, no `srcdoc`, no blob URL,
  no rewriting.** Remote content is framed by the browser directly, cross-origin.
- The URL is persisted onto the tab via `patchTab(state, tab.id, { path: nextUrl, title: host })`, so a page
  reload restores the visited page.

### 2.4 Script injection into the framed page — none

A repo-wide search for any mechanism that could reach into the framed document returns nothing:

```
$ grep -rn "postMessage\|contentWindow\|document.domain\|parent.document" src/
(no output)
```

- There is **no `iframeRef`**, no `contentWindow`, no `contentDocument`, no `postMessage` sender or listener.
- Because the default sandbox omits `allow-same-origin`, the framed page is in an **opaque origin**: even a
  same-origin-by-URL page is cross-origin to the GUI, so direct DOM access is impossible by construction.
- Consequently an element picker **cannot** be injected into the built-in browser tab through any public or
  internal path. Any picker needs its own iframe + its own instrumentation of the page under test.

### 2.5 Pages that refuse framing (X-Frame-Options / CSP `frame-ancestors`)

Detection is a **host-side header probe**, not a client hack.

Client side, `src/client/BrowserView.tsx:99–118`:

```tsx
  /** A site that refuses to be embedded (X-Frame-Options / frame-ancestors):
   *  the probe verdict shown instead of the blank iframe. */
  const [embedBlocked, setEmbedBlocked] = useState<string | null>(null)
  /** The user asked to load the refused site anyway (keeps the plain iframe). */
  const [forceEmbed, setForceEmbed] = useState(false)

  // Probe every navigation (address bar, history, restored path): when the
  // target forbids embedding, show the reason + open-in-browser instead of
  // the browser's cryptic "refused to connect" blank frame. A failed probe
  // (unreachable) keeps the plain iframe.
  useEffect(() => {
    if (url === undefined) return
    let cancelled = false
    setEmbedBlocked(null)
    setForceEmbed(false)
    void api.browserProbe(url).then((probe) => {
      if (!cancelled && embeddabilityOf(probe) === 'blocked') setEmbedBlocked(url)
    }).catch(() => { /* unreachable: keep the plain iframe */ })
    return () => { cancelled = true }
  }, [url])
```

Verdict logic, `src/client/browser.ts:39–53`:

```ts
/**
 * Decide whether a site can render inside the sidebar iframe. The signals
 * are exactly the ones the BROWSER enforces when it refuses an iframe load:
 * X-Frame-Options DENY/SAMEORIGIN, or a frame-ancestors directive that does
 * not allow `*` ('self' here means the SITE's own origin — never ours, so
 * it also blocks the sidebar). A site we could not reach yields 'unknown'
 * and the plain iframe stays.
 */
export function embeddabilityOf(probe: BrowserProbeResult): Embeddability {
  if (probe.reachable !== true) return 'unknown'
  const xfo = probe.xFrameOptions?.trim().toUpperCase()
  if (xfo === 'DENY' || xfo === 'SAMEORIGIN') return 'blocked'
  if (probe.frameAncestors !== undefined && !probe.frameAncestors.some(source => source === '*')) return 'blocked'
  return 'embeddable'
}
```

CSP parsing helper `src/browser-probe.ts:16–26` (`extractFrameAncestors`). Host route
`src/index.ts:615–690` (`'browser.probe'` in the `/sidebar/api` handler map): `requireString(payload,'url')`,
http(s)-only, loopback refused unless allowlisted, `AbortController` 8 s timeout, `HEAD` then `GET` fallbacks
(405/501, and when neither embed signal is present), `response.body?.cancel()`, returns
`{ reachable, url, status, xFrameOptions, frameAncestors }`. Client method:
`src/client/api.ts:420–421` `browserProbe: (url, signal) => call<BrowserProbeResult>('browser.probe', { url }, signal)`.

UI on a blocked verdict, `src/client/BrowserView.tsx:236–243` and `266–289`:

```tsx
      {url === undefined ? (
        <div className={css.browserStart}>{t('browserStart')}</div>
      ) : embedBlocked !== null && !forceEmbed ? (
        <BrowserEmbedBlocked
          url={embedBlocked}
          onOpenInBrowser={() => { window.open(embedBlocked, '_blank', 'noopener') }}
          onLoadAnyway={() => { setForceEmbed(true) }}
        />
      ) : (
```

```
 * The embed-refusal panel: shown when the probed site forbids being
 * displayed inside other pages (X-Frame-Options / frame-ancestors) — the
 * iframe would only show the browser's "refused to connect" blank. Explains
 * the reason and offers the real-browser open plus a load-anyway escape.
```

**There is no workaround**: no proxy that strips headers, no `srcdoc` rewrite. "Load anyway" just renders
the plain iframe, which the browser itself will refuse.

### 2.6 Back / forward / reload

All local React state on the tab component (`src/client/BrowserView.tsx:84–94`):

```tsx
  const [url, setUrl] = useState<string | undefined>(tab.path)
  const [input, setInput] = useState<string>(tab.path ?? '')
  /** Blocked/invalid hint shown under the address bar (null = none). */
  const [message, setMessage] = useState<string | null>(null)
  /** Address-bar navigation history (in-frame clicks are not tracked). */
  const [history, setHistory] = useState<string[]>(tab.path !== undefined ? [tab.path] : [])
  const [cursor, setCursor] = useState<number>(tab.path !== undefined ? 0 : -1)
  /** Bumped on reload to remount the iframe (also remounts on sandbox flip). */
  const [reloadKey, setReloadKey] = useState(0)
```

`src/client/BrowserView.tsx:146–162`:

```tsx
  const goBack = (): void => {
    if (cursor <= 0) return
    const next = history[cursor - 1]!
    setCursor(cursor - 1)
    setUrl(next)
    setInput(next)
    setReloadKey(key => key + 1)
  }

  const goForward = (): void => {
    if (cursor >= history.length - 1) return
    const next = history[cursor + 1]!
    setCursor(cursor + 1)
    setUrl(next)
    setInput(next)
    setReloadKey(key => key + 1)
  }
```

Reload button, `src/client/BrowserView.tsx:187–195`:

```tsx
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('refresh')}
          title={t('refresh')}
          onClick={() => { setReloadKey(key => key + 1) }}
        >
          <IconRefreshOutline14 />
        </button>
```

Mechanism: navigation **reassigns state**, and `reloadKey` participates in the iframe `key`, so React
**remounts** the iframe (a genuine reload, not `contentWindow.location.reload()`). Documented limitation,
`src/client/BrowserView.tsx:14–17`:

```
 * The URL is persisted onto the tab (path/title via the patchTab reducer)
 * so a reload restores the visited page; the back/forward stack only tracks
 * address-bar navigations (in-frame link clicks are cross-origin and
 * invisible — a documented limitation).
```

### 2.7 The built-in browser tab descriptor

`src/client/builtins/tabs.tsx:314–359` (browser entry) — note it mints `browser:<n>` ids and **declares no
`urlTarget`** (per the `TabDescriptor.urlTarget` doc, `lib/types/client/service.d.ts:191–206`, the browser is
the implicit fallback claim target so plugins can never be shadowed by it):

```tsx
    {
      id: 'browser',
      title: () => t('browser'),
      description: () => t('guideDescBrowser'),
      icon: browserTabIcon,
      order: 50,
      settings: {
        toggles: [{
          key: 'browserNoSandbox',
          ...
        }, {
          key: 'browserInterceptLinks',
          ...
        }, {
          key: 'browserInterceptHttp',
          ...
        }, {
          key: 'browserInterceptHttps',
          ...
        }, {
          key: 'browserAllowedLoopback',
          type: 'text',
          ...
        }],
      },
      createTab: (state) => ({
        tab: {
          id: `browser:${state.nextBrowser}`,
          type: 'browser',
          title: t('browser'),
        },
        patch: { nextBrowser: state.nextBrowser + 1 },
      }),
      component: (props) => <BrowserView {...props} />,
    },
```

Prefs keys/defaults (`src/prefs-shared.ts:161–197,260–264`): `browserNoSandbox: false`,
`browserInterceptLinks: true`, `browserInterceptHttp: true`, `browserInterceptHttps: false`,
`browserAllowedLoopback: ''`.

### 2.8 Host-side routes (`/sidebar/html`, `/sidebar/bundle`, and the rest)

**Important:** neither `html-route.ts` nor `bundle-route.ts` serves framed remote content. There is **no
proxy route** in this plugin.

`src/html-route.ts` — the pure URL vocabulary of the **local HTML previewer** (`/sidebar/html/<sessionId>/<path>`),
serving workspace files (used by the editor's HTML preview, not the browser tab). Header `src/html-route.ts:1–32`:

```
 * Pure URL vocabulary of the /sidebar/html route (HTML previewer).
 *
 * Why path-encoded parameters instead of a query string: the previewed
 * page resolves its relative assets (./style.css, img/x.png) against the
 * document URL, and the WHATWG URL algorithm DROPS the query of a
 * path-relative reference ...
 *
 *   /sidebar/html/<sessionId>/<absolute-path segments, encodeURIComponent'd>
```

Key exports: `HTML_ROUTE_PREFIX = '/sidebar/html/'` (line 47), `encodeHtmlUrl(sessionId, path)` (50–54),
`decodeHtmlUrl(pathname)` (63–105). The route handler in `src/index.ts:1015–1059` applies the trust fence,
decodes, resolves through `ensureWorkspacePath(cwd, path, fenceEnabled)` (workspace real-path guard), and
serves with a defense-in-depth header:

```ts
        res.writeHead(200, {
          'content-type': type === 'text/html' ? 'text/html; charset=utf-8' : type,
          'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          // The sandbox directive (no allow-same-origin → opaque origin) is
          // the previewer's security boundary even for top-level loads;
          // object-src 'none' blocks plugin embeds.
          'content-security-policy': "sandbox allow-scripts allow-popups allow-downloads allow-modals; object-src 'none'",
        })
```

`src/bundle-route.ts` — lazy client **chunk** route (`/sidebar/bundle/<name>.js`). Header `src/bundle-route.ts:1–14`:

```
 * Lazy chunk route: serves the client bundle's chunk scripts
 * (/sidebar/bundle/<name>.js). The official /plugins/<id>/client.js route
 * cannot serve arbitrary file names, so the plugin serves its own split
 * bundles (lib/client-<name>.js) here; the client injects the script on
 * first use of the feature that needs it (see src/client/chunk-loader.ts).
```

Allowlisted names only, `src/bundle-route.ts:22–23`:

```ts
export const CHUNK_NAMES = ['terminal', 'editor', 'mermaid', 'locale'] as const
export type ChunkName = (typeof CHUNK_NAMES)[number]
```

Full route inventory (from `grep -n "webServer.register" src/*.ts`):

| Path | kind | Source |
|---|---|---|
| `/sidebar/api` | prefix (POST JSON RPC; hosts `browser.probe`, fs, git, jobs, sidechat, settings, `open.external`) | `src/index.ts:884–913` |
| `/sidebar/upload` | exact (raw upload) | `src/index.ts:921+` |
| `/sidebar/file` | prefix (media/binary) | `src/index.ts:964+` |
| `/sidebar/html` | prefix (local HTML previewer) | `src/index.ts:1015+` |
| `/sidebar/bundle` | prefix (chunks) | `src/bundle-route.ts:123–129` |
| `/sidebar/ws/terminal`, `/sidebar/ws/agent-terminals`, `/sidebar/ws/agent-opens` | upgrade | `src/index.ts:1076,1100,1120` |

---

## 3. `ctx.betterSidebar` API reference (verbatim declarations)

Published types live in `lib/types/client/service.d.ts` (identical to `src/client/service.ts`). The primary
exports are also re-exported from the package root (`lib/types/index.d.ts`):

```ts
export type { BetterSidebarService, TabDescriptor, TabComponentProps, FileViewerDescriptor, FileViewerProps, FileFetchStrategy, } from './client/service.ts';
```

### 3.1 The service interface — `lib/types/client/service.d.ts:445–579`

```ts
/**
 * The registry service published as `ctx.betterSidebar`.
 */
export interface BetterSidebarService {
    registerTab(descriptor: TabDescriptor): () => void;
    registerFileViewer(descriptor: FileViewerDescriptor): () => void;
    registerFileIcon(descriptor: FileIconDescriptor): () => void;
    getTabs(): readonly TabDescriptor[];
    getFileViewers(): readonly FileViewerDescriptor[];
    getFileIcons(): readonly FileIconDescriptor[];
    /**
     * Find a SPECIFIC registered file icon for a path (priority desc, then
     * registration order): a `names` match first, then an `exts` match.
     * Catch-alls (`exts: []`) and folder registrations (`'folder'`/
     * `'folder-open'`) are not consulted — this answers "did a registration
     * claim this exact name or extension". Consumers should prefer
     * `fileIcon`/`folderIcon`, which run the whole fallback chain.
     */
    matchFileIcon(path: string): FileIconDescriptor | undefined;
    /**
     * Find the registered icon for DIRECTORY rows (priority desc, then
     * registration order): a `folderNames` match on `name` first (pass the
     * directory's basename), then the `'folder'`/`'folder-open'` reserved
     * exts by `open`. Undefined = fall back to the built-in VSCodicons folder
     * glyphs.
     */
    matchFolderIcon(open: boolean, name?: string): FileIconDescriptor | undefined;
    /**
     * The authoritative FILE icon for a path (feature `fileIcons`), running
     * the whole chain with per-factory crash isolation:
     * 1. a specific registered name or extension (priority desc, registration
     *    order),
     * 2. the best registered global default (`exts: []`, priority desc) — an
     *    external plugin that registers a catch-all owns every row the host's
     *    classifier would otherwise draw,
     * 3. the host's own `FileTypeIcon` artwork (feature `fileIcons`, DSH's
     *    classifier and glyphs — the plugin ships no extension table).
     * A throwing factory is logged (console.error) and skipped — the caller
     * always gets a valid ReactNode.
     */
    fileIcon(path: string, size: number): ReactNode;
    /**
     * The authoritative DIRECTORY icon for a tree row: the registered
     * `folderNames`/`'folder'`/`'folder-open'` icon (priority desc), else the
     * built-in `VscFolder`/`VscFolderOpened`. `path` is the directory's own
     * path (a theme may vary icons per directory); `open` reaches the factory
     * so one descriptor can render both states. Same crash isolation as
     * `fileIcon`.
     */
    folderIcon(path: string, open: boolean, size: number): ReactNode;
    /** Find a tab descriptor by id (undefined if not registered). */
    getTab(id: string): TabDescriptor | undefined;
    /**
     * Whether a tab type is enabled in the side card prefs. An absent
     * `tabsEnabled[id]` entry means enabled — only an explicit `false`
     * disables the type (hidden from the + menu, `openTab` refuses, and
     * derived flows gate on it).
     */
    isTabEnabled(id: string): boolean;
    /** Whether a file viewer is enabled (absent `viewersEnabled[id]` = enabled). */
    isViewerEnabled(id: string): boolean;
    /**
     * Find a file viewer for a path (priority desc; detect first, then exts).
     * Disabled viewers are skipped, so files fall through to the next match.
     */
    matchFileViewer(path: string, head?: Uint8Array): FileViewerDescriptor | undefined;
    /**
     * Open a tab (used by external tabs and the + menu). ...
     */
    openTab(seed: OpenTabSeed, scope?: SessionScope): void;
    /**
     * Close a tab by id (fires descriptor.onClose). An unknown tab id is a
     * strict no-op (no state churn, no callbacks). ...
     */
    closeTab(tabId: string, scope?: SessionScope): void;
    /** Subscribe to registry changes (register/dispose). */
    subscribe(listener: () => void): () => void;
    /** The plugin version this service instance was built from ('0.12.0'). */
    readonly version: string;
    /**
     * Monotonic capability list (v0.12.0+): 'badge' | 'tabLifecycle' |
     * 'updateTab' | 'openFile' | 'targetedOpen' | 'stateSubscription' |
     * 'tabMeta' | 'pluginSettings'. ...
     */
    readonly features: readonly string[];
    /**
     * The current sidebar snapshot: the active session id, its state (panel
     * geometry, open tabs, expansions), and the side card prefs (v0.12.0+).
     * `state`/`sessionId` are undefined until a session becomes active.
     */
    getSnapshot(): SidebarSnapshot;
    /** Subscribe to snapshot changes (session switch, state changes, prefs changes). Returns the disposer. */
    subscribeState(listener: () => void): () => void;
    /** Update an open tab's display fields (title / path / meta); a missing tab id is a no-op. */
    updateTab(tabId: string, patch: {
        title?: string;
        path?: string;
        meta?: unknown;
    }): void;
    /**
     * Activate an open tab (the tab-bar activation path; fires
     * descriptor.onActivate). An unknown tab id is a strict no-op. ...
     */
    activateTab(tabId: string, scope?: SessionScope): void;
    /** Open a file in the sidebar editor of `scope`'s session (title defaults to the file name). */
    openFile(scope: SessionScope, path: string, title?: string): void;
    /**
     * Install (or clear) the native right-Sidebar write face.
     * @internal Called once by the client half; not part of the consumer API.
     */
    setSurface(surface: SidebarSurface | undefined): void;
}
```

Features/version constants, `lib/types/client/service.d.ts:592–620`:

```ts
export declare function matchUrlTarget(tabs: readonly TabDescriptor[], url: URL): TabDescriptor | undefined;
export declare const SIDEBAR_SERVICE_VERSION = "0.19.1";
export declare const SIDEBAR_FEATURES: readonly ["badge", "tabLifecycle", "updateTab", "openFile", "targetedOpen", "stateSubscription", "tabMeta", "pluginSettings", "urlTarget", "settingSelect", "fileIcons"];
```

Factory, `lib/types/client/service.d.ts:621–626`:

```ts
/**
 * Create one BetterSidebar service bound to a store. The service owns the
 * tab/viewer registries (Map + listener set) and proxies openTab/closeTab
 * to the store's reducer. One instance per client plugin activation.
 */
export declare function createBetterSidebarService(store: SidebarStore): BetterSidebarService;
```

### 3.2 `registerTab` — implementation (`src/client/service.ts:700–712`)

```ts
  const registerTab = (descriptor: TabDescriptor): (() => void) => {
    if (tabs.has(descriptor.id)) {
      throw new Error(`[dsh-better-sidebar] tab type "${descriptor.id}" already registered`)
    }
    tabs.set(descriptor.id, descriptor)
    notify()
    return () => {
      if (tabs.get(descriptor.id) === descriptor) {
        tabs.delete(descriptor.id)
        notify()
      }
    }
  }
```

- **Returns**: a disposer (idempotent guard by identity). Throws on duplicate `id`.
- `registerFileViewer` (`src/client/service.ts:714–726`) and `registerFileIcon` (`733–745`) have identical
  shapes (`viewers` / `fileIcons` maps; same throw-on-duplicate, same disposer).
- Published on the context: `src/client/index.tsx:143` → `ctx.provide('betterSidebar', service)`
  (comment at 139–142: "Published before the panel mounts so consumers injecting 'betterSidebar' are ready by
  the time the sidebar renders.").

### 3.3 `TabDescriptor` — `lib/types/client/service.d.ts:140–236` (abridged to signatures; full doc comments retained in file)

```ts
export interface TabDescriptor {
    /** Unique id; also the `SidebarTab.type` value (`'explorer'`, `'my-plugin:db'`). */
    id: string;
    title: string | (() => string);
    description?: string | (() => string);
    icon?: ReactNode | ((size: number) => ReactNode);
    /** + menu sort order (ascending); default 100. */
    order?: number;
    /** Hide from the + menu (the editor tab is opened by file-open, not by the menu). */
    hidden?: boolean;
    available?: (ctx: Context, scope: SessionScope, state: SidebarState) => boolean;
    /** Single-instance sugar: `true` is shorthand for `dedupeKey: () => id` ... */
    single?: boolean;
    dedupeKey?: (tab: SidebarTab) => string | undefined;
    /**
     * Custom tab creation (minting the `SidebarTab` and any state patches).
     * Return `null` to refuse creation. ...
     * When omitted, a default `{ id, type, title }` tab is created.
     */
    createTab?: (state: SidebarState) => {
        tab: SidebarTab;
        patch?: Partial<SidebarState>;
    } | null;
    urlTarget?: (url: URL) => boolean;
    settings?: SidebarSettingsDeclaration;
    badge?: (ctx: Context, scope: SessionScope, state: SidebarState) => string | number | null | undefined;
    onOpen?: (tab: SidebarTab, scope: SessionScope) => void;
    onActivate?: (tab: SidebarTab, scope: SessionScope) => void;
    onClose?: (tab: SidebarTab, scope: SessionScope) => void;
    component: (props: TabComponentProps) => ReactNode;
}
```

`TabComponentProps` — `lib/types/client/service.d.ts:122–139`:

```ts
/** Props every tab component receives (builtins and external alike). */
export interface TabComponentProps {
    ctx: Context;
    store: SidebarStore;
    scope: SessionScope;
    tab: SidebarTab;
    /** Whether this tab is the active one AND the panel is open (live views pause otherwise). */
    visible: boolean;
    /** The explorer's expanded directory set (ExplorerView). */
    expanded?: string[];
    /** The explorer's reveal-highlight set (ExplorerView; "Show in folder" targets). */
    revealed?: string[];
    onToggleDir?: (path: string) => void;
    onReferenceFile?: (path: string, isDir: boolean) => void;
    onOpenFile?: (path: string) => void;
    onOpenDiff?: (tab: SidebarTab) => void;
    onSubagentJump?: (childSessionId: string) => void;
}
```

`OpenTabSeed` — `lib/types/client/service.d.ts:363–385`:

```ts
/** One `openTab` request. */
export interface OpenTabSeed {
    type: string;
    /** Overrides the descriptor's title when given (the editor tab shows the file name). */
    title?: string;
    /** A file path (the editor tab's content seed). */
    path?: string;
    /** A diff reference (the diff tab's content seed). */
    diff?: SidebarTab['diff'];
    /** Explicit tab id (defaults to the type). */
    id?: string;
    /** A URL the tab navigates to on mount (the browser tab's seed). */
    url?: string;
    /** JSON-serializable custom state carried on the minted tab (persisted across reloads; v0.12.0+). */
    meta?: unknown;
    target?: 'right' | 'bottom';
}
```

`SidebarTab` (what the component receives) — `src/client/state.ts:30–45`:

```ts
export interface SidebarTab {
  id: string
  type: TabType
  title: string
  path?: string
  diff?: SidebarDiffRef
  /** Plugin-owned state (v0.12.0+): MUST be JSON-serializable — it is
   *  persisted with the layout and restored verbatim on reload. */
  meta?: unknown
  pin?: { scope: 'workspace' | 'global'; homeCwd?: string }
}
```

`SidebarSnapshot` — `src/client/state.ts:790–799`:

```ts
export interface SidebarSnapshot {
  sessionId: string | undefined
  state: SidebarState | undefined
  /**
   * The current side card prefs. Carried IN the snapshot (not a separate
   * subscription) so prefs changes re-render the consumers that gate on
   * them — the + menu hides a tab type the moment its switch flips.
   */
  prefs: SidebarPrefs
}
```

### 3.4 `FileViewerDescriptor` / `FileViewerProps` / `FileFetchStrategy`

`lib/types/client/service.d.ts:237–308`:

```ts
/** How the host loads a file's bytes for one viewer. */
export type FileFetchStrategy = 'none' | 'fsRead' | 'mediaUrl' | 'custom' | 'binary-download';
/** Props every file viewer component receives. */
export interface FileViewerProps {
    ctx: Context;
    store: SidebarStore;
    scope: SessionScope;
    path: string;
    title: string;
    /** The matching descriptor's id (`'code'`, `'my-plugin:csv'`). */
    viewerId: string;
    /** fsRead text content (fetchStrategy='fsRead'). */
    content?: string;
    truncated?: boolean;
    /** mediaUrl for the path (fetchStrategy='mediaUrl'). */
    mediaUrl?: string;
    /** custom load() return value (fetchStrategy='custom'). */
    customData?: unknown;
    toolbar?: 'self' | 'host';
    onToolbarState?: (state: EditorToolbarState) => void;
    onToolbarControls?: (controls: EditorToolbarControls | null) => void;
}
...
/** Describes one file previewer (builtins register themselves too). */
export interface FileViewerDescriptor {
    /** Unique id (`'image'`, `'pdf'`, `'my-plugin:csv'`). */
    id: string;
    /** Display name for the settings inventory (falls back to `id` when absent). */
    title?: string | (() => string);
    /** Icon shown in the settings inventory. */
    icon?: ReactNode | ((size: number) => ReactNode);
    /** Lowercase extensions without leading dot (`['png','jpg']`). `[]` = match any (catch-all). */
    exts: readonly string[];
    /** Higher wins; default 0. Builtins use 0; the catch-all `code` viewer uses -100. */
    priority?: number;
    fetchStrategy: FileFetchStrategy;
    detect?: (path: string, head: Uint8Array) => boolean;
    load?: (path: string, scope: SessionScope, signal?: AbortSignal) => Promise<unknown>;
    settings?: SidebarSettingsDeclaration;
    component: (props: FileViewerProps) => ReactNode;
}
```

### 3.5 `FileIconDescriptor` (v0.19.0+, capability `'fileIcons'`)

`lib/types/client/service.d.ts:309–362`:

```ts
export interface FileIconDescriptor {
    /** Unique id (`'my-plugin:icons'`). */
    id: string;
    exts?: readonly string[];
    names?: readonly string[];
    folderNames?: readonly string[];
    /** Higher wins; default 0. Registered icons always outrank the built-in map. */
    priority?: number;
    /**
     * Size-aware icon factory (the tree and file tabs render at 14 today).
     * `open` is the directory's expanded state for a DIRECTORY row and
     * `undefined` for a file row ...
     */
    icon: (path: string, size: number, open?: boolean) => ReactNode;
}
export declare const FOLDER_EXT: "folder";
export declare const FOLDER_OPEN_EXT: "folder-open";
```

Reserved `exts` values `'folder'` / `'folder-open'` claim directory rows; `names` outranks `exts`;
`exts: []` is a global catch-all (only after specific rules and built-in glyphs).

### 3.6 How a tab's body component is rendered

`src/client/sidebar/TabContent.tsx:34–55`:

```tsx
/** Render the content of one tab (dispatched by type). */
export const TabContent = memo(function TabContent(props: TabContentProps) {
  const { tab, effectiveTabId, sessionId, cwd, expanded, revealed, onToggleDir, onReferenceFile, ctx, store, visible, onSubagentJump, onOpenDiff } = props
  const scope = { sessionId, cwd }
  const descriptor = ctx.get('betterSidebar')?.getTab(tab.type)
  if (descriptor === undefined) {
    return <OrphanedTab ctx={ctx} store={store} scope={scope} tab={tab} visible={visible} />
  }
  // For pinned virtual tabs, the tab descriptor's component (e.g. TerminalView)
  // must receive the ORIGINAL tab id so it connects to the home session's PTY.
  // The virtual tab's own id is a unique display key (prefixed); effectiveTabId
  // restores the real id at the component boundary.
  const componentTab = effectiveTabId !== undefined ? { ...tab, id: effectiveTabId } : tab
  return createElement(
    RenderBoundary,
    { className: css.tabBoundaryError },
    createElement(descriptor.component, {
      ctx, store, scope, tab: componentTab, visible, expanded, revealed,
      onToggleDir, onReferenceFile, onOpenDiff, onSubagentJump,
    }),
  )
}, tabContentCompare)
```

The + menu is built from the same registry, `src/client/sidebar/TabContent.tsx:62–74`:

```tsx
export function buildNewTabOptions(state: SidebarState, ctx: Context, scope: SessionScope): NewTabOption[] {
  const service = ctx.get('betterSidebar')
  if (service === undefined) return []
  return service.getTabs()
    .filter(d => !d.hidden && service.isTabEnabled(d.id))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
    .map(d => ({
      id: d.id,
      label: typeof d.title === 'function' ? d.title() : d.title,
      disabled: !(d.available?.(ctx, scope, state) ?? true),
      icon: typeof d.icon === 'function' ? d.icon(14) : d.icon,
    }))
}
```

When the native right-Sidebar surface is installed, the same component is mounted into a `height:100%`
wrapper — `src/client/native/tab-adapter.tsx:301–333`:

```tsx
  return createElement(
    RenderBoundary,
    { className: css.tabBoundaryError },
    // The full-height host wrapper (see the `.nativeTabHost` rule in
    // sidebar.module.css for the native `.paneBody` contract); its
    // `data-dsh-native-tab-host` attribute lets the e2e lane assert the fill.
    createElement(
      'div',
      { className: css.nativeTabHost, 'data-dsh-native-tab-host': '' },
      createElement(descriptor.component, {
        ctx,
        store,
        scope,
        tab: view.tab,
        visible: nativeTab.visible,
        expanded: view.expanded,
        revealed: view.revealed,
        onToggleDir: (path: string) => { records.toggleExpanded(nativeTab.id, path) },
        onReferenceFile: (path: string, isDir: boolean) => { referenceInChat(ctx, sessionId, cwd, path, isDir) },
        onOpenDiff: (tab: SidebarTab) => {
          service.openTab({
            type: 'diff', title: tab.title, id: tab.id,
            ...(tab.diff === undefined ? {} : { diff: tab.diff }),
          }, scope)
        },
        onSubagentJump: (childSessionId: string) => {
          service.openTab({ type: 'subagent', meta: { childSessionId } }, scope)
        },
      }),
    ),
  )
```

Caveat: `expanded` / `revealed` / `onToggleDir` / `onReferenceFile` / `onOpenDiff` / `onSubagentJump` are
supplied by the host shell (and in the native adapter), **but `onOpenFile` declared in `TabComponentProps` is
not passed by either call site** — treat it as unavailable.

---

## 4. Consumer `inject` contract (Q3)

Verbatim from `README_EN.md:176–192` (the official consumer example):

```ts
import type {} from 'dsh-better-sidebar'  // triggers the ctx.betterSidebar type merge
export const inject = ['betterSidebar']
export function apply(ctx: Context) {
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'my-plugin:db', title: 'Database', component: ({ scope }) => <DbView sessionId={scope.sessionId} />,
  }))
  ctx.effect(() => ctx.betterSidebar.registerFileViewer({
    id: 'my-plugin:csv', exts: ['csv'], fetchStrategy: 'custom',
    load: async (path, scope) => parseCsv(await fetchText(scope, path)),
    component: ({ customData }) => <CsvGrid rows={customData} />,
  }))
}
```

Corroborated by `README_EN.md:449`:

> "the 26 internal direct reads now go through `ctx.get('betterSidebar')` (root reflect-store resolution,
> immune to the fiber chain); **external consumers keep `inject: ['betterSidebar'] + ctx.betterSidebar`**"

The type merge that makes `ctx.betterSidebar` visible, `src/context-types.ts:579–589`:

```ts
/**
 * Consumer-facing augmentation (deliberately the only one kept): a plugin
 * that imports `Context` from `@deepseek-ai/cordis` and does
 * `import type {} from 'dsh-better-sidebar'` sees `ctx.betterSidebar`
 * without importing this package's own Context type.
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    betterSidebar: BetterSidebarService
  }
}
```

And the host-vs-client note, `src/context-types.ts:550–555`:

```ts
  /**
   * The client-side sidebar registry: external plugins register tab types
   * and file previewers here. Provided by the client half (see
   * {@link ./client/index.tsx}); undefined on the host side.
   */
  betterSidebar: BetterSidebarService
```

**Answers:** the service name is **`betterSidebar`**; the inject list is exactly **`['betterSidebar']`**;
the type import that enables the augmentation is **`import type {} from 'dsh-better-sidebar'`**. The service
exists **only in the client half** — a host-only plugin cannot register tabs.

The plugin's own (provider-side) inject lists are different and must not be copied:
`src/client/index.tsx:44` → `export const inject = ['slots', 'sessions', 'locale', 'modules', 'connection']`;
`package.json` → `dsh.client.inject = ["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-slots",
"@deepseek-ai/dsh-client-ui-conversation","@deepseek-ai/dsh-client-ui-sidebar-right","@deepseek-ai/dsh-client-modules"]`.

---

## 5. Can a registered tab be a fully custom React panel? (Q4) — Yes

**Evidence chain:**

1. The descriptor type is literally a React component factory:
   `component: (props: TabComponentProps) => ReactNode` (`lib/types/client/service.d.ts:235`).
2. The host renders it with **no chrome, no wrapper UI of its own** beyond an error boundary and a sizing div:
   `createElement(descriptor.component, { ctx, store, scope, tab, visible, expanded, revealed, onToggleDir,
   onReferenceFile, onOpenDiff, onSubagentJump })` (`src/client/sidebar/TabContent.tsx:47–54`), or the native
   variant `src/client/native/tab-adapter.tsx:301–333` inside `div.nativeTabHost` (`height:100%` column flex).
3. The built-in browser tab itself proves the pattern: it is registered through the **same** public API
   (`src/client/builtins/tabs.tsx:314–359`, "eating its own dogfood") with
   `component: (props) => <BrowserView {...props} />` — and `BrowserView` renders its **own toolbar**
   (back/forward/reload/address/GO/open-external, `BrowserView.tsx:164–227`) plus its own iframe.
4. Nothing in the service restricts the component's internals: it receives `ctx` (full client cordis context,
   so it can call other services), `store`, `scope`, `tab` (including persisted `meta`).
5. A plugin can open its tab programmatically with arbitrary persisted state:
   `service.openTab({ type: 'my-plugin:picker', title, url, meta }, scope)` — `meta` is persisted verbatim
   across reloads (`TabDescriptor` doc `lib/types/client/service.d.ts:191–206`; `state.ts:36–38`).

**So:** a plugin can register e.g. `id: 'my-plugin:element-picker'` whose `component` renders a toolbar
(pick/hover/highlight buttons, selector readout) plus **its own `<iframe sandbox="allow-scripts">`**, and run
its own `postMessage` handshake with the instrumented page. What it **cannot** do is reuse the built-in
browser tab's iframe: there is no API to obtain a handle to it, no injection hook, and the default opaque-origin
sandbox plus (for many sites) X-Frame-Options/CSP prevent framing at all.

Practical limits to budget for:
- Global per-type enable/disable switch is added automatically in the Side card settings page
  (`lib/types/client/service.d.ts:207–213`); if the user disables the type, `openTab` is a **no-op**
  (`src/client/service.ts:875–878`).
- The native tab body host is a **block scroller with a definite height** (`src/client/native/tab-adapter.tsx:304–309`,
  and `README_EN.md:310`); overlays must be positioned within that column, not against the viewport.
- WebSocket / long-lived host connections are available through the plugin's own `ctx.webServer.registerUpgrade`
  pattern (see §6) — but a third-party plugin speaking to `better-sidebar`'s own `/sidebar/ws/*` endpoints would
  be relying on non-API internals.

---

## 6. Host-side HTTP route registration pattern (Q5)

**Service face** — `src/context-types.ts:74–77` and `:505–506`:

```ts
/** The webServer service face this plugin uses. */
export interface SidebarWebServer {
  register(route: SidebarWebRoute): () => void
  registerUpgrade(route: SidebarWebUpgradeRoute): () => void
}
```

```ts
  /** The webServer service face this plugin uses. */
  webServer: SidebarWebServer
```

**Route shape** — `src/context-types.ts:60–71`:

```ts
/** One named webserver route (mirror of the host-webserver WebRoute). */
export interface SidebarWebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: SidebarHttpRequest, res: SidebarHttpResponse) => void | Promise<void>
}

/** One exact-path HTTP upgrade registration (mirror of WebUpgradeRoute). */
export interface SidebarWebUpgradeRoute {
  path: string
  handler: (req: SidebarHttpRequest, socket: SidebarUpgradeSocket, head: SidebarUpgradeHead) => void | Promise<void>
}
```

**Simplest copyable example** — `src/bundle-route.ts:122–129`:

```ts
/** Register the /sidebar/bundle route (disposed with the fiber). */
export function registerBundleRoute(ctx: Context, fence: (req: SidebarHttpRequest) => boolean): () => void {
  return ctx.webServer.register({
    kind: 'prefix',
    path: '/sidebar/bundle',
    handler: createBundleRouteHandler(fence),
  })
}
```

**The in-repo idiom (wrap in `ctx.effect` for fiber-scoped disposal)** — `src/index.ts:884–913`:

```ts
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/sidebar/api',
    handler: async (req, res) => {
      if (!fence(req)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith('/sidebar/api/') ? pathname.slice('/sidebar/api/'.length) : undefined
      if (method === undefined || method.includes('/')) {
        writeError(res, new SidebarError('not-found', 'unknown sidebar API method', 404))
        return
      }
      try {
        const payload = await readJsonBody(req)
        const handler = api[method]
        if (handler === undefined) {
          throw new SidebarError('not-found', `unknown sidebar API method "${method}"`, 404)
        }
        writeOk(res, await handler(payload))
      } catch (error) {
        writeError(res, error)
      }
    },
  }), 'dsh-better-sidebar: /sidebar/api routes')
```

Upgrade (WebSocket) idiom — `src/index.ts:1076–1082`:

```ts
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: '/sidebar/ws/terminal',
    handler: (req, socket, head) => {
      if (!fence(req)) {
        socket.destroy()
        return
      }
```

**The trust fence** — `src/index.ts:736`:

```ts
  const fence = (req: SidebarHttpRequest): boolean => isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)
```

(`ctx.webRuntime.trustedHosts` — `src/context-types.ts:98–102`, mirror of `@deepseek-ai/dsh-web-app`'s
WebRuntimeValues: LAN IP literals sampled at bind + explicit `--trusted-host` authorities.) Every route in the
plugin applies it first and rejects with 403. `ctx.effect(...)` takes an optional label string and disposes the
route with the fiber.

**A new plugin copies:** declare `inject: ['webServer', ...]` (host half), then
`ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/my-plugin/api', handler }))`. Note the
`webServer` service is a **host** service; `betterSidebar` is a **client** service — a tab-providing plugin
needs both halves, with the client half using `inject: ['betterSidebar']`.

---

## 7. Open questions

1. **No shipped design docs.** `README.md`/`README_EN.md` reference `docs/plans/*.md` (e.g.
   `2026-09-10-dsh-0.1.5-rc.2-adaptation.md`, `2026-08-22-open-with-menu-design.md`) but the npm tarball has
   **no `docs/` directory** — those design rationales are only available from the GitHub repo.
2. **No official picker/injection API.** Confirmed absent in this pass, but I did not read every one of the
   ~230 files under `src/client/`; the grep for `postMessage|contentWindow|document.domain|parent.document`
   was repo-wide across `src/` and returned zero matches, which is strong evidence.
3. **`onOpenFile` drift.** `TabComponentProps.onOpenFile` is declared
   (`lib/types/client/service.d.ts:136`) but is not passed by either render site
   (`TabContent.tsx:50–53`, `tab-adapter.tsx:310–331`). Worth confirming against a running instance before
   relying on it.
4. **Native pane geometry.** The `.nativeTabHost` / host `.paneBody` CSS contract
   (`src/client/native/tab-adapter.tsx:304–309`, `README_EN.md:310`) is described but the exact computed box
   for a third-party tab in DSH 0.1.5-rc.2 was not verified live; an element-picker overlay needs that to be
   `position: relative` + `overflow: hidden` to clip correctly.
5. **Cross-plugin discovery of the browser tab's URL.** `SidebarSnapshot.state` exposes `SidebarTab.path`
   (`state.ts:790–799`, `BrowserView.tsx:120–124`), so a plugin *could* read the built-in browser's current
   URL via `getSnapshot()` / `subscribeState()` while that tab is open — but this yields no DOM access and was
   not exercised against a live instance. Whether reading another tab type's state is considered sanctioned is
   undocumented.
6. **`allow=""` and missing `allowFullScreen`.** A third-party custom tab that renders its own iframe is not
   bound by these, but the built-in browser cannot grant fullscreen / clipboard / geolocation — unverified
   whether any internal pref lifts that.
7. **Aggregate double-mount guard** (`cordis.patch.yml`) is order-sensitive and only sees earlier loader
   entries; irrelevant to API consumers, but relevant when installing a test profile.
