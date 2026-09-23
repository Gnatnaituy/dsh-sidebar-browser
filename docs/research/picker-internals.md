# `dsh-webpage-element-picker` v0.3.0 — internals reference

Research target (read-only, outside the workspace):

```
PKG=/Users/ravooo/Library/Application Support/dsh-desktop/harness/profiles/web/node_modules/dsh-webpage-element-picker
```

Files read in full: `resources/inspector.js` (409 lines), `lib/client.js` (540), `lib/index.js` (659),
`resources/helper-playwright.js` (partial, bridge + command dispatch), `package.json`, `cordis.patch.yml`, `README.md`.
Profile files: `harness/profiles/web/package.json`, `harness/profiles/web/cordis.patch.yml`.
Slot ground truth: `/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js`.

Package layout (`$PKG/package.json`): `"type": "module"`, `main: lib/index.js` (host, ESM), `exports["./client"] = lib/client.js`,
`dsh.bundle.patch = ./cordis.patch.yml`, `dsh.client = { platform: "web", external: ["@deepseek-ai/dsh-client-ui-primitives"] }`.

---

## 1. INSPECTOR — `resources/inspector.js`

### 1.0 Shape and activation model

Plain ES5 IIFE, **no imports, no shadow DOM, no bundler**. It is injected by the helper through
`page.evaluate(inspectorCode)` (`resources/helper-playwright.js`, `inject()`); *injection is activation*.

```js
10: (function () {
11:   'use strict'
12:   if (window.__dsh_we_active__) return
13:   window.__dsh_we_active__ = true
```

Globals it owns:

| global | line | purpose |
|---|---|---|
| `window.__dsh_we_active__` | 12–13 | re-entry guard |
| `window.__dsh_we_cleanup__ = cleanupAll` | 408 | helper calls this before re-injecting (`helper-playwright.js` `inject()`) |
| `window.__dsh_we_test_state__()` → `state` | 388 | test hook (`'hover'` \| `'selected'`) |
| `sessionStorage['__dsh_we_debug__'] === '1'` | 15–16 | enables `console.debug('[dsh-we] …')` |
| `sessionStorage['__dsh_we_hint__']` | 358–359 | one first-run hint per browser session |

**Critical protocol constraint (lines 4–7 comment + 165–167):** `console.log` is reserved exclusively for
`'__DSH_WE__:' + JSON`. All debug output must go through `console.debug` (no prefix), otherwise the helper's
console bridge would try to parse it.

### 1.1 Selection mode: enter / leave, mouse, keyboard, floating toggle

State machine: `state ∈ {'hover','selected'}` plus orthogonal `paused: boolean` (lines 53–56).

**Enter** — activation block, lines 369–376 (all listeners capture phase = `true`):

```js
370:   document.addEventListener('mousemove', onMM, true)
371:   document.addEventListener('pointerdown', onPD, true)
372:   document.addEventListener('mouseup', onBlockUp, true)
373:   document.addEventListener('pointerup', onBlockUp, true)
374:   document.addEventListener('click', onBlockUp, true)
375:   document.addEventListener('keydown', onKD, true)
376:   document.documentElement.style.cursor = 'crosshair'
```

**Hover highlight** — `onMM` (219–229): uses `document.elementFromPoint(e.clientX, e.clientY)`; own UI is
skipped via `isOurEl` (170–172: `el.closest('[data-dsh-we]')`), in which case both overlays are hidden.
Otherwise the blue box `ov` and the label `lb` are moved to the element's `getBoundingClientRect()`:
`lb.textContent = '<' + tagName + '> ' + round(w) + 'x' + round(h)`, positioned at `r.left`, `max(0, r.top - 22)`.

**Click to lock** — `onPD` (235–254), `pointerdown` only:

```js
236:     if (paused) return
237:     if (e.button === 2) return                 // right button ignored
238:     if (isOurEl(e.target)) return
239:     e.preventDefault()
240:     e.stopPropagation()
241:     e.stopImmediatePropagation()               // page never sees the press
242:     var target = document.elementFromPoint(e.clientX, e.clientY)
243:     if (!target || isOurEl(target)) return
244:     if (state === 'hover') {
245:       selEl = target
246:       selData = collectData(target)
247:       state = 'selected'
249:       lockOverlay(target)                      // orange #f59e0b, hides label
250:       showAb(target)                           // floating action bar
251:     } else {
252:       returnToHover()                          // click-away deselects
253:     }
```

`onBlockUp` (257–261) swallows `mouseup`/`pointerup`/`click` while not paused and the target is not ours
(`preventDefault` + `stopImmediatePropagation`) so the inspected page gets no click.

**Keyboard** — `onKD` (264–275): `` ` `` → `togglePause()`; `Escape` → `exitMode()` (both
`preventDefault` + `stopPropagation`). While paused the *only* remaining key listener is `onBacktick` (278–284),
registered by `pause()`.

**Pause / resume** (`` ` ``, chip click, or `togglePause` 286–289):

* `pause()` 295–313: removes **all six** interception listeners, adds only `keydown → onBacktick`, hides `ov`/`lb`/`ab`,
  resets cursor, sets `chip.textContent = '⌖ 选择模式：已暂停（点击恢复，或按 `）'`, clears `state='hover'`, `selEl=null`, `selData=null`.
  → the page becomes fully interactive (intended for manual login).
