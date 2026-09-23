/**
 * The sidebar browser shell.
 *
 * This document is served by the per-tab proxy, so it shares an origin with the
 * page it displays. That is the whole point: the shell can read
 * `frame.contentDocument`, attach capture-phase listeners to the inspected
 * page, and snapshot a clicked element — none of which is possible across
 * origins. The shell never writes into the inspected document: the highlight
 * is drawn here, over the frame, from `getBoundingClientRect()`.
 *
 * It talks to three parties:
 *   - the proxy routes it was served from (`/__dsh_picker__/*`) for metadata and
 *     the picked-element sink;
 *   - the DSH panel that embedded it, via `postMessage`, for everything it does
 *     not own: which pages exist (tabs), navigating to another origin, and the
 *     reported URL / title / view state;
 *   - the inspected page, directly, as an ancestor-origin sibling.
 *
 * Zoom and device preview are layout, not CSS `zoom`: the frame is laid out at
 * `width / scale` CSS pixels and scaled back up, so the page receives the width
 * a real device (or a zoomed browser window) would give it and its media queries
 * fire on that width. See `.viewport` in chrome.css.
 */
;(function () {
  'use strict'

  var ASSET = '/__dsh_picker__/'
  var PARENT_SOURCE = 'dsh-sidebar-element-picker'
  var SHELL_SOURCE = 'dsh-sidebar-element-picker-shell'

  /** Device presets. `width === 0` means "fill the pane" (no device frame). */
  var DEVICES = [
    { key: 'responsive', label: '响应式', width: 0, height: 0, kind: 'desktop' },
    { key: 'phone-360', label: 'Galaxy S23', width: 360, height: 780, kind: 'phone' },
    { key: 'phone-375', label: 'iPhone SE', width: 375, height: 667, kind: 'phone' },
    { key: 'phone-393', label: 'iPhone 15 Pro', width: 393, height: 852, kind: 'phone' },
    { key: 'phone-412', label: 'Pixel 8', width: 412, height: 915, kind: 'phone' },
    { key: 'phone-430', label: 'iPhone 15 Pro Max', width: 430, height: 932, kind: 'phone' },
    { key: 'tablet-744', label: 'iPad mini', width: 744, height: 1133, kind: 'tablet' },
    { key: 'tablet-820', label: 'iPad Air', width: 820, height: 1180, kind: 'tablet' },
    { key: 'tablet-834', label: 'iPad Pro 11"', width: 834, height: 1194, kind: 'tablet' },
  ]

  /** Zoom stops offered by the toolbar's select. */
  var ZOOMS = [0.25, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 2, 3]

  var frame = document.getElementById('site')
  var urlInput = document.getElementById('url')
  var goForm = document.getElementById('go')
  var pickBtn = document.getElementById('pick')
  var openBtn = document.getElementById('open')
  var saveLoginBtn = document.getElementById('saveLogin')
  var backBtn = document.getElementById('back')
  var forwardBtn = document.getElementById('forward')
  var reloadBtn = document.getElementById('reload')
  var zoomInBtn = document.getElementById('zoomIn')
  var zoomOutBtn = document.getElementById('zoomOut')
  var zoomSelect = document.getElementById('zoom')
  var fitBtn = document.getElementById('fitWidth')
  var deviceSelect = document.getElementById('device')
  var rotateBtn = document.getElementById('rotate')
  var sizeLabel = document.getElementById('size')
  var canvas = document.getElementById('canvas')
  var sizer = document.getElementById('sizer')
  var viewport = document.getElementById('viewport')
  var overlay = document.getElementById('overlay')
  var boxEl = document.getElementById('box')
  var tagEl = document.getElementById('tag')
  var toastEl = document.getElementById('toast')
  var hintEl = document.getElementById('hint')
  var targetEl = document.getElementById('target')
  var blankEl = document.getElementById('blank')

  /** The target origin this port stands for, learnt from the proxy. */
  var targetOrigin = ''
  /** The inspected page's document/window, while it is same-origin. */
  var page = { doc: null, win: null }
  var armed = false
  var hovered = null
  var toastTimer = 0
  /** `{zoom, deviceKey, landscape}` — the shell's share of the tab's state. */
  var view = { zoom: 1, deviceKey: 'responsive', landscape: false }
  /** Saved logins for this origin, pushed in by the panel. */
  var credentials = []
  /** Whether this page already asked the panel for its saved logins. */
  var askedForCredentials = false

  var params = new URLSearchParams(location.search)
  var initialPath = params.get('p') || ''

  /**
   * Report shell state to the embedding DSH panel. Cross-origin by
   * construction, so the channel is wide open on purpose: nothing here is a
   * secret, and the panel only listens.
   * @param {object} message - fields to merge into the envelope.
   */
  function post(message) {
    message.source = SHELL_SOURCE
    message.__dshPicker = true
    try {
      if (window.parent !== window) window.parent.postMessage(message, '*')
    } catch (error) {
      /* the panel is gone */
    }
  }

  /**
   * @param {string} text - transient status line.
   * @param {boolean} [warn] - whether to draw attention to it.
   */
  function toast(text, warn) {
    toastEl.textContent = text
    toastEl.hidden = false
    hintEl.textContent = text
    hintEl.classList.toggle('warn', warn === true)
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(function () {
      toastEl.hidden = true
    }, 2600)
  }

  /** @returns {string} the inspected page's URL as the user thinks of it. */
  function displayUrl() {
    if (page.win === null) return ''
    var win = page.win
    try {
      return targetOrigin + win.location.pathname + win.location.search + win.location.hash
    } catch (error) {
      return frame.src
    }
  }

  /** Mirror the inspected page's URL and title into the bar and the panel. */
  function report() {
    var url = displayUrl()
    if (url !== '') {
      urlInput.value = url
      targetEl.textContent = url
      post({ ev: 'url', url: url, title: page.doc === null ? '' : page.doc.title || '' })
    }
  }

/**
 * Give bare address-bar text an `http://` scheme without mistaking `host:port`
 * for a scheme: `localhost:3000/admin` is a host and a port, not a URL in the
 * `localhost` scheme, and a real foreign scheme (`mailto:`, `file:`) must be
 * refused rather than silently rewritten into a host.
 * @param {string} text - what the user typed.
 * @returns {string} absolute http(s) text, or `''` when it cannot be one.
 */
function withScheme(text) {
  var match = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/.exec(text)
  if (match === null) return 'http://' + text
  if (/^https?$/i.test(match[1])) return text
  if (/^\d+(?:[/?#].*)?$/.test(match[2])) return 'http://' + text
  return ''
}

  /**
   * Turn whatever the user typed into an absolute http(s) URL.
   * @param {string} input - address-bar text or a link target.
   * @returns {string} an absolute URL, or an empty string when unusable.
   */
  function absolutize(input) {
    var text = String(input || '').trim()
    if (text === '') return ''
    text = withScheme(text)
    if (text === '') return ''
    try {
      var url = new URL(text)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
      return url.href
    } catch (error) {
      return ''
    }
  }

  /**
   * @param {string} url - an absolute URL.
   * @returns {string} its path, query and hash.
   */
  function pathOf(url) {
    var parsed = new URL(url)
    return parsed.pathname + parsed.search + parsed.hash
  }

  /**
   * Show a URL. A URL on the origin this port stands for is navigated in place;
   * anything else leaves the shell, because a different origin means a
   * different port — and the panel is the only party that can allocate one.
   * @param {string} input - address-bar text or a link target.
   */
  function open(input) {
    var url = absolutize(input)
    if (url === '') {
      toast('网址无法识别', true)
      return
    }
    var origin = new URL(url).origin
    if (targetOrigin !== '' && origin !== targetOrigin) {
      post({ ev: 'navigate', url: url })
      return
    }
    showPath(pathOf(url))
  }

  /**
   * Navigate the frame within this port's origin.
   * @param {string} path - path, query and hash.
   */
  function showPath(path) {
    blankEl.hidden = true
    hintEl.classList.remove('warn')
    hintEl.textContent = '正在打开…'
    frame.src = path === '' ? '/' : path
  }

  /** @type {{target: string, port: number}} */
  var meta = { target: '', port: 0 }

  /**
   * Attach the always-on listeners of a freshly loaded inspected document:
   * URL reporting, modal keys, popup capture, and turning off-site links back
   * into the picker instead of letting them escape to the real origin.
   */
  function bindPage() {
    var doc = null
    var win = null
    try {
      doc = frame.contentDocument
      win = frame.contentWindow
    } catch (error) {
      doc = null
      win = null
    }
    if (!doc || !win) {
      // A document the proxy does not own: an absolute link to a third-party
      // origin, or a browser-internal page.
      page = { doc: null, win: null }
      disarm(true)
      blankEl.hidden = true
      hintEl.textContent = '当前页面不在侧边栏浏览器的代理内（外链或浏览器内部页面），无法拾取'
      hintEl.classList.add('warn')
      return
    }
    page = { doc: doc, win: win }
    patchHistory(win)
    askedForCredentials = false
    doc.addEventListener('submit', onSubmitCapture, true)
    doc.addEventListener('keydown', onKeyDown, true)
    doc.addEventListener('click', onAnyClick, true)
    doc.addEventListener('auxclick', onAnyClick, true)
    win.addEventListener('scroll', onScroll, true)
    // The "nothing open yet" card is a sibling of the frame, so it has to be
    // taken down explicitly once a document is really in there.
    blankEl.hidden = true
    hintEl.classList.remove('warn')
    hintEl.textContent = '就绪'
    report()
    applyView()
    // Forms mount late in most frameworks, so try now and once more shortly.
    syncCredentials()
    setTimeout(syncCredentials, 400)
    if (armed) attachInterceptors()
  }

  /**
   * Make the inspected page's own history calls observable, so the address bar
   * follows a single-page app, and route its popups into picker tabs.
   * @param {Window} win - the inspected window.
   */
  function patchHistory(win) {
    if (win.__dshPickerPatched === true) return
    win.__dshPickerPatched = true
    for (var i = 0; i < 2; i += 1) {
      var name = i === 0 ? 'pushState' : 'replaceState'
      var original = win.history[name]
      win.history[name] = function () {
        var result = original.apply(this, arguments)
        report()
        return result
      }
    }
    win.addEventListener('popstate', report)
    win.addEventListener('hashchange', report)
    try {
      win.open = function (url) {
        var target = absolutize(String(url === undefined || url === null ? '' : url))
        if (target !== '') post({ ev: 'openTab', url: target })
        else toast('已拦截弹窗（未指定网址）', true)
        return null
      }
    } catch (error) {
      /* a page that froze window.open keeps its own behaviour */
    }
  }

  /**
   * Observe a login submit without getting in its way.
   * @param {Event} event - the form submit.
   */
  function onSubmitCapture(event) {
    var form = event.target
    if (!form || form.nodeType !== 1 || form.tagName !== 'FORM') return
    if (form.querySelector('input[type="password"]') === null) return
    offerToSave(event)
  }

  /**
   * Recompute the highlight for the element under the pointer.
   * @param {MouseEvent} event - a mousemove inside the inspected document.
   */
  function onMove(event) {
    if (!armed) return
    var el = event.target
    if (!el || el.nodeType !== 1) return
    if (el === hovered) return
    hovered = el
    drawBox(el, false)
  }

  /** Hide the highlight when the pointer leaves the inspected document. */
  function onLeave() {
    if (!armed) return
    hovered = null
    overlay.hidden = true
  }

  /** Keep the highlight aligned while the page scrolls. */
  function onScroll() {
    if (!armed) return
    if (hovered && hovered.isConnected) drawBox(hovered, false)
    else overlay.hidden = true
  }

  /**
   * Swallow every interaction that would reach the app while picking.
   * @param {Event} event - mousedown/mouseup/auxclick/contextmenu.
   */
  function swallow(event) {
    if (!armed) return
    event.preventDefault()
    event.stopPropagation()
  }

  /**
   * Pick the clicked element and hand it to the proxy. Picking disarms, so the
   * page is usable again the moment the user has what they wanted.
   * @param {MouseEvent} event - the click inside the inspected document.
   */
  function onClick(event) {
    if (!armed) return
    event.preventDefault()
    event.stopPropagation()
    var el = event.target
    if (!el || el.nodeType !== 1) return
    drawBox(el, true)
    var payload = describe(el)
    disarm(false)
    fetch(ASSET + 'pick', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res.json()
      })
      .then(function (data) {
        if (data && data.ok === true) {
          toast('已加入对话：' + data.label + ' [' + data.domId + ']')
          post({ ev: 'picked', domId: data.domId, label: data.label, element: payload })
        } else {
          toast('加入失败：' + ((data && data.error) || '未知错误'), true)
        }
      })
      .catch(function (error) {
        toast('加入失败：' + String((error && error.message) || error), true)
      })
  }

  /**
   * Follow links that leave this port's origin into a picker tab of their own,
   * and capture `target="_blank"` links, instead of letting the frame escape to
   * the real origin where nothing can be inspected.
   * @param {MouseEvent} event - any click inside the inspected document.
   */
  function onAnyClick(event) {
    if (armed) return
    var node = event.target
    while (node && node.nodeType === 1 && node.tagName !== 'A') node = node.parentElement
    if (!node || !node.href) return
    var url
    try {
      url = new URL(node.href, page.win.location.href)
    } catch (error) {
      return
    }
    if (node.target === '_blank' || event.button === 1) {
      event.preventDefault()
      event.stopPropagation()
      post({ ev: 'openTab', url: url.href })
      return
    }
    if (event.button !== 0) return
    if (url.origin === page.win.location.origin) return
    event.preventDefault()
    event.stopPropagation()
    post({ ev: 'openTab', url: url.href })
  }

  /**
   * Modal keys inside the inspected page.
   * @param {KeyboardEvent} event - a keydown inside the inspected document.
   */
  function onKeyDown(event) {
    if (event.key === '`' || event.code === 'Backquote') {
      event.preventDefault()
      event.stopPropagation()
      if (armed) disarm(true)
      else arm()
      return
    }
    if (event.key === 'Escape' && armed) {
      event.preventDefault()
      event.stopPropagation()
      disarm(true)
    }
  }

  /** Attach the picking interceptors to the inspected document. */
  function attachInterceptors() {
    var doc = page.doc
    if (!doc) return
    doc.addEventListener('mousemove', onMove, true)
    doc.addEventListener('mouseleave', onLeave, true)
    doc.addEventListener('click', onClick, true)
    doc.addEventListener('mousedown', swallow, true)
    doc.addEventListener('mouseup', swallow, true)
    doc.addEventListener('auxclick', swallow, true)
    doc.addEventListener('contextmenu', swallow, true)
  }

  /** Detach the picking interceptors. */
  function detachInterceptors() {
    var doc = page.doc
    if (!doc) return
    doc.removeEventListener('mousemove', onMove, true)
    doc.removeEventListener('mouseleave', onLeave, true)
    doc.removeEventListener('click', onClick, true)
    doc.removeEventListener('mousedown', swallow, true)
    doc.removeEventListener('mouseup', swallow, true)
    doc.removeEventListener('auxclick', swallow, true)
    doc.removeEventListener('contextmenu', swallow, true)
  }

  /** Enter picking mode. */
  function arm() {
    if (armed) return
    if (!page.doc) {
      toast('页面还没加载好，无法拾取', true)
      return
    }
    armed = true
    overlay.hidden = true
    pickBtn.classList.add('on')
    attachInterceptors()
    hintEl.classList.remove('warn')
    hintEl.textContent = '拾取中：点击页面上的元素即可加入对话（` 或 Esc 退出）'
    post({ ev: 'armed', armed: true })
  }

  /**
   * Leave picking mode.
   * @param {boolean} silent - whether to skip the status line.
   */
  function disarm(silent) {
    if (!armed) {
      if (silent !== true) hintEl.textContent = '就绪'
      return
    }
    armed = false
    hovered = null
    overlay.hidden = true
    pickBtn.classList.remove('on')
    detachInterceptors()
    if (silent !== true) {
      hintEl.classList.remove('warn')
      hintEl.textContent = '就绪'
    }
    post({ ev: 'armed', armed: false })
  }

  /**
   * Position the highlight box over an element of the inspected page. Both the
   * box and the frame live inside the same transformed `.viewport`, so the
   * rectangle needs no zoom correction.
   * @param {Element} el - the element to outline.
   * @param {boolean} locked - whether this is the settled selection.
   */
  function drawBox(el, locked) {
    var rect = el.getBoundingClientRect()
    boxEl.style.left = rect.left + 'px'
    boxEl.style.top = rect.top + 'px'
    boxEl.style.width = rect.width + 'px'
    boxEl.style.height = rect.height + 'px'
    boxEl.classList.toggle('locked', locked)
    tagEl.classList.toggle('locked', locked)
    tagEl.textContent = describe(el).selector || el.tagName.toLowerCase()
    var top = rect.top - 18
    tagEl.style.left = Math.max(2, rect.left) + 'px'
    tagEl.style.top = (top < 2 ? rect.bottom + 2 : top) + 'px'
    overlay.hidden = false
  }

  /**
   * Build the full record of one element: everything a model needs to talk
   * about it, and everything a human needs to find it again.
   * @param {Element} el - the picked element.
   * @returns {object} the element payload.
   */
  function describe(el) {
    var win = page.win
    var doc = page.doc
    var rect = el.getBoundingClientRect()
    var secret = el.tagName === 'INPUT' && String(el.getAttribute('type') || '').toLowerCase() === 'password'
    var attrs = {}
    for (var i = 0; i < el.attributes.length; i += 1) {
      var attr = el.attributes[i]
      // A password field's value is never part of an element record: it would
      // otherwise ride into the conversation through the picked-element tool.
      if (secret && attr.name === 'value') continue
      attrs[attr.name] = attr.value.length > 400 ? attr.value.slice(0, 400) + '…' : attr.value
    }
    var html = el.outerHTML || ''
    if (html.length > 1500) html = html.slice(0, 1500) + '…'
    var styles = {}
    try {
      var computed = win.getComputedStyle(el)
      var wanted = [
        'display',
        'position',
        'width',
        'height',
        'color',
        'background-color',
        'font-size',
        'font-weight',
        'border',
        'padding',
        'margin',
        'z-index',
        'opacity',
        'overflow',
      ]
      for (var s = 0; s < wanted.length; s += 1) styles[wanted[s]] = computed.getPropertyValue(wanted[s])
    } catch (error) {
      /* a detached element has no computed style */
    }
    var path = ''
    try {
      path = win.location.pathname + win.location.search + win.location.hash
    } catch (error) {
      path = ''
    }
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      classes: Array.prototype.slice.call(el.classList),
      label: labelOf(el),
      text: squeeze(el.textContent || '', 600),
      selector: cssSelector(el),
      domPath: domPath(el),
      attributes: attrs,
      outerHTML: html,
      boundingRect: {
        left: Math.round(rect.left * 100) / 100,
        top: Math.round(rect.top * 100) / 100,
        width: Math.round(rect.width * 100) / 100,
        height: Math.round(rect.height * 100) / 100,
      },
      pageRect: {
        x: Math.round((rect.left + win.scrollX) * 100) / 100,
        y: Math.round((rect.top + win.scrollY) * 100) / 100,
        width: Math.round(rect.width * 100) / 100,
        height: Math.round(rect.height * 100) / 100,
      },
      viewport: { width: win.innerWidth, height: win.innerHeight },
      styles: styles,
      targetOrigin: targetOrigin,
      pagePath: path,
      pageUrl: targetOrigin + path,
      pageTitle: doc.title || '',
      framed: true,
      time: new Date().toISOString(),
    }
  }

  /**
   * @param {Element} el - the element to name.
   * @returns {string} a short human label for the element.
   */
  function labelOf(el) {
    var text = squeeze(el.textContent || '', 24)
    if (text !== '') return text
    var secret = el.tagName === 'INPUT' && String(el.getAttribute('type') || '').toLowerCase() === 'password'
    var sources = secret ? ['aria-label', 'placeholder', 'name'] : ['aria-label', 'placeholder', 'alt', 'title', 'name', 'value']
    for (var i = 0; i < sources.length; i += 1) {
      var value = el.getAttribute && el.getAttribute(sources[i])
      if (value) return squeeze(value, 24)
    }
    var name = el.tagName.toLowerCase()
    if (el.id) return name + '#' + el.id
    var cls = Array.prototype.slice.call(el.classList)[0]
    return cls ? name + '.' + cls : name
  }

  /**
   * @param {string} text - raw text.
   * @param {number} limit - maximum length.
   * @returns {string} whitespace-collapsed, truncated text.
   */
  function squeeze(text, limit) {
    var out = String(text).replace(/\s+/g, ' ').trim()
    return out.length > limit ? out.slice(0, limit) + '…' : out
  }

  /**
   * Build a CSS selector that resolves to this element. `#id` wins when it is
   * unique; otherwise the chain grows upward with `:nth-of-type` taken among
   * same-tag siblings, which is the only position hint that stays correct in
   * mixed-tag parents.
   * @param {Element} el - the element to select.
   * @returns {string} a selector, or `''` when none could be built.
   */
  function cssSelector(el) {
    var doc = page.doc
    if (!doc || !el || el.nodeType !== 1) return ''
    try {
      if (el.id && doc.querySelectorAll('#' + cssEscape(el.id)).length === 1) return '#' + cssEscape(el.id)
    } catch (error) {
      /* an id that is not a legal selector falls through to the chain */
    }
    var parts = []
    var node = el
    var depth = 0
    while (node && node.nodeType === 1 && node !== doc.documentElement && depth < 6) {
      var part = node.tagName.toLowerCase()
      if (node.id) {
        try {
          if (doc.querySelectorAll('#' + cssEscape(node.id)).length === 1) {
            parts.unshift('#' + cssEscape(node.id))
            break
          }
        } catch (error) {
          /* keep chaining */
        }
      }
      var classes = Array.prototype.slice.call(node.classList).filter(function (name) {
        return /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/.test(name)
      })
      if (classes.length > 0) part += '.' + classes.slice(0, 2).map(cssEscape).join('.')
      var parent = node.parentElement
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function (child) {
          return child.tagName === node.tagName
        })
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')'
      }
      parts.unshift(part)
      node = node.parentElement
      depth += 1
    }
    return parts.join(' > ')
  }

  /**
   * @param {Element} el - the element to locate.
   * @returns {string} a coarse tag/class chain from the root.
   */
  function domPath(el) {
    var doc = page.doc
    var parts = []
    var node = el
    while (node && node.nodeType === 1 && parts.length < 8) {
      var part = node.tagName.toLowerCase()
      var cls = Array.prototype.slice.call(node.classList).slice(0, 2)
      if (cls.length > 0) part += '.' + cls.join('.')
      parts.unshift(part)
      if (node === doc.documentElement) break
      node = node.parentElement
    }
    return parts.join(' > ')
  }

  /**
   * Escape an identifier for use inside a CSS selector.
   * @param {string} value - the raw identifier.
   * @returns {string} the escaped identifier.
   */
  function cssEscape(value) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
    return String(value).replace(/[^a-zA-Z0-9_-]/g, function (char) {
      return '\\' + char
    })
  }

  // ------------------------------------------------------------- credentials

  /**
   * Set an input's value the way a user would, so frameworks that track their
   * own state (React's value tracker, Vue's v-model) notice the change.
   * @param {HTMLInputElement} input - the field to fill.
   * @param {string} value - the value to write.
   */
  function setFieldValue(input, value) {
    var win = page.win
    var setter
    try {
      setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set
    } catch (error) {
      setter = undefined
    }
    if (setter === undefined) input.value = value
    else setter.call(input, value)
    input.dispatchEvent(new win.Event('input', { bubbles: true }))
    input.dispatchEvent(new win.Event('change', { bubbles: true }))
  }

  /**
   * @returns {HTMLInputElement[]} the password fields on the page.
   */
  function passwordFields() {
    if (!page.doc) return []
    return Array.prototype.slice.call(page.doc.querySelectorAll('input[type="password"]'))
  }

  /**
   * The field a form uses for the account name: the last text-like input before
   * the password one, which is what every login form in the wild does.
   * @param {HTMLInputElement} password - the password field.
   * @returns {HTMLInputElement|undefined} the account field.
   */
  function accountFieldOf(password) {
    var form = password.form || page.doc
    if (form === null) return undefined
    var candidates = Array.prototype.slice
      .call(form.querySelectorAll('input'))
      .filter((input) => input.type !== 'password' && /^(text|email|tel|search)?$/.test(input.type))
    var before = candidates.filter((input) => input.compareDocumentPosition(password) & 4)
    return before.length > 0 ? before[before.length - 1] : candidates[0]
  }

  /**
   * Fill the page's login form with the saved account for this origin, if there
   * is one. Runs on every load and whenever the panel hands over credentials.
   * @returns {boolean} whether anything was filled.
   */
  function fillCredentials() {
    var entry = credentialsFor(targetOrigin)
    if (entry === undefined) return false
    var filled = false
    var fields = passwordFields()
    for (var i = 0; i < fields.length; i += 1) {
      if (entry.password !== '' && fields[i].value === '') {
        setFieldValue(fields[i], entry.password)
        filled = true
      }
      var account = accountFieldOf(fields[i])
      if (account !== undefined && entry.username !== '' && account.value === '') {
        setFieldValue(account, entry.username)
        filled = true
      }
    }
    if (filled) toast('已填入保存的账号密码')
    return filled
  }

  /**
   * @param {string} origin - a target origin.
   * @returns {object|undefined} the saved login for it.
   */
  function credentialsFor(origin) {
    for (var i = 0; i < credentials.length; i += 1) {
      if (credentials[i].origin === origin) return credentials[i]
    }
    return undefined
  }

  /**
   * Read the account and password currently in the page's login form.
   * @returns {{username: string, password: string}|undefined} what to offer to save.
   */
  function readLoginForm() {
    var fields = passwordFields()
    for (var i = 0; i < fields.length; i += 1) {
      if (fields[i].value === '') continue
      var account = accountFieldOf(fields[i])
      return {
        username: account === undefined ? '' : String(account.value || ''),
        password: String(fields[i].value || ''),
      }
    }
    return undefined
  }

  /**
   * Ask the panel to remember the login currently in the form. Never prevents
   * the submit: this only observes.
   * @param {Event} [event] - the submit that triggered the capture.
   */
  function offerToSave(event) {
    void event
    var found = readLoginForm()
    if (found === undefined || found.password === '') return
    var existing = credentialsFor(targetOrigin)
    if (existing !== undefined && existing.username === found.username && existing.password === found.password) {
      return
    }
    post({ ev: 'saveCredential', origin: targetOrigin, username: found.username, password: found.password })
  }

  /** Ask the panel for the logins it holds for this origin. */
  function requestCredentials() {
    if (askedForCredentials) return
    askedForCredentials = true
    post({ ev: 'needCredentials', origin: targetOrigin })
  }

  /**
   * Fill after the page has had a chance to render its form (frameworks mount
   * late), and ask for saved logins when the page has a login form but we know
   * of none.
   */
  function syncCredentials() {
    if (!page.doc) return
    if (fillCredentials()) return
    if (passwordFields().length > 0) requestCredentials()
  }

  // -------------------------------------------------------------------- view

  /** @returns {object} the selected device preset. */
  function device() {
    for (var i = 0; i < DEVICES.length; i += 1) {
      if (DEVICES[i].key === view.deviceKey) return DEVICES[i]
    }
    return DEVICES[0]
  }

  /** Re-apply the zoom and device box to the DOM. */
  function applyView() {
    var preset = device()
    var framed = preset.width > 0
    var pad = framed ? 20 : 0
    var availW = Math.max(160, canvas.clientWidth - pad)
    var availH = Math.max(160, canvas.clientHeight - pad)
    var width
    var height
    if (framed) {
      width = view.landscape ? preset.height : preset.width
      height = view.landscape ? preset.width : preset.height
    } else {
      width = availW / view.zoom
      height = availH / view.zoom
    }
    viewport.style.width = width + 'px'
    viewport.style.height = height + 'px'
    viewport.style.transform = 'scale(' + view.zoom + ')'
    sizer.style.width = width * view.zoom + 'px'
    sizer.style.height = height * view.zoom + 'px'
    canvas.classList.toggle('hasFrame', framed)
    sizeLabel.textContent = Math.round(width) + '×' + Math.round(height)
    if (zoomSelect.value !== String(view.zoom)) zoomSelect.value = String(view.zoom)
    // The page's own viewport changed, so anything highlighted is stale.
    onScroll()
  }

  /**
   * @param {number} zoom - the requested scale.
   * @param {boolean} [quiet] - whether to skip reporting to the panel.
   */
  function setZoom(zoom, quiet) {
    var next = Math.min(3, Math.max(0.25, Math.round(zoom * 1000) / 1000))
    if (next === view.zoom) return
    view.zoom = next
    applyView()
    if (quiet !== true) reportView()
  }

  /** @param {string} key - a device preset key. */
  function setDevice(key) {
    var known = false
    for (var i = 0; i < DEVICES.length; i += 1) {
      if (DEVICES[i].key === key) known = true
    }
    view.deviceKey = known ? key : 'responsive'
    view.landscape = false
    deviceSelect.value = view.deviceKey
    applyView()
    reportView()
  }

  /** Tell the panel what the view looks like, so it survives a remount. */
  function reportView() {
    post({ ev: 'view', zoom: view.zoom, deviceKey: view.deviceKey, landscape: view.landscape })
  }

  /** Zoom so the selected device (or the pane itself) fits the available width. */
  function fitWidth() {
    var preset = device()
    var pad = preset.width > 0 ? 20 : 0
    var availW = Math.max(160, canvas.clientWidth - pad)
    if (preset.width > 0) {
      var deviceW = view.landscape ? preset.height : preset.width
      setZoom(availW / deviceW)
    } else {
      setZoom(1)
    }
  }

  /** Populate the two selects from the tables above. */
  function buildControls() {
    for (var i = 0; i < ZOOMS.length; i += 1) {
      var option = document.createElement('option')
      option.value = String(ZOOMS[i])
      option.textContent = Math.round(ZOOMS[i] * 100) + '%'
      zoomSelect.appendChild(option)
    }
    for (var d = 0; d < DEVICES.length; d += 1) {
      var entry = document.createElement('option')
      entry.value = DEVICES[d].key
      entry.textContent =
        DEVICES[d].width === 0
          ? DEVICES[d].label
          : DEVICES[d].label + ' ' + DEVICES[d].width + '×' + DEVICES[d].height
      deviceSelect.appendChild(entry)
    }
    zoomSelect.value = String(view.zoom)
    deviceSelect.value = view.deviceKey
  }

  /**
   * Apply view state handed in by the panel or read from the URL.
   * @param {object} state - `{zoom, deviceKey, landscape}`.
   */
  function applyState(state) {
    if (!state || typeof state !== 'object') return
    if (typeof state.zoom === 'number' && isFinite(state.zoom)) view.zoom = Math.min(3, Math.max(0.25, state.zoom))
    if (typeof state.deviceKey === 'string' && state.deviceKey !== '') view.deviceKey = state.deviceKey
    if (typeof state.landscape === 'boolean') view.landscape = state.landscape
    zoomSelect.value = String(view.zoom)
    deviceSelect.value = view.deviceKey
    applyView()
  }

  // --------------------------------------------------------------- interface

  buildControls()

  goForm.addEventListener('submit', function (event) {
    event.preventDefault()
    open(urlInput.value)
    urlInput.blur()
  })

  openBtn.addEventListener('click', function () {
    var url = absolutize(urlInput.value)
    if (url === '') {
      toast('网址无法识别', true)
      return
    }
    post({ ev: 'openTab', url: url })
  })

  pickBtn.addEventListener('click', function () {
    if (armed) disarm(true)
    else arm()
  })

  backBtn.addEventListener('click', function () {
    try {
      page.win.history.back()
    } catch (error) {
      /* no history yet */
    }
  })

  forwardBtn.addEventListener('click', function () {
    try {
      page.win.history.forward()
    } catch (error) {
      /* nothing ahead */
    }
  })

  reloadBtn.addEventListener('click', function () {
    try {
      frame.contentWindow.location.reload()
    } catch (error) {
      frame.src = frame.src
    }
  })

  zoomSelect.addEventListener('change', function () {
    setZoom(Number(zoomSelect.value))
  })

  zoomInBtn.addEventListener('click', function () {
    for (var i = 0; i < ZOOMS.length; i += 1) {
      if (ZOOMS[i] > view.zoom + 0.001) {
        setZoom(ZOOMS[i])
        return
      }
    }
  })

  zoomOutBtn.addEventListener('click', function () {
    for (var i = ZOOMS.length - 1; i >= 0; i -= 1) {
      if (ZOOMS[i] < view.zoom - 0.001) {
        setZoom(ZOOMS[i])
        return
      }
    }
  })

  fitBtn.addEventListener('click', fitWidth)

  deviceSelect.addEventListener('change', function () {
    setDevice(deviceSelect.value)
  })

  rotateBtn.addEventListener('click', function () {
    if (device().width === 0) {
      toast('响应式模式下无需旋转', true)
      return
    }
    view.landscape = !view.landscape
    applyView()
    reportView()
  })

  window.addEventListener('message', function (event) {
    var data = event.data
    if (!data || data.__dshPicker !== true || data.source !== PARENT_SOURCE) return
    if (data.cmd === 'open') open(data.url)
    else if (data.cmd === 'arm') arm()
    else if (data.cmd === 'disarm') disarm(true)
    else if (data.cmd === 'reload') reloadBtn.click()
    else if (data.cmd === 'back') backBtn.click()
    else if (data.cmd === 'forward') forwardBtn.click()
    else if (data.cmd === 'view') applyState(data.state)
    else if (data.cmd === 'credentials') {
      credentials = Array.isArray(data.entries) ? data.entries : []
      fillCredentials()
    }
  })

  saveLoginBtn.addEventListener('click', function () {
    if (!page.doc) {
      toast('页面还没加载好', true)
      return
    }
    if (passwordFields().length === 0) {
      toast('这个页面没有密码输入框', true)
      return
    }
    offerToSave()
  })

  frame.addEventListener('load', bindPage)

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(function () {
      applyView()
    }).observe(canvas)
  } else {
    window.addEventListener('resize', applyView)
  }

  // View state arrives in the URL so a shell reload (a cross-origin move, or a
  // panel remount) restores the same preview instead of resetting it.
  applyState({
    zoom: Number(params.get('z') || '1') || 1,
    deviceKey: params.get('d') || 'responsive',
    landscape: params.get('l') === '1',
  })

  fetch(ASSET + 'meta')
    .then(function (res) {
      return res.json()
    })
    .then(function (data) {
      meta = data || { target: '', port: 0 }
      if (data && data.target) {
        targetOrigin = data.target
        targetEl.textContent = data.target
      }
      if (initialPath !== '') {
        blankEl.hidden = true
        frame.src = initialPath
      }
      applyView()
      // A fast page can finish loading before this metadata arrives, in which
      // case the address bar fell back to the proxy's own URL. Now that the
      // target origin is known, say it again.
      report()
      post({ ev: 'ready', target: targetOrigin, port: location.port })
      reportView()
    })
    .catch(function () {
      post({ ev: 'ready', target: '', port: location.port })
    })
})()
