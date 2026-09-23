# DSH 0.1.5-rc.2 — the **native** right-Sidebar client API

`ctx.sidebarRightTabs` (tab-type registry) + `ctx.sidebarRight` (navigation controller) +
the `sidebar.right.pane.tab` slot. How a third-party client plugin registers a **new tab type**
and opens it in DSH's own right Sidebar — no `dsh-better-sidebar` required.

Researched from:

| Source | Path |
| --- | --- |
| Shipped bundles (read-only) | `/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/` |
| Electron main (desktop shell) | `/Applications/DSH Desktop.app/Contents/Resources/app/out/main/index.js` |
| Reference third-party integration | `/Users/ravooo/Library/Application Support/dsh-desktop/harness/profiles/web/node_modules/dsh-better-sidebar/src/client/native/*` |
| Built-in native tab types (the two shipped consumers) | `@deepseek-ai/dsh-client-ui-sidebar-files`, `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` |
| Slot machinery | `@deepseek-ai/dsh-client-ui-renderer`, `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-session` |

No `.d.ts` ships for any of these in the app bundle or in the `web` profile's `node_modules`
(verified: `dsh-client-ui-sidebar-right/lib/` holds only `client.js` + `index.js`; the profile's
`node_modules/@deepseek-ai/` is **empty**). Types below are transcribed from the JS; a consumer must
declare its own structural interfaces, exactly as `dsh-better-sidebar/src/client/native/index.ts:38–48` does.

---

## 1. Executive summary — the recipe (register + open a custom tab)

1. Client half = a Cordis plugin `module.exports = { name, inject, apply }` inside
   `window.__ModuleLoader__.load({ id, factory })`.
2. `inject = ['slots', 'sidebarRightTabs']` — **cordis SERVICE names**. Separately,
   `package.json` → `dsh.client.inject` is a **package**-name list and is only a bundle load-order
   hint (`@deepseek-ai/dsh-client-ui-sidebar-right`). The two are different things; do not conflate.
3. Register the type: `ctx.sidebarRightTabs.register({ id, kind, priority: 'extension',
   title: (address) => string, guide?: [...] })` → idempotent disposer; **throws** on duplicate `id`
   or a conflicting `kind` band.
4. Custom (non-resource) tab = **omit `patterns` and `canOpen`**. It is a *page type*: addressed as
   `sidebar://<kind>`, opened by kind with no address.
5. Register the body with `key === type.id`:
   `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id }, Body))`.
   Same for `'sidebar.right.pane.tab.title'` (chip content) — the renderer looks entries up by `definition.id`.
6. Wrap each `ctx.slots.register(...)` in your own `ctx.effect(...)`: it binds to the **root** context,
   not your fiber (`dsh-client-ui-renderer/lib/client.js:1388–1391`).
7. Do **not** trigger registration off the slot *declaration*: the native seat declares
   `sidebar.right.pane.tab` **before** it provides `sidebarRightTabs`. Use cordis `inject`, or
   `ctx.inject(['sidebarRightTabs'], (c) => …)`.
8. Open: `ctx.sidebarRight.openTab(kind, { params })` — needs a **mounted** session surface, else it
   throws `sidebarRight: no session surface is mounted`. Per-session: `openTabIn(sessionId, kind, {params})`,
   a silent no-op for a session whose store was never adopted — queue + replay on the session list.
9. Page tabs are **unique per pane** (`contentId === sidebar://<kind>` ⇒ existing tab is focused).
   For N instances: add `patterns` and `openResource('dsh-resource://…')` with distinct addresses.
10. Body props: `sessionId`; `useStore`/`actions` if you declared `store`; `t` if `locale`;
    `renderSlot` if `children`; your own `inject` results; plus the slot-level `useTabInfo()`.
11. `useTabInfo()` → `{ sidebar:{expanded,fullscreen}, panel:{id}, tab:{ id, kind, title, contentId,
    visible, navigation, signal, actions } }`; `tab.actions` = `{ openTab, openResource, close }`
    (per-tab, session-bound) — that is how a body opens/closes tabs and how it closes itself.
12. **No retitle API.** `tab.title` is written once at open; live chip text requires rendering your own
    component into `sidebar.right.pane.tab.title`.
13. Body root must be `height: 100%` (or a `height:100%` flex wrapper): the native `.paneBody` host is a
    *block scroller with definite height*, not a flex container.
14. There is **no CSP on the DSH GUI page** (§4), so a plugin `<iframe>` (even `blob:`) is not blocked.
    Electron has `webSecurity: true` and no `<webview>` tag ⇒ `<iframe>` is the only embedding primitive.
    Shipped precedent: the HTML preview's `<iframe sandbox="allow-scripts">` over a `blob:` URL.
15. ✅ **Answer to the driving question: yes.** A third-party plugin can add its own tab to the
    **native** right sidebar with no dependency on `dsh-better-sidebar`, using only
    `ctx.sidebarRightTabs` + the three `sidebar.right.*` slots + `ctx.sidebarRight`.

---

## 2. Exact API reference

### 2.0 Where the two services come from

`/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js:3661–3673`

```js
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			const tabs = new SidebarRightTabRegistry(ctx);
			const { controller, adopt } = createSidebarRightController(tabs, (address, signal) => {
				ctx.resources.pin(address, signal);
			});
			const disposeRegistry = ctx.reflect.provide("sidebarRightTabs", tabs);
			const disposeService = ctx.reflect.provide("sidebarRight", controller);
			ctx.effect(() => () => {
				controller.tabDomain.dispose();
				disposeService();
				disposeRegistry();
			}, "ui-sidebar-right: service faces");
```

`/** This package's copy namespace. */ const NS = "sidebarRight";` (L3646) —
`const inject = ["slots", "layout", "locale", "resources"]` (L3648–3653).

**Service names (exact, camelCase):**

| Service | Provided by | Shape |
| --- | --- | --- |
| `sidebarRightTabs` | `dsh-client-ui-sidebar-right` | `SidebarRightTabRegistry` (§2.1) |
| `sidebarRight` | `dsh-client-ui-sidebar-right` | `SidebarRightController` (§2.3) |
| `slots` | `dsh-client-ui-renderer` | `SlotsService` (§2.5) |
| `resources` | `dsh-client-resources` | `ResourceRegistry` (§2.7) |
| `sessions` | `dsh-api-session-controller` (client half) | `ctx.sessions.list.getSnapshot()` |