* `resume()` 316–328: removes `onBacktick`, re-adds the six listeners, cursor `crosshair`,
  chip text `'⌖ 选择模式：开启（点击暂停，或按 `）'`.

**Floating toggle button (`chip`)** 47–51: `data-dsh-we="chip"`, `position: fixed; bottom: 16px; right: 16px;
z-index: 2147483642; border-radius: 16px; cursor: pointer`, `textContent = '⌖ 选择模式：开启（点击暂停，或按 `）'`,
`click` → `e.stopPropagation(); e.preventDefault(); togglePause()`. It is created once and **never removed by pause**;
only `cleanupAll` removes it.

**Action bar (`ab`, appears after lock)** 33–44: `data-dsh-we="ab"`, `position: fixed; z-index: 2147483642;
background: #1e1e1e; display: flex` when shown; buttons 「添加到对话」 (`data-dsh-we-add="1"`) and 「取消」.
`positionAb` (180–192) places it below the element (36px tall, 6px margin), flips above when it would overflow the
viewport bottom, clamps to top, and horizontally clamps into `[margin, innerWidth - abW - margin]`.

**First-run hint toast** 356–367: `data-dsh-we`-less div, `bottom: 64px; left: 50%; z-index: 2147483643`,
text `'🔍 页面元素选择已开启 · 点击元素后点「添加到对话」 · 按 ` 暂停'`, fades at 2.6 s, removed at 3.0 s,
guarded by `sessionStorage['__dsh_we_hint__']`.

**Exit** — `exitMode()` 379–385: `sendData({ action: 'exit-mode', pageUrl: location.href, pageTitle: document.title })`
then `cleanupAll()`. `Escape` and the 「添加到对话」 button both call it.

**Cleanup** — `cleanupAll()` 390–407: removes all seven possible listeners, removes `ov`, `lb`, `ab`, `chip` from the
DOM, resets `documentElement.style.cursor`, `delete`s `__dsh_we_active__`, `__dsh_we_cleanup__`, `__dsh_we_test_state__`.

### 1.2 The exact picked-element object (`collectData`, lines 146–162)

```js
146:   function collectData(el) {
147:     var rect = el.getBoundingClientRect()
148:     return {
149:       tagName: el.tagName.toLowerCase(),
150:       id: el.id || '',
151:       className: typeof el.className === 'string' ? el.className : '',
152:       textContent: dedupe(el.innerText || el.textContent || ''),
153:       cssSelector: cSel(el),
154:       domPath: domPath(el),
155:       attributes: collectAttrs(el),
156:       boundingRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
157:       outerHTML: el.outerHTML.length > 800 ? el.outerHTML.slice(0, 800) + '...' : el.outerHTML,
158:       pageUrl: location.href,
159:       pageTitle: document.title,
160:       time: new Date().toISOString()
161:     }
162:   }
```

Complete field list (there is **no** `label` and **no** `selector` field — see §2.4 for where the label comes from):

| field | type | meaning / caveat |
|---|---|---|
| `tagName` | string | lowercase tag (`'div'`, `'input'`) |
| `id` | string | `el.id`, else `''` |
| `className` | string | raw `className` if it is a string, else `''` (SVG elements → `''`) |
| `textContent` | string | `innerText` preferred, else `textContent`, then `dedupe()` → whitespace-collapsed, half-duplication removed, capped at **500** chars (135–143) |
| `cssSelector` | string | output of `cSel()` (see §1.3) |
| `domPath` | string | output of `domPath()` (see §1.3) |
| `attributes` | object | `collectAttrs()` (see below) |
| `boundingRect` | object | `{ left, top, width, height }` from `getBoundingClientRect()` — **viewport coordinates, no `right`/`bottom`, no `x`/`y`, taken at pick time** |
| `outerHTML` | string | full `outerHTML`, truncated to **800** chars + `'...'` |
| `pageUrl` | string | `location.href` |
| `pageTitle` | string | `document.title` |
| `time` | string | `new Date().toISOString()` |

**`collectAttrs`** (114–129): fixed whitelist `['role','name','type','href','placeholder','value','aria-label','title','alt','src']`,
only attributes that are `!= null && !== ''`; then up to **3** `data-*` attributes not already present
(`for (var j = 0; j < el.attributes.length && dataKeys.length < 3; j++)`).

**`dedupe`** (135–143): collapse `\s+`→`' '`, trim; then for `half = floor(n/2) … 2`, if
`t.slice(0,half) === t.slice(half, 2*half)` return `t.slice(0,half)` (site-typical doubled SEO text);
otherwise `t.slice(0,500)`.

**Extra field added only on send** — the 「添加到对话」 handler (333–342) shallow-copies the payload and adds
`action: 'add-to-chat'`:

```js
336:     var data = {}
337:     for (var k in selData) data[k] = selData[k]
338:     data.action = 'add-to-chat'
340:     sendData(data)
341:     exitMode()
```

### 1.3 Selector and DOM-path algorithms

**`cSel(el)` — CSS selector, lines 70–89** (doc comment 65–69 says "up to 5 levels, stop at an ancestor with id"):

```js
70:   function cSel(el) {
71:     if (el.id) return '#' + CSS.escape(el.id)
72:     var ps = [], nd = el
73:     while (nd && nd !== document.body && ps.length < 5) {
74:       var sg = nd.tagName.toLowerCase()
75:       if (nd.id) { ps.unshift('#' + CSS.escape(nd.id)); break }
76:       if (typeof nd.className === 'string' && nd.className.trim()) {
77:         var cls = nd.className.trim().split(/\s+/).filter(function (c) { return c.charAt(0) !== '_' }).slice(0, 2)
78:         if (cls.length) sg += '.' + cls.map(function (c) { return CSS.escape(c) }).join('.')
79:       }
80:       var pa = nd.parentElement
81:       if (pa) {
82:         var sibs = Array.prototype.filter.call(pa.children, function (c) { return c.tagName === nd.tagName })
83:         if (sibs.length > 1) sg += ':nth-child(' + (sibs.indexOf(nd) + 1) + ')'
84:       }
85:       ps.unshift(sg)
86:       nd = nd.parentElement
87:     }
88:     return ps.join(' > ')
89:   }
```

Algorithm restated:
1. Own `id` → `#escaped` immediately (short-circuit).
2. Otherwise climb up to **5** ancestors, stopping *before* `document.body` (`body` is never emitted).
3. Per level: `tagname`, plus the first **2** classes whose name does not start with `_`, each `CSS.escape`d, joined `.`.
4. If an ancestor has an `id` (at any level) → prepend `#escaped(id)` and **break** (convergence).
5. If the node has **>1 sibling with the same tagName**, append `:nth-child(k+1)`, where `k = index among same-tag siblings`.
6. Levels joined with `' > '`.

Caveats worth knowing for a reuse: (a) `nth-child` index is computed among **same-tag** siblings, so it can be off in
mixed-tag sibling groups (correct CSS would need the full `children` index); (b) no uniqueness verification;
(c) `document.body` itself is excluded from the path, so a `body`-level element yields only its own segment.

**`domPath(el)` — human-readable path, lines 95–108**:

```js
95:   function domPath(el) {
96:     var parts = [], node = el, depth = 0
97:     while (node && node.nodeType === 1 && depth < 8) {
98:       var seg = node.tagName.toLowerCase()
99:       if (typeof node.className === 'string') {
100:        var cls = node.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join(' ')
101:        if (cls) seg += ' ' + cls
102:      }
103:      parts.unshift(seg)
104:      node = node.parentElement
105:      depth++
106:    }
107:    return parts.join(' > ')
108:  }
```
Up to **8** levels, `tag` + first **3** class names space-joined, levels joined by `' > '`. Includes `body`/`html`.
Not a valid selector — purely for model comprehension.

### 1.4 Overlay / highlight drawing — element ids, styles, z-index, shadow DOM

**No shadow DOM, no iframe, no injected `<style>`.** Four plain `div`s are appended directly to
`document.documentElement` (58–61) and styled **inline** via `setStyle` (20):

```js
58:   document.documentElement.appendChild(ov)
59:   document.documentElement.appendChild(lb)
60:   document.documentElement.appendChild(ab)
61:   document.documentElement.appendChild(chip)
```

| element | identifying attr | line | key inline styles |
|---|---|---|---|
| hover/lock box `ov` | `data-dsh-we="ov"` | 23–25 | `position: fixed; pointer-events: none; z-index: 2147483640; border: 2px solid #3b82f6; background: rgba(59,130,246,0.08); border-radius: 3px; display: none` — on lock (202) border becomes `2px solid #f59e0b` |
| hover label `lb` | `data-dsh-we="lb"` | 28–30 | `position: fixed; pointer-events: none; z-index: 2147483640; background: #3b82f6; color: #fff; font: 11px monospace; padding: 2px 6px; border-radius: 3px` |
| action bar `ab` | `data-dsh-we="ab"` | 33–35 | `position: fixed; z-index: 2147483642; background: #1e1e1e; border-radius: 6px; box-shadow: 0 2px 8px rgba(0,0,0,0.5)` |
| add button | `data-dsh-we-add="1"` | 36–39 | label 「添加到对话」 |
| cancel button | (none) | 40–42 | label 「取消」 |
| pause chip `chip` | `data-dsh-we="chip"` | 47–49 | `position: fixed; bottom: 16px; right: 16px; z-index: 2147483642; border-radius: 16px` |
| hint toast | (none) | 361 | `z-index: 2147483643` |

z-index ladder: `ov`/`lb` `2147483640`, `ab`/`chip` `2147483642`, hint `2147483643` (≈ `2^31-8` … `-5`).
Self-exclusion is entirely attribute-based: `isOurEl(el) { return !!(el && el.closest && el.closest('[data-dsh-we]')) }` (170–172).
Note the hint toast has *no* `data-dsh-we` attribute but is `pointer-events: none`.
`lockOverlay` (200–204) freezes `ov` on the selected rect with the orange border and hides `lb`;
`returnToHover` (207–214) hides `ab`/`ov`/`lb` and clears `selEl`/`selData`.

### 1.5 How results get out — the one and only channel

```js
164:   /** 经 console 桥回传数据（协议：`__DSH_WE__:` 前缀 + JSON，勿改前缀）。 */
165:   function sendData(data) {
166:     console.log('__DSH_WE__:' + JSON.stringify(data))
167:   }
```