`dsh-client-ui-sidebar-right/package.json` (the provider's own declaration — **package** names):

```json
  "dsh": {
    "client": {
      "inject": [
        "@deepseek-ai/dsh-api-session-controller",
        "@deepseek-ai/dsh-client-resources",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-session"
      ],
      "platform": "web"
    }
  },
```

**The two `inject` fields are different things — verified:**

* `dsh.client.inject` (package.json) → host graph row `inject`
  (`dsh-client-modules/lib/index.js:140–154`, `:355–364`) → browser kernel only uses it to
  **load those packages' bundles first**
  (`dsh-client-modules/lib/client.js:252–270`):
  ```js
  			async arriveGraphRow(row, open = [], visited = /* @__PURE__ */ new Set()) {
  				...
  				for (const packageName of row.inject) {
  					const dependency = this.graphRows.get(packageName);
  					if (dependency !== void 0) await this.arriveGraphRow(dependency, [], visited);
  				}
  				await this.arrive(row);
  			}
  ```
  It is **not** cordis injection.
* The plugin's **exported** `inject` array is cordis service injection. Cordis normalizes it and
  delays activation (`cordis/src/registry.ts:71–84`, `inject(deps, cb)` = `plugin({ inject, apply: cb })`).

The reference plugin uses both:

`dsh-better-sidebar/package.json`
```json
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": ["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-slots",
                 "@deepseek-ai/dsh-client-ui-conversation","@deepseek-ai/dsh-client-ui-sidebar-right",
                 "@deepseek-ai/dsh-client-modules"],
      "platform": "web"
    }
  },
```

`dsh-better-sidebar/src/client/index.tsx:44`
```ts
export const inject = ['slots', 'sessions', 'locale', 'modules', 'connection']
```

**Recommended declaration for a native-tab plugin:**

```js
exports.inject = ['slots', 'sidebarRightTabs']        // cordis SERVICES
```
```json
"dsh": { "client": { "platform": "web",
                     "inject": ["@deepseek-ai/dsh-client-ui-sidebar-right"],
                     "external": ["@deepseek-ai/dsh-client-ui-primitives"] } }
```

`dsh.client.external` names module-table (seed) words your bundle `require`s instead of inlining.
The platform seed table is fixed — extracted verbatim from
`dsh-web-frontend/dist/assets/index-BKQ_L1z6.js`:

```js
{react:ec,"react/jsx-runtime":ic,"react-dom":cc,"react-dom/client":fc,
 "@deepseek-ai/cordis":Ha,"@deepseek-ai/dsh-client-store":Hc,
 "@deepseek-ai/dsh-client-ui-slots":Ac,"@deepseek-ai/dsh-client-ui-primitives":Zg,
 "@deepseek-ai/dsh-client-ui-dockkit":Ey}
```

`@deepseek-ai/dsh-client-ui-dockkit` **is** requirable from a client bundle (it is a seed word) even
though it exists in no `node_modules`. It is undocumented/unsupported; its full export roster is
recoverable from the same bundle: `DockSurface, FloatLayer, DockController, createInitialState,
findTabPane, findPaneContentTab, findContentTab, getPane, getTab, getNode, dockPaneIds,
activeDockPaneId, canSplit, planOpenContent, planAddTab, planSetExpanded, planSettle, applyOp,
record, replay, stepBack, stepForward, …`. Nothing in this report depends on it.

---

### 2.1 `ctx.sidebarRightTabs.register(definition)` — the tab-type registry

`dsh-client-ui-sidebar-right/lib/client.js:3324–3384`

```js
		var SidebarRightTabRegistry = class {
			ctx;
			kinds = /* @__PURE__ */ new Map();
			ids = /* @__PURE__ */ new Set();
			listeners = /* @__PURE__ */ new Set();
			registrations = 0;
			cached = [];
			guideEntries = [];
			...
			register(definition) {
				const { id, kind } = definition;
				const band = definition.priority ?? DEFAULT_BAND;
				if (this.ids.has(id)) throw new Error(`sidebarRight: tab type id "${id}" is already registered`);
				const held = this.kinds.get(kind);
				if (held !== void 0 && !coexists(held, band)) throw new Error(`sidebarRight: tab kind "${kind}" is already registered (${held.inForce.band})`);
				this.registrations += 1;
				const entry = {
					definition,
					band,
					matchers: (definition.patterns ?? []).map((pattern) => ({
						pattern,
						test: matcherFor(pattern)
					})),
					order: this.registrations
				};
				const dispose = this.ctx.effect(() => {
					this.ids.add(id);
					const slot = this.enter(kind, entry);
					this.refresh();
					return () => { this.ids.delete(id); this.leave(kind, slot, entry); this.refresh(); };
				}, `sidebarRight.tabs.register(${JSON.stringify(id)})`);
				return () => { dispose(); };
			}
			...
		};
```

Priority bands (L3283–3297):

```js
		/** Rank of each band, highest first. */
		const RANKS = { extension: 3, builtin: 2, fallback: 1 };
		/** The band a definition that names none is in. */
		const DEFAULT_BAND = "extension";
		/**
		* Whether a band may join a held kind: an `extension` and a `builtin` pair up
		* once, and a `fallback` shares its kind with nothing.
		*/
		function coexists(slot, band) {
			return band !== "fallback" && slot.inForce.band !== "fallback" && slot.inForce.band !== band && slot.shadowed === void 0;
		}
```

Pattern compilation (L3298–3323) — a pattern **containing `:`** is matched against the whole address;
a pattern without `:` is matched against `new URL(address).pathname` with `{ basename: true }`:

```js
		function pathOf(address) {
			try { return new URL(address).pathname; } catch { return; }
		}
		/** Compile one declared pattern into the test the router runs. */
		function matcherFor(pattern) {
			const whole = pattern.includes(":");
			const match = (0, import_posix.default)(pattern, {
				nocase: true, dot: true, ...whole ? {} : { basename: true }
			});
			return (address) => {
				if (whole) return match(address);
				const path = pathOf(address);
				return path !== void 0 && match(path);
			};
		}
```

Candidate ranking + claim (L3445–3493):

```js
			candidates(address) {
				const ranked = [];
				for (const { definition, band, matchers, order } of this.active()) {
					let length = -1;
					for (const matcher of matchers) if (matcher.test(address) && matcher.pattern.length > length) length = matcher.pattern.length;
					if (length < 0) continue;
					if (definition.canOpen !== void 0 && !definition.canOpen(address)) continue;
					ranked.push({ definition, rank: RANKS[band], length, order });
				}
				ranked.sort((left, right) => right.rank - left.rank || right.length - left.length || left.order - right.order);
				return ranked.map((entry) => entry.definition);
			}
			claim(address, kind) {
				if (kind !== void 0) {
					const definition = this.get(kind);
					if (definition === void 0) throw new Error(`sidebarRight: no tab type is registered as "${kind}"`);
					if (definition.canOpen !== void 0 && !definition.canOpen(address)) throw new Error(`sidebarRight: tab type "${kind}" refuses "${address}"`);
					return { kind, contentId: address, title: definition.title(address) };
				}
				const [chosen] = this.candidates(address);
				if (chosen === void 0) throw new Error(`sidebarRight: no registered tab type claims "${address}"`);
				return { kind: chosen.kind, contentId: address, title: chosen.title(address) };
			}
```

Guide projection (L3426–3428, L3505–3512) — guide rows come only from the **in-force** type of each kind:

```js
			guide() {
				return this.guideEntries;
			}
			...
			refresh() {
				this.cached = this.active().map((entry) => entry.definition);
				this.guideEntries = this.cached.flatMap((definition) => (definition.guide ?? []).map((entry) => ({
					...entry,
					kind: definition.kind
				}))).sort((left, right) => left.order - right.order);
				(0, _deepseek_ai_dsh_client_store.notifySubscribers)(this.listeners, "[ui-sidebar-right] tab registry");
			}
```

**Definition object shape** (transcribed; the registry itself reads only these fields, all others are ignored):

```ts
interface SidebarRightTabDefinition {
  id: string                                      // globally unique across ALL types; also the slot `key`
  kind: string                                    // the tab record discriminator
  patterns?: readonly string[]                    // picomatch globs over the address (omit ⇒ page type)
  priority?: 'extension' | 'builtin' | 'fallback' // default 'extension'
  canOpen?: (address: string) => boolean          // veto, applied only when patterns matched
  title: (address: string) => string              // REQUIRED; called on every claim/seed
  guide?: readonly {                              // start-page capsules (optional)
    order: number
    title: () => string                            // thunk: re-read for the live locale
    description?: () => string                     // omit entirely rather than ''
    icon?: (props: { size?: number; className?: string }) => unknown
  }[]
}
```

> The reference plugin's structural mirror is `dsh-better-sidebar/src/client/native/index.ts:37–48`:
> ```ts
> interface NativeTabRegistry {
>   register(definition: {
>     id: string
>     kind: string
>     patterns?: readonly string[]
>     priority?: 'extension' | 'builtin' | 'fallback'
>     canOpen?: (address: string) => boolean
>     title: (address: string) => string
>     guide?: readonly { order: number; title: () => string; description?: () => string; icon?: unknown }[]
>   }): () => void
> }
> ```

**Shipped page type** (`files`, no patterns — the canonical "custom tab, not a file tab"):
`dsh-client-ui-sidebar-files/lib/client.js:10–39`

```js
		/** The tab kind this package owns. */
		const FILES_KIND = "files";
		/** This implementation's identity in the tab system, and the key its body registers under. */
		const FILES_ID = "@deepseek-ai/dsh-client-ui-sidebar-files";
		...
		function filesDefinition(t) {
			return {
				id: FILES_ID,
				kind: FILES_KIND,
				priority: "builtin",
				title: () => t("type.label"),
				guide: [{
					order: 10,
					title: () => t("guide.title"),
					description: () => t("guide.description"),
					icon: FolderSheetGlyph
				}]
			};
		}
```

**Shipped resource type** (`text`, patterns + canOpen — the canonical "claims addresses"):
`dsh-client-ui-sidebar-documentpreview/lib/client.js:1742–1772`

```js
		const TEXTPREVIEW_ID = "@deepseek-ai/dsh-client-ui-sidebar-documentpreview";
		const TEXTPREVIEW_KIND = "text";
		...
		function textDefinition() {
			return {
				id: TEXTPREVIEW_ID,
				kind: TEXTPREVIEW_KIND,
				patterns: ["dsh-resource://file/**"],
				priority: "fallback",
				canOpen: (address) => parseFileAddress(address)?.scope === "session",
				title: basenameOf
			};
		}
```

**The shipped `guide` type** (the column's start page) — `client.js:3573–3591`:

```js
		const GUIDE_ID = "@deepseek-ai/dsh-client-ui-sidebar-right/guide";
		function guideDefinition(t) {
			return {
				id: GUIDE_ID,
				kind: GUIDE_KIND,
				priority: "builtin",
				title: () => t("tab.guide.title")
			};
		}
```

#### Default-page interaction (important side effect)

`client.js:224–250`

```js
		function defaultSeed(tabs) {
			const [only, ...others] = tabs.guide();
			const kind = only !== void 0 && others.length === 0 ? only.kind : GUIDE_KIND;
			const definition = tabs.get(kind);
			if (definition === void 0) throw new Error(`sidebarRight: default tab kind "${kind}" is not registered`);
			return { kind, title: definition.title(pageAddress(kind)) };
		}
		/** The guide tab's kind. */
		const GUIDE_KIND = "guide";
		/**
		* The address a page tab is recorded under: `sidebar://<kind>`. The scheme is
		* this package's bookkeeping for `openTab`, spelled here and nowhere else; a
		* caller names the kind and never sees or composes the address.
		*/
		function pageAddress(kind) {
			return `sidebar://${kind}`;
		}
```

* The product ships exactly **one** guide entry (`files`, order 10) ⇒ a fresh column's default page is
  the file tree.
* The moment a plugin adds a **second** guide entry, the count is ≠ 1 ⇒ the default becomes the
  built-in `guide`. **Adding a guide row silently takes `files` off the default page.**
* To *own* the default page a plugin must shadow the `files` kind at `extension` priority **and**
  supply its own guide entry, so the guide list is again exactly one row — precisely what
  `dsh-better-sidebar/src/client/native/index.ts:215–238` does.

---

### 2.2 The `sidebar.right.*` slot map (all extension points)

Slot names found across every shipped `@deepseek-ai` package (exhaustive grep):

```
sidebar.right.pane.tab            keyed,  scope session   ← the tab BODY
sidebar.right.pane.tab.title      keyed,  scope session   ← the tab CHIP content
sidebar.right.tab.document        keyed,  scope session   ← nested child of the preview body only
sidebar.right.tab.guide           chain,  scope session   ← inside the guide body only
sidebar.right.tab.menu.item       list,   scope session   ← tab context-menu rows
```

Declaration, verbatim (`dsh-client-ui-sidebar-right/lib/client.js:3705–3739`):

```js
				const disposeSeat = ctx.slots.inject("rightbar", function* () {
					yield ctx.slots.register({
						name: "rightbar",
						children: { "rightbar.session": { kind: "single", scope: "session" } }
					}, RightbarRoot);
					yield ctx.slots.register({
						name: "rightbar.session",
						locale: NS,
						children: {
							"sidebar.right.pane.tab": {
								kind: "keyed",
								scope: "session",
								inject: { hooks: { tabInfo: tabInfoFactory } }
							},
							"sidebar.right.pane.tab.title": {
								kind: "keyed",
								scope: "session",
								inject: { hooks: { tabInfo: tabInfoFactory } }
							},
							"sidebar.right.tab.menu.item": { kind: "list", scope: "session" }
						},
						store,
						inject: (sessionId) => ({
							...injected,
							keyedHooks: { tabNavigation: (key) => controller.tabDomain.occurrence(sessionId, { id: key }).navigation },
							occurrence: (tab) => controller.tabDomain.occurrence(sessionId, tab)
						})
					}, RightbarSeat);
				});
```

Note `inject: { hooks: { tabInfo: tabInfoFactory } }` sits on the **slot spec**, so `useTabInfo`
reaches **every** entry in both keyed slots — a plugin cannot and need not declare it.

The menu-item slot (`sidebar.right.tab.menu.item`, list) is rendered as
(`client.js:873–876`):

```js
						renderTabMenuItems: (tab, dismiss) => renderSlot("sidebar.right.tab.menu.item", {
							tab,
							dismiss
						}),
```
⇒ an entry receives `{ tab, dismiss }` plus the session scope props. Register with `{ name, id }`
(list slots require `id`, `dsh-client-ui-slots/lib/index.js:90–95`).

---

### 2.3 `ctx.sidebarRight` — the navigation controller

Public face — `SidebarRightController`, `dsh-client-ui-sidebar-right/lib/client.js:1182–1418`.
`RESOURCE_SCHEME = "dsh-resource://"` (L1183).

```js
		var SidebarRightController = class {
			...
			openResource(address, options = {}) {
				const { sessionId, actions } = this.require();
				this.placeResource(sessionId, actions, address, options);
			}
			openTab(kind, options = {}) {
				const { sessionId, actions } = this.require();
				this.placeTab(sessionId, actions, kind, options);
			}
			openResourceIn(sessionId, address, options = {}) {
				const actions = this.actionsFor(sessionId);
				if (actions !== void 0) this.placeResource(sessionId, actions, address, options);
			}
			openTabIn(sessionId, kind, options = {}) {
				const actions = this.actionsFor(sessionId);
				if (actions !== void 0) this.placeTab(sessionId, actions, kind, options);
			}
			closeIn(sessionId, tabId) {
				const actions = this.actionsFor(sessionId);
				if (actions !== void 0) actions.closeTab(sessionId, tabId);
			}
			placeResource(sessionId, actions, address, options) {
				if (!address.startsWith(RESOURCE_SCHEME)) throw new Error(`sidebarRight: no registered tab type claims "${address}"`);
				this.place(sessionId, actions, this.tabs.claim(address, options.kind), address, options, options.params);
			}
			placeTab(sessionId, actions, kind, options) {
				const definition = this.tabs.get(kind);
				if (definition === void 0) throw new Error(`sidebarRight: no tab type is registered as "${kind}"`);
				const address = pageAddress(kind);
				this.place(sessionId, actions, { kind, contentId: address, title: definition.title(address) }, address, options, options.params);
			}
			place(sessionId, actions, claim, address, placement, params) {
				actions.openContent(sessionId, {
					kind: claim.kind,
					contentId: claim.contentId,
					title: claim.title,
					...placement.paneId === void 0 ? {} : { paneId: placement.paneId },
					...placement.replaceTab === void 0 ? {} : { replaceTab: placement.replaceTab },
					...placement.revealIfOpened === void 0 ? {} : { revealIfOpened: placement.revealIfOpened }
				}, (tabId) => {
					this.tabDomain.navigate(sessionId, tabId, { address, params });
				});
			}
			close(tabId) { const { sessionId, actions } = this.require(); actions.closeTab(sessionId, tabId); }
			active() { ... }              // → the layout tab record | undefined
			isExpanded() { return this.mounted()?.layout.expanded ?? false; }
			toggleExpanded() { ... }
			focus(tabId) { ... }          // no-op when the tab is not in the mounted layout
			split(paneId?) { ... }        // → new pane id | undefined
			float(tabId, rect?) { ... }
			dock(paneId) { ... }
			_undo() / _redo()             // @internal
			mounted() { ... }
			actionsFor(sessionId) { return this.adopted.get(sessionId)?.store.actions; }
			require() {
				if (this.binding === void 0) throw new Error("sidebarRight: no session surface is mounted");
				return this.binding;
			}
		};
```

**Option object (all four places):**

```ts
interface OpenOptions {
  kind?: string        // openResource only: force this type instead of pattern ranking
  params?: unknown     // arbitrary JSON → tab.navigation.params (not validated)
  paneId?: string      // target pane; default = active dock pane
  replaceTab?: string  // close this tab id after settling on the new one
  revealIfOpened?: boolean // default TRUE — see below
}
```

`revealIfOpened` semantics, recovered from the bundled dockkit
(`dsh-web-frontend/dist/assets/index-BKQ_L1z6.js`, `planOpenContent`):

```js
function e7(t,r,i){const s=i.revealIfOpened===!1?void 0:Q8(t,i.contentId,i.kind);
if(s!==void 0)return{ops:[{type:"focusTab",tabId:s}],tabId:s};
const a=i.paneId??Dn(t),c={id:r("tab"),kind:i.kind,contentId:i.contentId,title:i.title};...
```
`Q8` = `findContentTab`, searching **all dock panes and floats** for `(contentId, kind)`.
⇒ default `true` = "focus the existing tab with this contentId instead of opening a second one";
`false` = skip that probe and always plan a new tab. Only `=== false` disables it.

**Return values:** `openTab` / `openResource` / `openTabIn` / `openResourceIn` / `close` / `closeIn` /
`toggleExpanded` / `focus` / `float` / `dock` all return `void`.
`split()` returns `string | undefined`; `active()` returns the tab record or `undefined`;
`isExpanded()` returns `boolean`.

**Expansion side effect:** every open expands the column —
`client.js:498–502`:
```js
					openContent: (d, sessionId, intent, settled) => {
						d.bySession = seat(d, sessionId, (s) => advance(s, (state, mint) => {
							const { kind, contentId, title, replaceTab: replace } = intent;
							const ops = [...(0, _deepseek_ai_dsh_client_ui_dockkit.planSetExpanded)(state, true)];
```
There is no option to suppress it. `dsh-better-sidebar/src/client/sidebar/use-host-feeds.ts:50–66`
reads `isExpanded()` before the open and calls `toggleExpanded()` after, to "park" the column.

**Page-tab dedupe (verbatim, `client.js:503–521`):**

```js
							const page = contentId === pageAddress(kind);
							const held = page ? panePage(state, paneId ?? (0, _deepseek_ai_dsh_client_ui_dockkit.activeDockPaneId)(state), kind) : void 0;
							const planned = held !== void 0 ? {
								ops: [{ type: "focusTab", tabId: held }],
								tabId: held
							} : (0, _deepseek_ai_dsh_client_ui_dockkit.planOpenContent)(state, mint, {
								kind, contentId, title,
								...paneId === void 0 ? {} : { paneId },
								...index === void 0 ? {} : { index },
								...page ? { revealIfOpened: false } : intent.revealIfOpened === void 0 ? {} : { revealIfOpened: intent.revealIfOpened }
							});
```

**⇒ a `kind`-opened page type has at most ONE tab per pane.**
For multiple concurrent instances of a custom panel, give the type `patterns` and open distinct
`dsh-resource://…` addresses via `openResource` (optionally forcing `kind`).

**Per-session reach.** `openTabIn` depends on the session store having been *adopted*, which happens
in `store.create(scopeKey)` (`client.js:3678–3688`) — i.e. once that session's `rightbar.session`
entry has been mounted at least once in this page lifetime. `actionsFor` returns `undefined`
otherwise and the call is a silent no-op. The reference plugin's queue-and-replay wrapper is the
reference implementation: `dsh-better-sidebar/src/client/native/surface.ts:25–38, 68–119`.

---

### 2.4 What the tab-body component receives (full prop shape)

Three sources merge, in this precedence (`dsh-client-ui-renderer/lib/client.js:652–670`):
`standard kit` → entry `inject` → **slot-level** `inject` → `ownerProps` (owner wins).

```js
		function renderEntry(slotKey, Comp, kit, standard, injected, slotInjected, ownerProps, hookContext, hasHookContext) {
			if (slotInjected.slotHookFactories === void 0) return (0, react_jsx_runtime.jsx)(Comp, {
				slotKey,
				...kit,
				...injected,
				...slotInjected.props,
				...ownerProps
			});
			return (0, react_jsx_runtime.jsx)(ContextualEntry, { ... });
		}
```

**(a) Standard session scope** — `dsh-client-ui-session/lib/client.js:61–70`:

```js
		const BUILTIN_SOURCE = {
			hooks: ["session"],
			keyedHooks: ["projection"],
			props: ["sessionId"],
			resolve: (binding) => ({
				hooks: { session: binding.session },
				keyedHooks: { projection: (key) => binding.session.projections.faceOf(key) },
				props: { sessionId: binding.sessionId }
			})
		};
```
⇒ `sessionId: string` (plain prop), `useSession(selector, equal?)`, `useProjection(key, selector, equal?)`.

**(b) Standard kit additions** — `dsh-client-ui-renderer/lib/client.js:599–627`:

```js
		function standardKit(host, entry, scope, rootBinding, scopeBinding) {
			const standard = standardProps(scope, rootBinding, scopeBinding);
			const kit = { ...standard };
			if (entry.locale !== void 0) {
				const face = host.locale;
				if (face === void 0) throw new SlotAssemblyError(`entry declares locale namespace '${entry.locale}' but no locale face is installed (locale plugin missing from the composition?)`);
				kit["t"] = localeSeat(face, entry.locale);
			}
			const scopedStoreBinding = scopeBinding?.key === void 0 ? void 0 : scopeBinding;
			const store = host.storeOf(entry, scopedStoreBinding);
			if (store !== void 0) {
				kit["useStore"] = observableHook(store);
				kit["actions"] = store.actions;
			}
			if (entry.children !== void 0) {
				kit["renderSlot"] = boundRenderSlot(host, entry);
				if (Object.values(entry.children).some((spec) => spec.kind === "chain")) kit["renderSlotChain"] = boundRenderSlotChain(host, entry);
				if (Object.values(entry.children).some((spec) => spec.scope === "session")) {
					const adapter = host.scope("session");
					if (adapter === undefined) throw new SlotAssemblyError("entry declares a session child without an installed 'session' scope adapter");
					kit["SessionProvider"] = scopeAreaProvider(adapter);
				}
			}
			return { kit, standard, actions: store?.actions };
		}
```
A `store` handle declared on a **session-scoped** entry is instantiated **per session**:
`resolveStore` → `handle.create(key)` (`client.js:1328–1348`).

**(c) Contextual slot hook** — `useTabInfo` only, injected by the slot spec. Factory
(`dsh-client-ui-sidebar-right/lib/client.js:3601–3634`):

```js
		const tabInfoFactory = (standard, context) => {
			const { sessionId } = standard;
			const { tabId, title, fullscreen, signal, actions, useStore, useTabNavigation } = context;
			return function useTabInfo() {
				const layout = useStore((state) => state.bySession[sessionId]?.layout);
				const navigation = useTabNavigation(tabId);
				return (0, react.useMemo)(() => {
					const tab = layout?.tabs[tabId];
					if (layout === void 0 || tab === void 0 || navigation === void 0) throw new Error(`sidebarRight: tab "${tabId}" is not committed in session "${sessionId}"`);
					const pane = (0, _deepseek_ai_dsh_client_ui_dockkit.findTabPane)(layout, tabId);
					return {
						sidebar: { expanded: layout.expanded, fullscreen },
						panel: { id: pane.id },
						tab: {
							...tab,
							visible: pane.host === "float" || layout.expanded && (title || pane.activeTabId === tabId),
							navigation,
							signal,
							actions
						}
					};
				}, [layout, navigation, tabId, title, fullscreen, signal, actions]);
			};
		};
```
and the `hookContext` it receives (`client.js:716–741`):

```js
		function TabSlot({ renderSlot, occurrence, useTabTypes, useTabNavigation, useStore, fullscreen, tab, seat, fallback }) {
			const { signal, tabActions } = occurrence(tab);
			const definition = useTabTypes((types) => types.find((definition) => definition.kind === tab.kind));
			const hookContext = (0, react.useMemo)(() => ({
				tabId: tab.id,
				title: seat === "sidebar.right.pane.tab.title",
				fullscreen,
				signal,
				actions: tabActions,
				useStore,
				useTabNavigation
			}), [...]);
			return renderSlot(seat, {}, {
				entryKey: definition?.id ?? tab.kind,
				fallback,
				hookContext
			});
		}
```
`entryKey: definition?.id ?? tab.kind` ⇒ **the body/title must be registered under `key === type.id`.**

**Consolidated body-prop shape**

```ts
interface NativeTabBodyProps {
  // (a) session scope
  sessionId: string
  useSession: (selector?, equal?) => unknown
  useProjection: (key, selector?, equal?) => unknown

  // (b) declared by the plugin's own registration
  useStore?: (selector?, equal?) => unknown      // if `store` declared
  actions?: Record<string, (...args: any[]) => any> // that store's actions
  t?: (key: string, params?) => string           // if `locale: '<ns>'` declared
  renderSlot?: (key, owner?, opts?) => ReactNode // if `children` declared
  renderSlotChain?: (key, owner, opts?) => ReactNode
  SessionProvider?: React.ComponentType<any>

  // (c) from the slot spec (always present on this slot)
  useTabInfo: () => {
    sidebar: { expanded: boolean; fullscreen: boolean }
    panel:   { id: string }
    tab: {
      id: string
      kind: string
      title: string
      contentId: string                                  // the address ('sidebar://<kind>' or dsh-resource://…)
      visible: boolean
      navigation: { address: string; params: unknown; revision: number }
      signal: AbortSignal                                // aborts when the tab record disappears
      actions: {                                         // per-tab navigation, bound to this tab's session
        openResource: (address: string, options?: OpenOptions) => void
        openTab:      (kind: string,    options?: OpenOptions) => void
        close:        () => void
      }
    }
  }

  // (d) whatever the plugin's own entry `inject(sessionId, actions)` returned,
  //     with `hooks: {name}` / `keyedHooks: {name}` converted to `use<Name>`:
}
```

Tab record identity — dockkit creates exactly `{ id, kind, contentId, title }`
(`planOpenContent`: `const c={id:r("tab"),kind:i.kind,contentId:i.contentId,title:i.title}`), then
`tabInfoFactory` spreads it and adds `visible`, `navigation`, `signal`, `actions`.
`navigation` is a **snapshot value**, not a store — `useTabNavigation` is a keyed hook
(`dsh-client-ui-renderer/lib/client.js:233–239`).

`tabActions` construction (`client.js:1112–1148`):

```js
				const held = {
					sessionId, tabId, controller,
					signal: controller.signal,
					navigation: (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(navigation),
					paneId: void 0,
					pinned: false,
					tabActions: {
						openResource: (address, options = {}) => {
							navigator.openResourceIn(sessionId, address, { ...place(options), params: options.params });
						},
						openTab: (kind, options = {}) => {
							navigator.openTabIn(sessionId, kind, { ...place(options), params: options.params });
						},
						close: () => { navigator.closeIn(sessionId, tabId); }
					}
				};
```
`place(placement)` (L1115–1119) makes the tab's **own pane** and `replaceTab` the defaults for
opens launched from inside it.

**Chip title** — the `sidebar.right.pane.tab.title` entry receives the same standard props plus
`useTabInfo`; `hookContext.title === true` distinguishes the two seats. The framework fallback is
`tab.title` (`client.js:762–770`):

```js
		function titlesFor(panel) {
			return (tab) => (0, react_jsx_runtime.jsx)(TabSlot, {
				...panel, tab, seat: "sidebar.right.pane.tab.title", fallback: tab.title
			}, tab.id);
		}
```

**No body registered** ⇒ this fallback (L749–761):

```js
				fallback: (0, react_jsx_runtime.jsx)("p", {
					className: SidebarRight_module_css_default.unavailable,
					"data-sidebar-right-unavailable": true,
					children: t("tab.unavailable")
				})
```

**CSS contract:** the native host is a block scroller with a definite height, so a body root that uses
`flex: 1` collapses. Quoted from the reference plugin
(`dsh-better-sidebar/src/client/sidebar.module.css:2040–2057`):

```css
/* ── Native right-Sidebar tab-body host ──────────────────────────────────
   DSH's native tab body host (`.paneBody` in dsh-client-ui-dockkit) is a
   BLOCK scroller with a definite height, not a flex container — the host's
   own tab bodies (TextPreview, FilesBody) declare `height: 100%` on their
   root for exactly this reason. ...
.nativeTabHost {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
```

---

### 2.5 `ctx.slots` — register / inject

`dsh-client-ui-renderer/lib/client.js:1388–1391` (**ownership caveat**):

```js
		SlotRegistry.prototype.register = function register(rawOptions, component) {
			const options = rawOptions;
			return this.ctx.effect(() => this["_register"](options, component), "slots.register()");
		};
```
`this.ctx` is the renderer's own root context ⇒ **the registration does not die with your plugin's
fiber unless you wrap it in your own `ctx.effect(...)`.** Every shipped consumer does.

`ctx.slots.inject(key, callback)` (`client.js:1015–1074`) — runs `callback` now if the slot is already
declared, otherwise inside the declaring `register()`; re-runs on each declaration epoch; returns an
idempotent disposer. `callback` may return a disposer **or an iterable of disposers**.

Registration options (`dsh-client-ui-slots/lib/index.js:72–152`):
`{ name, key?, id?, order?, label?, priority?, select?, inject?, children?, store?, locale?, registrant? }`
— `key` required for `keyed`, `id` required for `list`, `select` required for `chain`.
Duplicate `(cell, priority)` throws; **lower priority renders** (winner = lowest `priority` per cell).

Hook-name conversion (`dsh-client-ui-slots/lib/index.js:7–9`):

```js
function standardHookPropName(name) {
	return `use${name[0]?.toUpperCase() ?? ""}${name.slice(1)}`;
}
```

`inject` forms:
* entry `inject` may be an **object** (static) or a **function** `(key, actions) => props`
  (`client.js:333–339`); inside it, `hooks: {name: source}` → prop `use<Name>` (a uSES selector hook),
  `keyedHooks: {name: resolver}` → prop `use<Name>(key, selector?, equal?)`
  (`client.js:342–357`).
* a slot-**spec** `inject` (`children[key].inject`) with a **function** value under `hooks` is a
  *contextual factory* `(standard, hookContext) => hook` (`client.js:361–396`) — this is how
  `useTabInfo` is delivered.

---

### 2.6 Sandboxed-iframe precedent in the product

The **only** `<iframe>` in any shipped DSH client package is the HTML document preview
(`dsh-client-ui-sidebar-documentpreview/lib/client.js:2356–2400`):

```js
		/** Complete HTML rendered in a script-enabled opaque iframe, without parent application access. */
		/** One mounted file owns its root Blob; replacing content also replaces the browsing context. */
		function HtmlFrame({ data, readRelative, t }) {
			...
						const bundle = await packHtml(data, readRelative, controller.signal);
						controller.signal.throwIfAborted();
						const html = createHtmlDocument(bundle);
						url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
			...
			return (0, react_jsx_runtime.jsx)("iframe", {
				className: HtmlBody_module_css_default.frame,
				src: frame.url,
				sandbox: "allow-scripts",
				title: t("frame"),
				"data-html-preview": true
			}, frame.url);
		}
```

* `sandbox="allow-scripts"` — **no `allow-same-origin`** ⇒ opaque origin, no parent access.
  `postMessage` still works, but the parent sees `event.origin === "null"`; authenticate by
  `event.source` identity, not origin.
* `blob:` URL + the address as React `key` ⇒ replacing content replaces the browsing context.
* This is the pattern to copy for a picker chrome page. There is no DSH "panel" component for it —
  you render your own `<iframe>` inside your own tab body, exactly as this built-in does.

There is **no** generic "web / URL" tab type and **no** `dsh-resource://http` provider in 0.1.5-rc.2.
The complete set of shipped consumers of `sidebarRightTabs` is:

```
$ grep -rn "sidebarRightTabs" @deepseek-ai/*/lib/client.js
dsh-client-ui-sidebar-files/lib/client.js:694        ctx.sidebarRightTabs.register(filesDefinition(t))
dsh-client-ui-sidebar-documentpreview/lib/client.js:26935  ctx.sidebarRightTabs.register(textDefinition())
dsh-client-ui-sidebar-right/lib/client.js:3667, 3668  reflect.provide("sidebarRightTabs", …)
```
— i.e. **one built-in page kind (`files`) and one built-in resource kind (`text`, `fallback`,
`dsh-resource://file/**`)**. Any URL/web tab is a plugin's own invention.

### 2.7 `ctx.resources` — the `dsh-resource://` provider protocol

`dsh-client-resources/lib/client.js:16–25, 42–57, 176`:

```js
		function protocolOf(address) {
			let parsed;
			try { parsed = new URL(address); } catch { return; }
			if (parsed.protocol !== `dsh-resource:`) return void 0;
			return parsed.hostname === "" ? void 0 : parsed.hostname.toLowerCase();
		}
		...
			register(provider) {
				const runtime = provider;
				const { protocol } = runtime;
				if (this.providers.has(protocol)) throw new Error(`resources: protocol "${protocol}" already has a provider`);
				...
			}
			...
			pin(address, signal) { ... }        // called by the tab domain for every occurrence
			source(address) { return this.record(address).source; }
		...
			ctx.slots.provideRoot({ keyedHooks: { resource: (address) => resources.source(address) } });
```

```ts
interface ResourceProvider {
  protocol: string                                  // the URL host of dsh-resource://<protocol>/…
  open(address: string, opts: { signal: AbortSignal }): AsyncIterable<
    { ok: true; value: unknown } | { ok: false; error: unknown }>
}
```
Consumption: `useResource(address, selector?)` in any slot component (a *root* keyed hook), or
`ctx.resources.source(address)` with `getSnapshot()/subscribe()`. The right sidebar **pins** every
open tab's address, so a provider's stream starts when a tab showing that address exists and aborts
when the tab closes.

---

## 3. Complete minimal client-plugin example

A standalone package that owns a custom page kind `element-picker` with its own body, chip title, and
browser-internal `<iframe>` panel, plus an explicit open call.

### 3.1 `package.json`

```json
{
  "name": "dsh-example-native-tab",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-sidebar-right"],
      "external": ["@deepseek-ai/dsh-client-ui-primitives"]
    }
  }
}
```

* `dsh.client.inject` — **package** names; only makes the provider's bundle arrive first.
* `dsh.client.external` — module-table (seed) words this bundle `require`s instead of inlining.
  The full seed table is in §2.0; only these two are needed here.

### 3.2 `lib/index.js` (host half — required because `main` is a Cordis plugin)

```js
// The host half. A client-only plugin still needs a main entry: the Loader mounts the package as a
// host row, and the same row tells dsh-client-modules to serve exports["./client"].
export function apply() {}
export const name = 'dsh-example-native-tab'
```

### 3.3 `cordis.patch.yml`

```yaml
# One row serves both halves. The row id/name MUST equal the package name: that is the key the Loader
# uses to resolve the package and that the client-modules scanner uses to find package.json.
- insert:
    - id: dsh-example-native-tab
      name: dsh-example-native-tab
```

### 3.4 `lib/client.js` — hand-writable, no build step

```js
window.__ModuleLoader__.load({
  id: "dsh-example-native-tab",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var h = React.createElement;

    // ── identity ────────────────────────────────────────────────────────────────────────────────
    var PLUGIN_ID = "dsh-example-native-tab";
    var KIND = "element-picker";                 // the tab record's `kind`
    var TYPE_ID = PLUGIN_ID + "/panel";          // globally unique; ALSO the slot `key`

    // ── the tab body ────────────────────────────────────────────────────────────────────────────
    // Props: sessionId, useTabInfo, useStore/actions if declared, t if `locale` declared, ...
    function PickerBody(props) {
      var info = props.useTabInfo();
      var tab = info.tab;

      // The URL to show: per-instance state rides `navigation.params`, JSON by convention.
      var params = (tab.navigation && tab.navigation.params) || {};
      var url = typeof params.url === "string" ? params.url : "about:blank";

      // NOTE: there is no public "retitle this tab" API — `tab.title` keeps the open-time value.
      // The only live-title path is to render it yourself in the `sidebar.right.pane.tab.title`
      // slot (see §5, uncertainty U3).

      var frame = h("iframe", {
        src: url,
        sandbox: "allow-scripts",                 // opaque origin; no parent DOM access
        style: { border: "none", width: "100%", height: "100%", background: "#fff" },
        title: "Element picker"
      });

      return h(
        "div",
        {
          // the native host (`.paneBody`) is a BLOCK scroller with a definite height:
          // declare height:100% on the root or the panel collapses.
          style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 },
          "data-dsh-example-picker": ""
        },
        h("div", { style: { flex: "none", padding: "6px 10px", font: "var(--dsw-font-xxs-12)" } },
          tab.title, " — ", tab.contentId, tab.visible ? "" : " (hidden)"),
        h("div", { style: { flex: "auto", minHeight: 0 } }, frame)
      );
    }

    // ── the chip title (optional; omit to keep the title captured at open time) ──────────────────
    function PickerTitle(props) {
      var tab = props.useTabInfo().tab;
      return h("span", null, tab.title);
    }

    // ── the plugin body ─────────────────────────────────────────────────────────────────────────
    // These are cordis SERVICE names, not package names.
    var inject = ["slots", "sidebarRightTabs"];

    function apply(ctx) {
      // 1. Register the tab TYPE. No `patterns`/`canOpen` ⇒ a page type, opened by kind.
      //    `priority: 'extension'` (the default) lets a future plugin shadow this one.
      ctx.effect(
        () => ctx.sidebarRightTabs.register({
          id: TYPE_ID,
          kind: KIND,
          priority: "extension",
          title: function () { return "Element picker"; },
          // A guide row is optional. Adding one takes the file tree off the column's DEFAULT page
          // (defaultSeed needs exactly one guide entry product-wide) — see §2.1.
          guide: [{
            order: 50,
            title: function () { return "Element picker"; },
            description: function () { return "Pick an element from a page"; }
          }]
        }),
        "dsh-example-native-tab: type"
      );

      // 2. Register the BODY. `key` MUST equal the type's `id`.
      //    ctx.slots.inject waits for the seat to DECLARE the slot, then registers.
      ctx.effect(
        () => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
          name: "sidebar.right.pane.tab",
          key: TYPE_ID
        }, PickerBody)),
        "dsh-example-native-tab: body"
      );

      // 3. Register the CHIP TITLE. Same key. Without it the chip shows the open-time title.
      ctx.effect(
        () => ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
          name: "sidebar.right.pane.tab.title",
          key: TYPE_ID
        }, PickerTitle)),
        "dsh-example-native-tab: title"
      );

      // 4. OPEN it. ctx.sidebarRight acts on the MOUNTED session and throws when none is mounted.
      //    Expose an opener on the plugin object for the host half / other plugins.
      module.exports.open = function (params) {
        ctx.sidebarRight.openTab(KIND, { params: params || {}, revealIfOpened: true });
      };
    }

    module.exports.name = PLUGIN_ID;
    module.exports.inject = inject;
    module.exports.apply = apply;

    return module.exports;
  }
});
```

### 3.5 Opening it — three call sites

```js
// A) mounted session, page tab (one instance per pane; re-opening focuses it):
ctx.sidebarRight.openTab('element-picker', { params: { url: 'https://example.com' } })

// B) a specific session, even if it is not on screen (silent no-op when that session's
//    right-sidebar store was never adopted — queue and replay on the session list instead):
ctx.sidebarRight.openTabIn(sessionId, 'element-picker', { params: { url } })

// C) N instances: give the type `patterns: ['dsh-resource://picker/**']`, then:
const address = 'dsh-resource://picker/' + encodeURIComponent(url)
ctx.sidebarRight.openResource(address, { kind: 'element-picker', params: { url } })
```

### 3.6 The reference plugin's equivalent, abridged

`dsh-better-sidebar/src/client/native/index.ts:170–213`:

```ts
    const registerDescriptor = (descriptor: TabDescriptor): (() => void) => {
      const id = nativeId(descriptor.id)
      const isEditor = descriptor.id === EDITOR_KIND
      const icon = descriptor.icon
      const disposeType = tabs.register({
        id,
        kind: descriptor.id,
        ...(isEditor
          ? {
            patterns: ['dsh-resource://file/**'],
            canOpen: (address: string) => parseFileAddress(address) !== undefined,
          }
          : {}),
        priority: 'extension',
        title: (address: string) => (isEditor ? fileTitleOf(address) ?? titleOf(descriptor) : titleOf(descriptor)),
        ...(descriptor.hidden === true || isEditor
          ? {}
          : {
            guide: [{
              order: descriptor.order ?? 100,
              title: () => titleOf(descriptor),
              ...guideDescriptionOf(descriptor),
              ...guideIconOf(icon),
            }],
          }),
      })
      const slots = registerSlots(
        id,
        { ctx, store, service, records, descriptorId: descriptor.id },
        isEditor ? { paramsOf: fileParamsOf, sessionIdOf: fileSessionIdOf } : {},
      )
      return () => {
        for (const dispose of slots.reverse()) dispose()
        disposeType()
      }
    }
```

`dsh-better-sidebar/src/client/native/index.ts:151–167`:

```ts
    const registerSlots = (
      id: string,
      injected: Omit<NativeBodyInjected, 'sessionId'>,
      params: Pick<NativeBodyInjected, 'paramsOf' | 'sessionIdOf'>,
    ): Array<() => void> => [
      ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: id,
        inject: (sessionId: string) => ({ ...injected, ...params, sessionId }),
      }, NativeTabBody)),
      ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: id,
        inject: () => ({ records, service, descriptorId: injected.descriptorId }),
      }, NativeTabTitle)),
    ]
```

`dsh-better-sidebar/src/client/native/surface.ts:30–38, 68–98` — the per-session wrapper:

```ts
interface NativeController {
  openTab(kind: string, options?: { params?: unknown; revealIfOpened?: boolean }): void
  openResource(address: string, options?: { params?: unknown; revealIfOpened?: boolean }): void
  close(tabId: string): void
  /** Not part of `ISidebarRight`: the concrete controller's per-session writes. */
  openTabIn?(sessionId: string, kind: string, options?: { params?: unknown; revealIfOpened?: boolean }): void
  openResourceIn?(sessionId: string, address: string, options?: { params?: unknown; revealIfOpened?: boolean }): void
  closeIn?(sessionId: string, tabId: string): void
}
```

---

## 4. CSP findings

### 4.1 The DSH GUI page sends **no Content-Security-Policy** and no `X-Frame-Options`

The GUI index is rendered by `frontend-static`, whose entire response header set is one line
(`dsh-host-frontend-static/lib/index.js:59–74`):

```js
		if (target === distRoot || target === distIndex) {
			if (!authorizeIndex()) return;
			body = await renderIndex();
			type = HTML_MIME;
		} else {
			body = await readFile(target);
			type = MIME[extname(target)] ?? "application/octet-stream";
		}
	...
	res.writeHead(200, { "content-type": type });
	res.end(body);
```

The only `authorizeIndex` branch that writes extra headers is the token exchange / redirect
(`dsh-client-connection/lib/client.js:386–425`) — `cache-control`, `location`, `referrer-policy`,
`set-cookie`. **No CSP, no `frame-ancestors`, no `X-Frame-Options`.**

The webserver itself adds nothing (`dsh-host-webserver/lib/index.js:228–259`) and its index rendering
is pure text splicing (`:354–362`):

```js
		renderIndex(html) {
			return this.applyIndexTaps(renderIndexInjections(html, this.collectIndexInjections()));
		}
```

`dsh-web-frontend/dist/index.html` has **no** `<meta http-equiv="Content-Security-Policy">` — it is
8 lines: charset, viewport, manifest, icon, title, one module script, one modulepreload, two
stylesheets.

No DSH package injects a CSP via Electron either: `out/main/index.js` contains **no**
`onHeadersReceived` / `webRequest` interception. The GUI window is created at
`out/main/index.js:19449–19474`:

```js
  const window = new BrowserWindow({
    ...
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      sandbox: true,
      webSecurity: true
    }
  });
```
and loaded directly (`:19566`): `await window.loadURL(rendererUrl);`
No `webviewTag`, so `<webview>` is unavailable; `<iframe>` is the only embedding primitive.

**⇒ a plugin-created `<iframe>` (including `blob:` / `data:` src) and inline `<script>` are NOT blocked
by any header DSH sends. There is no CSP to fight.**

### 4.2 The one CSP that *does* exist in the product, and where

Three places, none of them the GUI page:

**(a) Pairing/mobile companion server — `out/main/index.js:1468–1476`.** This is the phone-pairing
screen served by the desktop shell (`/desktop`, `/desktop/pending`, `/desktop/tunnel/*`), **not** the
harness GUI:

```js
  async handle(request, response) {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader(
      "content-security-policy",
      "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"
    );
```
Exact header value:
```
content-security-policy: default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'
```
(Note it has **no `frame-src` and no `frame-ancestors`** — but it also serves no plugin UI.)

**(b) Session media/file reads — `dsh-api-session-controller/lib/index.js:2355–2364`.** Every
`GET/HEAD /api/file` response:

```js
const BASE_HEADERS = {
	"Cache-Control": "private, no-store",
	"X-Content-Type-Options": "nosniff",
	"Content-Security-Policy": "sandbox; default-src 'none'"
};
```
Exact: `Content-Security-Policy: sandbox; default-src 'none'` — plus
`X-Content-Type-Options: nosniff`. Useful if a plugin serves its own untrusted bytes through this
route; irrelevant to the GUI document.

**(c) Nothing else.** Exhaustive grep over every `@deepseek-ai` package for
`content-security-policy|default-src|script-src|frame-ancestors|frame-src|x-frame-options` returns only
the two sites above plus the unrelated `"script-src"` index-injection *row kind* in
`dsh-host-webserver/lib/index.js:34` and `dsh-client-modules/lib/index.js:448` (markup splicing, not a
header).

### 4.3 Caveats that are not CSP

* The **target** site's own `X-Frame-Options` / `frame-ancestors` still applies to any cross-origin URL
  you frame — DSH cannot and does not proxy around it (documented at length in
  `docs/research/better-sidebar.md` §2.5).
* `sandbox="allow-scripts"` without `allow-same-origin` means the framed document is opaque-origin:
  you get `postMessage` but no DOM access, and `event.origin === "null"`.
* If the GUI is opened over a LAN/tunnel origin, the *pairing* server's CSP (§4.2a) governs that
  separate page, not the harness GUI.

---

## 5. Open questions / uncertainties

**U1 — `sidebarRightTabs.register` throws on `id` collision, but nothing warns on a *kind* collision
across bands.** `coexists` admits one `extension` + one `builtin` per kind and silently shadows the
lower band. A plugin registering `kind: 'files'` at `extension` priority takes the file tree over
without any diagnostic (this is exactly what `dsh-better-sidebar` does deliberately). **Not verified:**
whether any user-facing surface reports the takeover. `isTabEnabled`/`getTabs` in the reference plugin
are *its own* registry, not the native one — the native registry has no enable/disable switch at all.

**U2 — `revealIfOpened` is undocumented in DSH itself.** Its meaning is inferred from the minified
dockkit in the frontend bundle (`planOpenContent`, quoted in §2.3), not from any comment or type.
I could not find a `.d.ts` or source for `@deepseek-ai/dsh-client-ui-dockkit` anywhere on disk or in
any `node_modules` (it exists only as a platform seed word). Treat `false` as "always plan a new tab"
and `true`/omitted as "focus an existing tab with the same `(contentId, kind)`".

**U3 — there is no public "retitle this tab" API.** The tab record's `title` is written once at
claim/seed time (`place()` → `openContent({title})`). Nothing on `SidebarRightController` mutates it
afterwards; `tab.actions` is only `{ openResource, openTab, close }`. The reference plugin gets live
titles by intercepting the **chip slot**: `sidebar.right.pane.tab.title` renders *its own* component,
which reads a plugin-side record and ignores `tab.title`
(`dsh-better-sidebar/src/client/native/tab-adapter.tsx:358–386`). So a plugin can make the chip show
anything, but `useTabInfo().tab.title` (and therefore the framework fallback and the float header)
keeps the open-time value. **Not verified:** whether the floating panel's header uses the same title
slot or the raw record — the float layer (`Floats`, `client.js:885–905`) passes `renderTab` **and**
`renderTabTitle`, which suggests the slot, but dockkit is opaque and I did not exercise it at runtime.

**U4 — `openTabIn` / `openResourceIn` / `closeIn` are present on the concrete class but explicitly
"Not part of `ISidebarRight`"** (comments at `client.js:1237–1239, 1250–1251, 1262–1263`). They are
untyped, unsupported, and may change. The reference plugin feature-detects them at call time
(`surface.ts:79, 93, 130`) rather than assuming they exist. **Not verified:** whether older/newer
`0.1.5-rc.*` builds all have them.

**U5 — the mounted-session binding is a single slot.** `bind(binding)` replaces any previous binding
and the seat releases it on unmount (`client.js:1211–1216`, `:973–983`), so `ctx.sidebarRight.openTab`
only ever targets the *currently rendered* session. I did not find a documented way to act on a
non-rendered session other than `openTabIn`. **Not verified at runtime:** whether two panes/sessions
can be mounted simultaneously in this build (the seat is `scope: 'session'`, single).

**U6 — no runtime verification was performed.** Everything above is read from shipped JS/source; I
could not exercise the API. The live GUI at `http://127.0.0.1:43129` returned
`401 Unauthorized` with only `cache-control: no-store; content-type: text/plain` for an
unauthenticated `GET /` — the launch token is generated in-memory per process
(`dsh-client-connection/lib/index.js:240–246`, `processLaunchToken` → `randomBytes(SECRET_BYTES)`) and
is not persisted anywhere I could read, so I could not fetch the authenticated index to confirm the
absent CSP header empirically. **The CSP conclusion therefore rests on source inspection of every
response path that can serve the index** (§4.1), which is strong but not an observed header dump.
Confirming it takes one devtools `document.contentSecurityPolicy` or a `curl` with a valid session
cookie.

**U7 — `sidebar.right.tab.menu.item`** (list slot, `{ tab, dismiss }`) is a real extension point I
found but did not exhaustively trace: a list entry's `id` must be unique, and "lower priority renders"
means passing `priority` to shadow. I did not verify what `dismiss` does beyond the name, nor whether
the menu renders for floating panels (only `SidebarPanel` passes `renderTabMenuItems`; `Floats` does
not, `client.js:869` vs `:885–905`).

**U8 — copy/localization.** Tab titles are plain strings returned by `title(address)`. To follow the
live language the thunk must be evaluated per call (the shipped types bind `ctx.locale` and call
`t(...)` inside `title`, e.g. `title: () => t("type.label")`). A `sidebar.right.pane.tab.title` entry
may declare `locale: '<ns>'` to receive `t`. Not a blocker, but easy to get wrong: capturing the
string once at `register()` time freezes it.

---

### Cross-reference

For the `dsh-better-sidebar` (`ctx.betterSidebar`) alternative and its embedded-browser limitations,
see `docs/research/better-sidebar.md`. For the existing `dsh-webpage-element-picker` plugin's
internals (inspector script, host routes, `[label][DOMn]` placeholders, the client module-wrapper
format), see `docs/research/picker-internals.md`.

The **native** surface documented here is independent of both: it needs no third-party sidebar
plugin, and it is the only path that puts a plugin's own panel into DSH's own right column.