**There is no `window.postMessage`, no callback, no exposed global for results** (the only globals are the
cleanup/test hooks). The channel is `console.log` with a fixed prefix; the helper taps it through Playwright's
`page.on('console')`. Message shapes (exactly two):

| direction | payload |
|---|---|
| pick committed | `{ tagName, id, className, textContent, cssSelector, domPath, attributes, boundingRect, outerHTML, pageUrl, pageTitle, time, action: "add-to-chat" }` |
| mode exited (`Esc` / after add) | `{ action: "exit-mode", pageUrl, pageTitle }` |

Helper side (`resources/helper-playwright.js`, `onConsole`, lines ~118–140):

```js
126:   if (text.indexOf('__DSH_WE__:') !== 0) return
128:     const data = JSON.parse(text.slice('__DSH_WE__:'.length))
129:     if (data && data.action === 'add-to-chat') {
132:       postEvent({ type: 'element-selected', data: data })
133:     } else if (data && data.action === 'exit-mode') {
135:       postEvent({ type: 'mode-exited', url: data.pageUrl, title: data.pageTitle })
```
Both branches also set `autoInject = false` (no re-injection after the user got a result or deliberately exited).
`postEvent(ev)` = `fetch(base + '/dsh-webpage-element-picker/events', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ event: ev }) })`, fire-and-forget.

---

## 2. CLIENT HALF — `lib/client.js` (540 lines)

### 2.1 Module wrapper format DSH's client loader expects

Build-free, hand-writable, **synchronous CJS-in-a-factory**. There is no ESM, no `import`, and no top-level await.
`id` must be the plugin/package id (`"dsh-webpage-element-picker"`), because `ctx.slots.register({ id: PLUGIN_ID })`
and the `/plugins/<id>/client.js` serving path are keyed by it.

**First ~40 lines, verbatim (`lib/client.js` L1–43, i.e. the loader prologue, the `require`-based import head and the log helpers):**

```js
window.__ModuleLoader__.load({
  id: "dsh-webpage-element-picker",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

"use strict";

// src/client/react.ts
var React = require("react");
var h = React.createElement;

// src/client/primitives.ts
var PRIMITIVES_MODULE = "@deepseek-ai/dsh-client-ui-primitives";
function loadPrimitives() {
  try {
    const mod = require(PRIMITIVES_MODULE);
    if (!mod || typeof mod.Modal !== "function" || typeof mod.Button !== "function") {
      return { module: null, error: "\u6A21\u5757\u8868\u5DF2\u5E94\u7B54\u4F46\u7F3A\u5C11 Modal/Button \u5BFC\u51FA" };
    }
    return { module: mod, error: "" };
  } catch (err) {
    const e = err;
    return { module: null, error: String(e && e.message || err || "\u672A\u77E5\u9519\u8BEF") };
  }
}
var PRIMITIVES = loadPrimitives();

// src/client/index.ts
var PLUGIN_ID = "dsh-webpage-element-picker";
var INVOKE_PATH = "/dsh-webpage-element-picker/invoke";
var LOG_PREFIX = "[dsh-webpage-element-picker]";
function logDebug(msg) {
  console.debug(LOG_PREFIX + " [DEBUG] " + msg);
}
function logInfo(msg) {
  console.info(LOG_PREFIX + " [INFO] " + msg);
}
function logError(msg, err) {
  const e = err;
  const detail = e && e.stack ? e.stack : String(e && e.message || err || "");
  console.error(LOG_PREFIX + " [ERROR] " + msg + (detail ? "\n" + detail : ""));
}
```

**Last 20 lines, verbatim (`lib/client.js` L521–540, the tail of the factory and the close of the loader call):**

```js
  }, "dsh-webpage-element-picker: slot registration");
  logInfo(
    PRIMITIVES.module ? "client \u63D2\u4EF6\u5DF2\u52A0\u8F7D\uFF08\u69FD\u4F4D conversation.input.left\uFF0CUI \u4F7F\u7528 DSH \u539F\u8BED Modal/Button\uFF09" : "client \u63D2\u4EF6\u5DF2\u52A0\u8F7D\uFF08\u69FD\u4F4D conversation.input.left\uFF0CUI \u539F\u8BED\u4E0D\u53EF\u7528\uFF0C\u5DF2\u964D\u7EA7\u4E3A\u5185\u7F6E\u6837\u5F0F\uFF1A" + PRIMITIVES.error + "\uFF09"
  );
}
module.exports = {
  name: PLUGIN_ID,
  inject: ["slots"],
  apply
};

    return module.exports;
  },
});

```

Takeaways for a hand-written bundle: the factory receives a `require` that resolves the harness browser module table
(`react`, `@deepseek-ai/dsh-client-ui-primitives`, …); it must assign `module.exports` and `return module.exports`;
the plugin object is a normal Cordis plugin `{ name, inject: ['slots'], apply(ctx) }`. Note that the file's *one*
deviation from plain hand-written JS is the single 6058-character minified `STYLE_CSS` string on line 88 (rendered
truncated in some viewers, but syntactically a normal string literal).

Options available for escaping the build step in a new plugin: hand-write exactly this wrapper (only `react` is
needed for a functional UI; the primitives module is optional because `renderButton`/`renderDialogShell` fall back
to plain `<button>`/`<div>` with `STYLE_CSS` when `require()` throws).

### 2.2 Slot / contribution point, registration call, props

**Slot:** `conversation.input.left` — a **list** slot, scope `session`. Declared by the official conversation plugin
(`@deepseek-ai/dsh-client-ui-conversation/lib/client.js` L16748–16751):

```js
"conversation.input.left": {
    kind: "list",
    scope: "session"
},
```
and rendered inside `InputBar` (`…/dsh-client-ui-conversation/lib/client.js` L16190):

```js
input === void 0 || sessionId === void 0 ? null : renderSlot("conversation.input.left", {})
```

**Registration call** (`lib/client.js` L502–535):

```js
502: function apply(ctx) {
503:   ctx.effect(function() {                       // <style data-plugin="dsh-webpage-element-picker">
...
515:   ctx.effect(function() {
516:     return ctx.slots.inject("conversation.input.left", function() {
517:       return ctx.slots.register(
518:         {
519:           name: "conversation.input.left",
520:           id: PLUGIN_ID,
521:           order: 0
522:         },
523:         PickerEntry
524:       );
525:     });
526:   }, "dsh-webpage-element-picker: slot registration");
...
531: module.exports = {
532:   name: PLUGIN_ID,
533:   inject: ["slots"],
534:   apply
535: };
```

So: `ctx.slots.inject(slotName, () => ctx.slots.register({ name, id, order }, Component))`, wrapped in `ctx.effect`
for disposal, plus `inject: ["slots"]`. The component receives no children and no config from the slot declaration —
props come from the **session-scoped provide** in the conversation plugin (L16599–16618):

```js
ctx.uiSession.provide({
    hooks: ["conversation", "input"],
    props: ["inputActions"],
    resolve: (binding) => { … return { hooks: { conversation: …, input: shell.state }, props: { inputActions: shell.actions } } }
});
```

| prop | shape / use in `PickerEntry` | notes |
|---|---|---|
| `props.useInput` | selector hook: `props.useInput(s => s)` → input state object; only `draft` is read (`const input = props.useInput ? props.useInput(s => s) : { draft: "" }`, L153–155, `st.draft = input.draft` L159) | **optional** — the component must tolerate `undefined` |
| `props.inputActions` | `{ setDraft(text: string), … }` — only `setDraft` is called (L206–208, 228–230) | **optional** — insertion is skipped when absent |

The button itself is a plain `<button type="button" className="dsh-we-iconBtn" title={…} aria-label="添加页面元素"
aria-haspopup="dialog" aria-expanded={…}>` containing a 14×14 inline SVG crosshair (L132–150, 480–500); the dialog is
the DSH `Modal`/`Button` primitive pair when available, else the local fallback shell (L60–85) styled by `STYLE_CSS`.

### 2.3 Talking to the host: `/invoke` and the HTTP surface

There is **no DSH-provided fetch/HTTP helper** in the client API. The plugin uses the page's global `fetch` against
its own origin (`lib/client.js` L31, L90–106):

```js
31: var INVOKE_PATH = "/dsh-webpage-element-picker/invoke";
...
90: function hostCall(method, params) {
91:   const base = typeof window !== "undefined" && window.location && window.location.origin ? window.location.origin : "";
92:   const startedAt = Date.now();
93:   logDebug("host 调用: " + method + " 参数: " + JSON.stringify(params || {}));
94:   return fetch(base + INVOKE_PATH, {
95:     method: "POST",
96:     headers: { "Content-Type": "application/json" },
97:     body: JSON.stringify({ method, params: params || {} })
98:   }).then((res) => {
99:     if (!res.ok) throw new Error("HTTP " + res.status);
100:    return res.json();
101:  }).then((value) => {
102:    const cost = Date.now() - startedAt;
103:    if (cost > 500) logInfo("host 调用 " + method + " 耗时 " + cost + "ms");
104:    return value;
105:  });
106: }
```

Methods invoked by the client: `picker-pull` (L216, 283, 305), `picker-navigate` (L334), `picker-reinject` (L351),
`picker-context-list` (L216), `picker-clear-context` (L253). Errors are surfaced as a thrown `Error("HTTP <status>")`
or a rejected fetch; every caller maps both to a user-visible notice (`showNotice(text, 'error')`) or a `logDebug`.

Polling model (L266–318): on mount a single `picker-pull({afterSeq: 0})` establishes the baseline — the **first**
response only records `res.lastSeq` into `st.afterSeq` and inserts nothing, so previously picked elements are never
replayed. While the dialog is open **or** `status.state === 'open'`, a `setInterval(poll, 1500)` calls
`picker-pull({afterSeq})`; fresh items (`seq > afterSeq`) are inserted and `afterSeq` advances.

### 2.4 Inserting the `[label][DOMn]` placeholder into the input box

No DOM manipulation, no editor API — the plugin **rebuilds the draft string and writes it back through
`props.inputActions.setDraft()`** (`lib/client.js` L197–214):

```js
197:   const insertElements = function(elements) {
198:     const fresh = elements.filter(function(e) {
199:       return e.seq > st.afterSeq;
200:     });
201:     if (!fresh.length) return;
202:     let draft = st.draft;
203:     for (const item of fresh) {
204:       draft += (draft ? "\n" : "") + placeholderLine(item);
205:     }
206:     if (props.inputActions && typeof props.inputActions.setDraft === "function") {
207:       props.inputActions.setDraft(draft);
208:     }
209:     st.draft = draft;
210:     st.afterSeq = fresh[fresh.length - 1].seq;
211:     logDebug("已插入 " + fresh.length + " 个占位符: " + fresh.map(function(e) {
212:       return e.domId;
213:     }).join(", "));
214:   };
```

The same pattern is used for history-menu re-insertion (L224–236), which additionally calls
`showNotice("已插入 " + item.domId + " 到输入框")`.

Placeholder format (`placeholderLine`, L125–131 + `labelOf`, L112–124):

```js
125: function placeholderLine(item) {
126:   const p = item.payload || {};
127:   const id = item.domId || "DOM";
128:   const label = labelOf(p);
129:   if (!label || label === "?") return "[" + id + "]";
130:   return "[" + label + "][" + id + "]";
131: }
```
`labelOf` precedence: `textContent` → `aria-label` → `placeholder` → `alt` → `title` → `value` → `tag#id` →
`tag.cls1.cls2` → `tag`; all values pass through `shortText` (L107–111: collapse whitespace, truncate to **10** chars
+ `'…'`). Items are appended one per line, separated by `\n`, using the input's current draft as the prefix.
`props.inputActions.setDraft` resolves to the conversation `InputHub` shell's `setDraft(text)`
(`@deepseek-ai/dsh-client-ui-conversation/lib/client.js` L12628 → L12758) — the same API DSH's own
draft-mirror uses.

Cleanup: `ctx.effect` removes the injected `<style data-plugin="dsh-webpage-element-picker">` (L503–514) and the slot
registration on dispose; the pending `setInterval`/`setTimeout` handles are cleared in `useEffect` returns (L289–300,
L314–317).

---

## 3. HOST HALF — `lib/index.js` (659 lines)

`inject = ["subprocess","webServer","sandboxPolicy","fs","tools","systemPrompt","timer"]` (L5). All services are read
once via `ctx.get(...)` (L23–29); `workspaceRoot = ctx.get("sandboxPolicy").workspaceRoot` (L29).

### 3.1 HTTP routes

All three are registered with `webServer.register({ kind: "exact", path, handler })` inside one `ctx.effect`
(L290–412; log line 400: `HTTP 路由已注册: /poll /events /invoke`). There is **no method check anywhere** — the host
reads the body on POST and ignores the verb, so `GET` also reaches the handler (for `/poll` the body is never read).

| # | path | lines | direction | request body | response |
|---|---|---|---|---|---|
| 1 | `/dsh-webpage-element-picker/poll` | 293–324 | helper ⇄ host (long poll) | none (ignored) | `200 application/json` — either a command JSON `{ id, method, params }` or the literal `null` (after a 25 s `timer.timeout`, or when the request closes). If `commandQueue` is non-empty it answers immediately. |
| 2 | `/dsh-webpage-element-picker/events` | 325–353 | helper → host (fire-and-forget) | `{ "event": { "type": …, … } }`, body capped at 1 MB (over → dropped with a WARN) | always `200 application/json` `{}` |
| 3 | `/dsh-webpage-element-picker/invoke` | 354–399 | client UI → host (RPC) | `{ "method": string, "params": object }` (both defensively validated, 1 MB cap) | unknown method → **404** `{ ok:false, error:"未知方法: <m>" }`; handler success → **200** handler result; handler throw → **200** `{ ok:false, error:"<message>" }` |

Event types consumed by `handleEvent` (L229–288), i.e. the inner `event` object shape:

| `event.type` | other fields | effect on host state |
|---|---|---|
| `reply` | `id`, `ok`, `error?`, `status?` | resolves/rejects the waiter for command `id`; only `ev.ok ? resolve(ev) : reject(Error(ev.error \|\| '内置浏览器返回错误'))` — the **whole reply object** is what `request()` resolves to, so callers read `r.ok` / `r.status` (L231–240) |
| `element-selected` | `data` (the full inspector payload + `action`) | `domCounter++`; `domId = "DOM" + domCounter`; pushes `{id, payload}` onto `domRegistry` (capped 200, L245) and `{seq: ++lastSeq, domId, payload}` onto `pending` (capped 100, L247) (L241–251) |
| `browser` | `name` | `lastBrowserName = name`; `status = {state:'starting', message:'正在启动 <name>…', browser}` (L252–257) |
| `status` | `url`, `title` | `status = {state:'open', url, title, browser:lastBrowserName}` (L258–262) |
| `injected` | `url`, `title` | `status = {state:'open', url, title, injected:true, browser}` (L263–267) |
| `mode-exited` | `url`, `title` | `status = {state:'open', url, title, modeExited:true, browser}` (L268–272) |
| `window-closed` | — | `status = {state:'closed', message:'浏览器窗口已关闭，可重新点击打开按钮打开'}` (L273–277) |
| `helper-ready` | — | `status = {state:'ready', message:'浏览器已就绪…', browser}` (L278–282) |
| `error` | `message` | `status = {state:'error', message}` (L283–287) |

### 3.2 `/invoke` method handlers — exact request/response shapes

Registered in a `Map` at L636–642; implementations L569–635. All are `async (params) => result`.

| method | request params | success response | failure response |
|---|---|---|---|
| `picker-navigate` | `{ url: string }` (must match `/^https?:\/\//i`, else rejected **before** touching the helper, L571–574) | `{ ok:true, status:{ state:'open', url, title?, … } }` — built from the helper reply's `status` or `{url}` (L577–578); helper call timeout **120 000 ms** | `{ ok:false, error:"网址需以 http:// 或 https:// 开头" }` / `{ ok:false, error:<msg> }` |
| `picker-reinject` | `{}` | `{ ok:true, status:{state:'open', …} }` (L587–588), helper timeout **15 000 ms** | `{ ok:false, error:<msg> }` |
| `picker-status` | `{}` | `{ ok:true, status }`; if no helper process → local cached `status`; helper timeout **8 000 ms**, any error falls back to the cached status (L594–603) | never fails |
| `picker-close` | `{}` | `{ ok:true, status:{ state:'closed', message:'浏览器窗口已关闭' } }`; helper `close` timeout **5 000 ms**, errors ignored (L604–614) | never fails |
| `picker-pull` | `{ afterSeq: number }` (defaults 0) | `{ ok:true, elements:[ { seq, domId, payload } ], status, lastSeq, contextCount }` — only entries with `seq > afterSeq`; **no helper round-trip** (L615–620) | never fails |
| `picker-context-list` | `{}` | `{ ok:true, items:[ { domId, label, pageUrl? } ], contextCount }` — `label` via `registryLabel` (157–173: `textContent` → aria-label/placeholder/alt/title/value, each ≤10 chars + `…` → `tag#id` → `tag.cls1.cls2` → tag); `pageUrl` omitted when empty (L621–628) | never fails |
| `picker-clear-context` | `{}` | `{ ok:true, contextCount: 0 }`; clears `domRegistry` + `pending` but **keeps `domCounter`** so numbering never reuses an id (L629–635) | never fails |

Host → helper commands (the `/poll` payloads) are `{ id, method, params }` with `method ∈ {open, reinject, status, close}`
(plus `quit`, handled helper-side only). Timeouts: `request(method, params, timeoutMs)` L550–568, default 60 000 ms,
`id = ++cmdSeq`. Commands are handed to a parked long-poll immediately when one is waiting, else queued
(`sendCommand` L146–156, queue capped at 100 by dropping the oldest).

Helper lifecycle (for context, not protocol): `ensureHelper()` L496–549 spawns
`subprocess.spawn({ argv: [node, <resourceDir>/bootstrap.cjs, <npmCliPath>, String(webServer.port)], cwd: workspaceRoot, stdio:{stdin:'pipe', stdout:'pipe', stderr:{maxBytes:65536}}, graceMs:3000 })`;
on the stdout line `READY` it writes the concatenated payload
`helper + "\n<<<DSH_SPLIT>>>\n" + inspector + "\n<<<DSH_END>>>\n"` to the child's stdin (L423–431, L507).
Resource dir resolution tries, in order: the package's `../resources/`, `~/.dsh/_dsh-webpage-element-picker`,
`~/.dph/_dsh-webpage-element-picker`, `<workspaceRoot>/_dsh-webpage-element-picker`, requiring all four files
`bootstrap.cjs, helper-playwright.js, inspector.js, browser-probe.cjs` (L95–133).

### 3.3 `read_picked_element` tool registration

L198–228 (inside `try/catch`, so a registration failure only logs):

```js
199:     ctx.effect(() => tools.register({
200:       name: "read_picked_element",
201:       description: "读取「添加页面元素」功能从内置浏览器中选中的页面元素完整信息（HTML、CSS 选择器、DOM 路径、属性、位置尺寸、页面 URL 等）。系统提示中的页面元素列表给出了可用的 DOM 编号，用户消息中的 [DOMn] 占位符与之对应；需要元素细节时按编号读取。",
202:       parameters: {
203:         type: "object",
204:         properties: {
205:           id: { type: "string", description: "DOM 编号，如 DOM1（见系统提示中的页面元素列表）" }
206:         },
207:         required: ["id"]
208:       },
209:       output: {
210:         schema: {},
211:         render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
212:       },
213:       async execute(args) {
214:         const id = String(args && args.id || "");
216:         if (!id) throw new Error("read_picked_element 需要参数 id（如 DOM1）");
217:         const entry = domRegistry.find((e) => e.id === id);
218:         if (!entry) {
220:           return { ok: false, error: "未找到元素 " + id + "，可用编号: " + domRegistry.map((e) => e.id).join(", ") };
221:         }
222:         return { ok: true, id: entry.id, element: entry.payload };
223:       }
224:     }));
```

Exact result shapes: `{ ok:true, id:"DOM1", element:{ …the §1.2 payload… } }` or
`{ ok:false, error:"未找到元素 DOM9，可用编号: DOM1, DOM2" }`. The tool never throws for a missing id (only for an
empty `id`). Output rendering is a single JSON text block (`JSON.stringify(value, null, 2)`).

### 3.4 System-prompt line

Registered at L189–197:

```js
190:     ctx.effect(() => systemPrompt.context({
191:       name: "webpage-element-picker",
192:       order: 60,
193:       text: () => buildSummary()
194:     }));
```

`buildSummary()` (L174–188) returns `''` when `domRegistry` is empty (so nothing is injected until the first pick);
otherwise it emits exactly:

```
页面元素列表（用户消息中的 [DOMn] 占位符与下列编号一一对应）：
DOM1=input#title “商品标题” (http://localhost:3000/admin/articles/10/edit)
DOM2=div “商品标签” (http://localhost:3000/admin?section=shop-products)
需要某个元素的完整信息（HTML/CSS选择器/属性/位置尺寸）时，调用 read_picked_element 工具，参数如 {"id":"DOM1"}。
```

Per-entry line format: `e.id + "=" + parts.join(" ")` where `parts = [tagName]` then `"#" + id` if present then
`"“" + textContent.slice(0,40) + "”"` if present, followed by `" (" + (pageUrl || "") + ")"`. The trailing
instruction line is the string literal at L184–185. Note this is a *dynamic* text callback: it is rebuilt on every
turn from the live registry, and the registry is per-plugin-instance (in-memory), capped at 200 entries.

---

## 4. Declaration: `cordis.patch.yml` and the profile's `package.json`

### 4.1 `$PKG/cordis.patch.yml` (verbatim, whole file)

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

One `insert` entry whose row `id` is the short `webpage-element-picker` and whose `name` is the exact package name
`dsh-webpage-element-picker` (the name is the key the Loader uses for host resolution and the client-modules scanner
uses for the package.json lookup; the client bundle is then served at `/plugins/<id>/client.js`).
`package.json` points at it via `dsh.bundle.patch = "./cordis.patch.yml"`; a plugin bundle may ship its own patch file,
which the profile composes after the built-in bundle layers.

### 4.2 Profile `package.json` (`harness/profiles/web/package.json`)

Relevant parts verbatim:

```json
  "dependencies": {
    "dsh-webpage-element-picker": "github:zlei1989/dsh-webpage-element-picker#main",
    "dshmarket": "^1.55.0",
    "dsh-better-sidebar": "0.19.1",
    "@laoyuehanni/dsh-token-usage": "0.4.3",
    "@mars-sea/dsh-commandcode-provider": "0.11.8"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-webpage-element-picker",
        "dshmarket",
        "@laoyuehanni/dsh-token-usage",
        "@mars-sea/dsh-commandcode-provider",
        "dsh-better-sidebar"
      ],
      "patchReload": "live"
    },
    …
  }
```

So a bundle plugin is declared in **two** places: it is a normal dependency of the profile, **and** its package name is
listed in `dsh.profile.bundles` (the ordered layer stack; `dsh plugin --profile web add` appends it automatically once
it sees `dsh.bundle`). `patchReload: "live"` makes profile-level patch edits apply without a full restart.
The profile's own top-level patch layer, `harness/profiles/web/cordis.patch.yml`, does **not** contain a picker entry —
it currently holds only the comment header plus:

```yaml
- id: web-ui-better-sidebar
  disabled: false
```

(The `insert` row for the picker comes from the plugin's own `cordis.patch.yml`, pulled in through
`dsh.bundle.patch`; the same mechanism a new plugin would use.)

---

## 5. Reuse cheat-sheet (what a new plugin must copy vs. may change)

**Contract that must match for protocol compatibility**

* Inspector ↔ helper: `console.log('__DSH_WE__:' + JSON.stringify(payload))` with `action: 'add-to-chat'` /
  `'exit-mode'`; helper posts `{event:{type:'element-selected',data}}` / `{type:'mode-exited',url,title}`.
* Helper ↔ host: long-poll `GET …/poll` → `{id,method,params}` | `null`; commands `open|reinject|status|close`;
  replies posted as `{event:{type:'reply',id,ok,status?|error?}}`; host waits with per-method timeouts.
* Client ↔ host: `POST …/invoke` `{method,params}` → `{ok:…, …}` (unknown method = 404).
* Slot: `conversation.input.left`, list/session scope; insert via `props.inputActions.setDraft(nextDraft)`; placeholders
  `[label][DOMn]` on their own `\n`-separated lines.
* Tool name `read_picked_element` + `{id}` parameter, returning `{ok,id,element}`.

**Freely changeable / worth improving**

* The `__DSH_WE__` prefix and the exact inspector payload field names (`cssSelector`, `boundingRect` without
  `right/bottom`, 800-char `outerHTML`, 500-char text) — as long as helper-side parsing matches.
* Inspector overlay: no shadow DOM is used, so page CSS can interfere; a new implementation could use a shadow root
  host with very high z-index. The `:nth-child` computation among same-tag siblings is a known correctness bug worth
  fixing (`Array.prototype.indexOf.call(pa.children, nd) + 1` would be correct).
* The client's 1500 ms polling + `afterSeq` baseline and the `conversation.input.left` slot could be replaced by an
  SSE/WebSocket channel or a different slot, provided the host keeps `picker-pull` semantics (baseline-on-first-call).
* The host's `webServer.register` `kind:"exact"` paths are plugin-namespaced (`/dsh-webpage-element-picker/...`), so a
  new plugin should pick its own prefix to avoid route collisions (the README already notes collisions between two
  profile instances of this plugin).
