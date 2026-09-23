/**
 * Client half of dsh-sidebar-browser.
 *
 * Two surfaces, one conversation:
 *
 *   - a crosshair button in the composer's left tool row, which opens (or
 *     re-reveals) the sidebar browser for the current conversation and is the
 *     only thing that writes into the draft;
 *   - a `browser` tab type in DSH's native right sidebar: a strip of open pages
 *     over one frame each. DSH may unmount this panel at any moment (a session
 *     switch, a collapsed column), so the list of open pages lives in the host
 *     and is mirrored into local storage; the panel is a view over that state
 *     and re-reads it on every mount, which is what keeps open pages from
 *     disappearing. Every frame stays mounted, and a frame's source is pinned to
 *     the navigation that produced it, so switching tabs or picking an element
 *     never reloads a page.
 *
 * The picked elements reach the panel by `postMessage` from the framed shell,
 * and the panel fans them out on a module-level bus. The composer subscribes to
 * that bus rather than to the panel, so the two surfaces need no shared store
 * and the composer keeps working while the sidebar is closed.
 */
window.__ModuleLoader__.load({
  id: 'dsh-sidebar-browser',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    'use strict'

    var React = require('react')
    var h = React.createElement

    /** Package id: matches the loader entry and the host plugin's prompt name. */
    var PLUGIN_ID = 'dsh-sidebar-browser'
    /** The namespace this bundle wrote under while it was called an element picker. */
    var LEGACY_PLUGIN_ID = 'dsh-sidebar-element-picker'
    /** One-shot marker: the legacy namespace has already been carried over. */
    var MIGRATION_KEY = 'dsh-sidebar-browser:migrated-from-element-picker'
    /** The host route the panel and the composer talk to. */
    var INVOKE = '/dsh-sidebar-browser/invoke'
    /** The native tab type's implementation id (also the slot key). */
    var TYPE_ID = 'dsh-sidebar-browser:browser'
    /** The native tab type's kind. */
    var KIND = 'browser'
    /** The tab's fallback title, shown in the strip and the sidebar guide. */
    var TAB_TITLE = '浏览器'
    /** Where the shell's own page lives on every proxy port. */
    var SHELL_PATH = '/__dsh_shell__/chrome.html'
    /** The shell identifies its own messages with this value. */
    var SHELL_SOURCE = 'dsh-sidebar-browser-shell'
    /** localStorage key holding the last address the user opened. */
    var LAST_URL_KEY = 'dsh-sidebar-browser:url'
    /** localStorage key holding recently opened addresses, newest first. */
    var HISTORY_KEY = 'dsh-sidebar-browser:history'
    /** How many recent addresses the start page offers. */
    var HISTORY_LIMIT = 8
    /** localStorage key prefix holding one conversation's open pages. */
    var TABS_KEY_PREFIX = 'dsh-sidebar-browser:tabs:'
    /** localStorage key holding `origin → port`, so an origin survives a restart. */
    var PORTS_KEY = 'dsh-sidebar-browser:ports'
    /** localStorage key holding the saved logins. */
    var CREDENTIALS_KEY = 'dsh-sidebar-browser:credentials'
    /** The value the shell uses to recognise commands from this panel. */
    var PARENT_SOURCE = 'dsh-sidebar-browser'
    /** Address used when the composer button needs somewhere to go. */
    var DEFAULT_URL = 'http://localhost:3000/'

    var STYLE_ID = 'dsh-sidebar-browser-style'

    var STYLE_CSS = [
      '.dsh-sb-button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dsh-sb-button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsh-sb-button[data-active="true"]{color:var(--dsw-alias-state-business-primary)}',
      '.dsh-sb-pane{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}',
      '.dsh-sb-strip{display:flex;align-items:center;gap:4px;flex:none;min-height:30px;padding:3px 6px;border-bottom:0.5px solid var(--dsw-alias-border-l1)}',
      '.dsh-sb-tabs{display:flex;align-items:center;gap:3px;flex:1 1 auto;min-width:0;overflow-x:auto;scrollbar-width:none}',
      '.dsh-sb-tabs::-webkit-scrollbar{display:none}',
      '.dsh-sb-tab{display:flex;align-items:center;gap:5px;flex:none;max-width:150px;height:24px;padding:0 4px 0 9px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}',
      '.dsh-sb-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-sb-tab[data-active="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}',
      '.dsh-sb-tabTitle{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
      '.dsh-sb-tabClose{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;flex:none;border-radius:4px;font-size:13px;line-height:1;opacity:.55;cursor:pointer}',
      '.dsh-sb-tabClose:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-sb-newtab{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;flex:none;border:0.5px solid var(--dsw-alias-border-l1);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer}',
      '.dsh-sb-newtab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsh-sb-stripTools{display:flex;align-items:center;gap:6px;flex:none;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-sb-link{border:none;background:transparent;padding:0 2px;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}',
      '.dsh-sb-link:hover{color:var(--dsw-alias-state-error-primary)}',
      '.dsh-sb-frames{position:relative;flex:1 1 auto;min-height:0}',
      '.dsh-sb-frame{display:block;width:100%;height:100%;border:0;background:#fff;position:absolute;inset:0}',
      '.dsh-sb-frame[data-hidden="true"]{visibility:hidden;pointer-events:none;z-index:0}',
      '.dsh-sb-start{display:flex;flex-direction:column;gap:14px;height:100%;padding:16px 14px 20px;box-sizing:border-box;overflow-y:auto}',
      '.dsh-sb-hero{display:flex;align-items:center;gap:10px}',
      '.dsh-sb-heroGlyph{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;flex:none;border-radius:11px;background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-state-business-primary)}',
      '.dsh-sb-heroText{min-width:0}',
      '.dsh-sb-heroTitle{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsh-sb-heroHint{margin:2px 0 0;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-sb-composer{display:flex;gap:6px;width:100%}',
      '.dsh-sb-section{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.dsh-sb-sectionHead{display:flex;align-items:center;gap:6px;padding:0 4px 4px;font-size:11px;color:var(--dsw-alias-label-caption)}',
      '.dsh-sb-sectionAction{margin-left:auto;border:none;background:transparent;padding:0;color:var(--dsw-alias-label-caption);font:inherit;cursor:pointer}',
      '.dsh-sb-sectionAction:hover{color:var(--dsw-alias-state-error-primary)}',
      '.dsh-sb-sectionCount{margin-left:auto;font-variant-numeric:tabular-nums}',
      '.dsh-sb-list{display:flex;flex-direction:column;gap:2px}',
      '.dsh-sb-item{display:flex;align-items:center;gap:2px;border-radius:9px;border:0.5px solid transparent}',
      '.dsh-sb-item:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}',
      '.dsh-sb-itemMain{display:flex;align-items:center;gap:9px;flex:1 1 auto;min-width:0;padding:6px;border:none;border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}',
      '.dsh-sb-itemBadge{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;flex:none;border-radius:7px;background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600}',
      '.dsh-sb-itemBadge.isKey{color:var(--dsw-alias-state-business-primary)}',
      '.dsh-sb-itemText{display:flex;flex-direction:column;min-width:0;gap:1px}',
      '.dsh-sb-itemTitle{font-size:12px;color:var(--dsw-alias-label-primary);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
      '.dsh-sb-itemUrl{font-size:11px;color:var(--dsw-alias-label-caption);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
      '.dsh-sb-itemX{flex:none;width:20px;height:20px;margin-right:4px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-caption);font:inherit;font-size:13px;line-height:1;cursor:pointer;opacity:0}',
      '.dsh-sb-item:hover .dsh-sb-itemX{opacity:1}',
      '.dsh-sb-itemX:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-error-primary)}',
      '.dsh-sb-idleHint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-sb-form{display:flex;flex-direction:column;gap:8px;width:100%}',
      '.dsh-sb-row{display:flex;gap:6px}',
      '.dsh-sb-input{box-sizing:border-box;flex:1 1 auto;min-width:0;height:32px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:13px;outline:none}',
      '.dsh-sb-input:focus{border-color:var(--dsw-alias-state-business-primary)}',
      '.dsh-sb-open{flex:none;height:32px;padding:0 14px;border-radius:8px;border:none;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-family:inherit;font-size:13px;cursor:pointer}',
      '.dsh-sb-open:hover{background:var(--dsw-alias-button-primary-hover)}',
      '.dsh-sb-open:disabled{opacity:.4;cursor:not-allowed}',
      '.dsh-sb-error{margin:0;font-size:12px;color:var(--dsw-alias-state-error-primary)}',
      '.dsh-sb-notice{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-sb-savebar{display:flex;align-items:center;gap:9px;flex:none;padding:7px 9px;border-bottom:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-sb-saveGlyph{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;flex:none;border-radius:7px;background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-state-business-primary)}',
      '.dsh-sb-saveText{display:flex;flex-direction:column;gap:1px;flex:1 1 auto;min-width:0}',
      '.dsh-sb-saveTitle{font-size:12px;color:var(--dsw-alias-label-primary);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
      '.dsh-sb-saveSub{font-size:11px;color:var(--dsw-alias-label-caption);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
      '.dsh-sb-saveGo,.dsh-sb-saveSkip{flex:none;height:24px;padding:0 10px;border-radius:7px;font:inherit;font-size:12px;cursor:pointer}',
      '.dsh-sb-saveGo{border:none;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.dsh-sb-saveGo:hover{background:var(--dsw-alias-button-primary-hover)}',
      '.dsh-sb-saveSkip{border:0.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary)}',
      '.dsh-sb-saveSkip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsh-sb-flash{display:flex;align-items:center;gap:6px;flex:none;padding:5px 9px;border-bottom:0.5px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-sb-code{padding:1px 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
      '.dsh-sb-busy{flex:1 1 auto;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);font-size:12px}',
    ].join('')

    /** Inject the stylesheet once per document. */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      var style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = STYLE_CSS
      document.head.appendChild(style)
    }

    /** @param {string} message - diagnostic text. */
    function logInfo(message) {
      console.info(`[${PLUGIN_ID}] ${message}`)
    }

    /** @param {string} message - warning text. */
    function logWarn(message) {
      console.warn(`[${PLUGIN_ID}] ${message}`)
    }

    /**
     * Carry storage written by the pre-rename bundle over to this namespace.
     *
     * The old bundle (`dsh-sidebar-element-picker`, back when this was sold as
     * an element picker) keyed everything by its package id, so a rename alone
     * would silently drop the remembered address, the recent list, every
     * conversation's open tabs, the saved logins — and, worst of the lot, the
     * `origin → port` map. Losing that map hands a site a fresh origin, which
     * wipes the login state it keeps in its own localStorage.
     *
     * Runs once per browser; a later downgrade would find its keys gone, which
     * is the one direction this deliberately does not preserve.
     * @returns {void}
     */
    function migrateLegacyStorage() {
      try {
        var storage = window.localStorage
        if (storage.getItem(MIGRATION_KEY) !== null) return
        var legacyPrefix = `${LEGACY_PLUGIN_ID}:`
        var keys = []
        for (var i = 0; i < storage.length; i += 1) keys.push(storage.key(i))
        var moved = 0
        keys.forEach((key) => {
          if (key === null || key.indexOf(legacyPrefix) !== 0) return
          var next = `${PLUGIN_ID}:${key.slice(legacyPrefix.length)}`
          // A value already written under the new name wins: the user has been
          // running the renamed bundle and this is a stale leftover.
          if (storage.getItem(next) === null) {
            storage.setItem(next, storage.getItem(key))
            moved += 1
          }
          storage.removeItem(key)
        })
        storage.setItem(MIGRATION_KEY, String(Date.now()))
        if (moved > 0) logInfo(`已从旧命名空间迁移 ${moved} 项设置（标签页 / 最近访问 / 账号 / 端口记忆）`)
      } catch (error) {
        logWarn(`旧命名空间迁移失败（不影响使用，但历史与登录记忆会从零开始）: ${error}`)
      }
    }

    /**
     * Call one host method.
     * @param {string} method - the host handler name.
     * @param {object} params - its parameters.
     * @returns {Promise<object>} the host's answer, or `{ok:false, error}`.
     */
    function invoke(method, params) {
      return fetch(`${window.location.origin}${INVOKE}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: method, params: params ?? {} }),
      })
        .then((response) => response.json())
        .catch((error) => ({ ok: false, error: String((error && error.message) || error) }))
    }

    /**
     * Picks travel from the framed shell to whatever wants them. The panel
     * publishes, the composer subscribes; neither knows about the other.
     */
    var bus = {
      listeners: new Set(),
      /**
       * @param {(event: object) => void} listener - subscriber.
       * @returns {() => void} unsubscribe.
       */
      subscribe(listener) {
        this.listeners.add(listener)
        return () => {
          this.listeners.delete(listener)
        }
      },
      /**
       * @param {object} event - a typed event; see the two publishers below.
       */
      publish(event) {
        for (const listener of [...this.listeners]) {
          try {
            listener(event)
          } catch (error) {
            logWarn(`订阅者抛错：${String((error && error.message) || error)}`)
          }
        }
      },
      /**
       * A page was picked in the browser.
       * @param {object} event - `{sessionId, domId, label, element}`.
       */
      publishPick(event) {
        this.publish({ type: 'pick', ...event })
      },
      /**
       * The browser's set of open pages changed outside the panel (the composer
       * button opened one, or closed them all).
       * @param {string} sessionId - the conversation.
       */
      publishState(sessionId) {
        this.publish({ type: 'state', sessionId: sessionId })
      },
    }

    /**
     * The active page's title per DSH tab, so the sidebar chip can name the page
     * instead of the plugin (a tab record's own title cannot be changed after
     * it is opened, so the chip is rendered by us).
     */
    var titleStore = {
      values: new Map(),
      listeners: new Set(),
      /**
       * @param {string} tabId - the DSH sidebar tab.
       * @param {string} value - the page title.
       */
      set(tabId, value) {
        if (this.values.get(tabId) === value) return
        this.values.set(tabId, value)
        for (const listener of [...this.listeners]) listener()
      },
      /**
       * @param {string} tabId - the DSH sidebar tab.
       * @returns {string} the page title.
       */
      get(tabId) {
        var value = this.values.get(tabId)
        return value === undefined ? '' : value
      },
      /**
       * @param {() => void} listener - subscriber.
       * @returns {() => void} unsubscribe.
       */
      subscribe(listener) {
        this.listeners.add(listener)
        return () => {
          this.listeners.delete(listener)
        }
      },
    }

    /**
     * @returns {string} the address the user opened last, or `''` when this
     * browser has never been used — the two cases want different behaviour.
     */
    function storedUrl() {
      try {
        var stored = window.localStorage.getItem(LAST_URL_KEY)
        if (typeof stored === 'string' && stored.trim() !== '') return stored
      } catch (error) {
        /* storage can be unavailable */
      }
      return ''
    }

    /**
     * @returns {string} the address to open when nothing is open yet.
     */
    function rememberedUrl() {
      var stored = storedUrl()
      if (stored !== '') return stored
      var history = readHistory()
      return history.length > 0 ? history[0].url : DEFAULT_URL
    }

    /** @param {string} url - the address to remember for next time. */
    function rememberUrl(url) {
      try {
        window.localStorage.setItem(LAST_URL_KEY, url)
      } catch (error) {
        /* storage can be unavailable */
      }
    }

    /**
     * @returns {Array<{url: string, title: string}>} recently opened addresses,
     * newest first.
     */
    function readHistory() {
      try {
        var raw = window.localStorage.getItem(HISTORY_KEY)
        if (typeof raw !== 'string' || raw === '') return []
        var parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed
          .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.url === 'string')
          .map((entry) => ({ url: entry.url, title: typeof entry.title === 'string' ? entry.title : '' }))
      } catch (error) {
        return []
      }
    }

    /**
     * Remember one address, most recent first and without duplicates.
     * @param {string} url - the address that was opened.
     * @param {string} [title] - the page title, once it is known.
     */
    function pushHistory(url, title) {
      var target = String(url ?? '')
      if (target === '') return
      try {
        var previous = readHistory().filter((item) => item.url === target)[0]
        var entry = {
          url: target,
          title: String(title ?? '') !== '' ? String(title) : previous === undefined ? '' : previous.title,
        }
        var list = readHistory().filter((item) => item.url !== target)
        list.unshift(entry)
        window.localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_LIMIT)))
      } catch (error) {
        /* storage can be unavailable or full */
      }
    }

    /**
     * @returns {Record<string, number>} the port each target origin used last.
     */
    function readPorts() {
      try {
        var raw = window.localStorage.getItem(PORTS_KEY)
        if (typeof raw !== 'string' || raw === '') return {}
        var parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? parsed : {}
      } catch (error) {
        return {}
      }
    }

    /**
     * The port a target origin used before. Asking for it again is what keeps a
     * site on the same browser origin across a restart, and therefore keeps the
     * cookies, `localStorage` and `IndexedDB` the site's own session lives in.
     * @param {string} origin - a target origin.
     * @returns {number|undefined} the port to prefer.
     */
    function portFor(origin) {
      var port = readPorts()[origin]
      return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : undefined
    }

    /**
     * @param {string} origin - a target origin.
     * @param {number} port - the port it is being served on.
     */
    function rememberPort(origin, port) {
      if (typeof origin !== 'string' || origin === '') return
      if (!Number.isInteger(port) || port < 1024 || port > 65535) return
      try {
        var ports = readPorts()
        if (ports[origin] === port) return
        ports[origin] = port
        window.localStorage.setItem(PORTS_KEY, JSON.stringify(ports))
      } catch (error) {
        /* storage can be unavailable */
      }
    }

    /**
     * @param {string} url - an absolute address.
     * @returns {number|undefined} the port its origin used before.
     */
    function portForUrl(url) {
      try {
        return portFor(new URL(url).origin)
      } catch (error) {
        return undefined
      }
    }

    // ------------------------------------------------------------- credentials

    /**
     * @returns {Array<{origin: string, username: string, password: string, updatedAt: number}>}
     * the saved logins, newest first.
     */
    function readCredentials() {
      try {
        var raw = window.localStorage.getItem(CREDENTIALS_KEY)
        if (typeof raw !== 'string' || raw === '') return []
        var parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed
          .filter(
            (entry) =>
              entry !== null &&
              typeof entry === 'object' &&
              typeof entry.origin === 'string' &&
              typeof entry.password === 'string',
          )
          .map((entry) => ({
            origin: entry.origin,
            username: typeof entry.username === 'string' ? entry.username : '',
            password: entry.password,
            updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
          }))
      } catch (error) {
        return []
      }
    }

    /**
     * Remember (or update) the login for one origin. One account per origin is
     * kept: a second username for the same site replaces the first, which is
     * what a browser offers to do.
     * @param {{origin: string, username: string, password: string}} entry - the login.
     */
    function saveCredential(entry) {
      if (entry.origin === '' || entry.password === '') return
      try {
        var list = readCredentials().filter((item) => item.origin !== entry.origin)
        list.unshift({
          origin: entry.origin,
          username: entry.username,
          password: entry.password,
          updatedAt: Date.now(),
        })
        window.localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(list.slice(0, 50)))
      } catch (error) {
        logWarn('无法保存账号密码（浏览器存储不可用）')
      }
    }

    /**
     * @param {string} origin - the site to forget.
     */
    function forgetCredential(origin) {
      try {
        var list = readCredentials().filter((item) => item.origin !== origin)
        if (list.length === 0) window.localStorage.removeItem(CREDENTIALS_KEY)
        else window.localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(list))
      } catch (error) {
        /* storage can be unavailable */
      }
    }

    /**
     * @param {string} origin - a target origin.
     * @returns {string} the site as a person writes it.
     */
    function hostOf(origin) {
      return String(origin ?? '').replace(/^https?:\/\//, '')
    }

    /**
     * @param {string} url - an absolute address.
     * @returns {string} its origin, or the input when it cannot be parsed.
     */
    function originOf(url) {
      try {
        return new URL(url).origin
      } catch (error) {
        return String(url ?? '')
      }
    }

    /**
     * @param {string} url - an absolute address.
     * @returns {string} its path, query and hash.
     */
    function pathOf(url) {
      try {
        var parsed = new URL(url)
        return `${parsed.pathname}${parsed.search}` || '/'
      } catch (error) {
        return ''
      }
    }

    /**
     * @param {string} url - an absolute address.
     * @returns {string} a short label for a start-page row.
     */
    function shortLabel(url) {
      var text = String(url ?? '')
        .replace(/^https?:\/\//, '')
        .replace(/\/$/, '')
      return text.length > 44 ? `…${text.slice(-43)}` : text
    }

    /**
     * Give bare address-bar text an `http://` scheme without mistaking
     * `host:port` for a scheme: `localhost:3000/admin` is a host and a port, not
     * a URL in the `localhost` scheme, and a real foreign scheme (`mailto:`,
     * `file:`) must be refused rather than silently rewritten into a host.
     * @param {string} text - what the user typed.
     * @returns {string} absolute http(s) text, or `''` when it cannot be one.
     */
    function withScheme(text) {
      var match = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/.exec(text)
      if (match === null) return `http://${text}`
      if (/^https?$/i.test(match[1])) return text
      if (/^\d+(?:[/?#].*)?$/.test(match[2])) return `http://${text}`
      return ''
    }

    /**
     * Normalise address-bar text into an absolute http(s) URL.
     * @param {string} input - what the user typed.
     * @returns {string} an absolute URL, or `''` when it is not one.
     */
    function normalizeUrl(input) {
      var text = String(input ?? '').trim()
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
     * The durable mirror of a conversation's open pages. The host is the
     * authority while DSH runs; this is what carries the pages across a restart.
     * @param {string} sessionId - the conversation.
     * @returns {object|undefined} the stored snapshot.
     */
    function readSnapshot(sessionId) {
      try {
        var raw = window.localStorage.getItem(TABS_KEY_PREFIX + sessionId)
        if (typeof raw !== 'string' || raw === '') return undefined
        var parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.tabs)) return undefined
        return parsed
      } catch (error) {
        return undefined
      }
    }

    /**
     * @param {string} sessionId - the conversation.
     * @param {object} state - the host's browser state.
     */
    function writeSnapshot(sessionId, state) {
      try {
        if (state.tabs.length === 0) {
          window.localStorage.removeItem(TABS_KEY_PREFIX + sessionId)
          return
        }
        window.localStorage.setItem(
          TABS_KEY_PREFIX + sessionId,
          JSON.stringify({
            activeId: state.activeId,
            tabs: state.tabs.map((tab) => ({
              id: tab.id,
              url: tab.url,
              title: tab.title,
              zoom: tab.zoom,
              deviceKey: tab.deviceKey,
              landscape: tab.landscape,
              // The port is what makes the restored page the same browser origin
              // it was before, so the site's own session storage still applies.
              port: tab.port,
            })),
          }),
        )
      } catch (error) {
        /* storage can be unavailable or full */
      }
    }

    /**
     * Build the shell's URL for one proxy port.
     * @param {object} tab - one browser tab from the host.
     * @returns {string} the address to put in that tab's frame.
     */
    function shellUrl(tab) {
      // Same hostname as the GUI so the two stay same-site: cookies then flow
      // in the frame on the same terms they would in a top-level tab.
      var origin = `${window.location.protocol}//${window.location.hostname}:${tab.port}`
      var query = new URLSearchParams()
      if (tab.path && tab.path !== '/') query.set('p', tab.path)
      if (typeof tab.zoom === 'number' && tab.zoom !== 1) query.set('z', String(tab.zoom))
      if (tab.deviceKey && tab.deviceKey !== 'responsive') query.set('d', tab.deviceKey)
      if (tab.landscape === true) query.set('l', '1')
      var suffix = query.toString()
      return `${origin}${SHELL_PATH}${suffix === '' ? '' : `?${suffix}`}`
    }

    /**
     * @param {object} tab - one browser tab from the host.
     * @returns {string} a short label for the strip.
     */
    function labelOfTab(tab) {
      if (typeof tab.title === 'string' && tab.title.trim() !== '') {
        var title = tab.title.trim()
        return title.length > 22 ? `${title.slice(0, 22)}…` : title
      }
      var path = tab.path && tab.path !== '/' ? tab.path : ''
      var host = String(tab.origin ?? '').replace(/^https?:\/\//, '')
      var text = `${host}${path}`
      return text.length > 26 ? `…${text.slice(-25)}` : text
    }

    /**
     * A crosshair: the picker's own glyph, used by the composer button, the
     * sidebar guide entry and the tab chip.
     * @param {{size?: number}} props - glyph size.
     * @returns {object} the icon element.
     */
    function CrosshairGlyph(props) {
      var size = props && props.size ? props.size : 16
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M8 1.6v3M8 11.4v3M1.6 8h3M11.4 8h3',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
        h('circle', { cx: 8, cy: 8, r: 3.1, stroke: 'currentColor', strokeWidth: 1.4 }),
        h('circle', { cx: 8, cy: 8, r: 0.9, fill: 'currentColor' }),
      )
    }

    /**
     * A globe: the recent-visit mark. A host's first letter would be the same
     * for every `localhost:*` entry, so it would carry no information.
     * @param {{size?: number}} props - glyph size.
     * @returns {object} the icon element.
     */
    function GlobeGlyph(props) {
      var size = props && props.size ? props.size : 13
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('circle', { cx: 8, cy: 8, r: 6, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { d: 'M2 8h12M8 2c1.8 2 1.8 10 0 12M8 2c-1.8 2-1.8 10 0 12', stroke: 'currentColor', strokeWidth: 1.1 }),
      )
    }

    /**
     * A key: the saved-login mark, used by the save bar and the start page.
     * @param {{size?: number}} props - glyph size.
     * @returns {object} the icon element.
     */
    function KeyGlyph(props) {
      var size = props && props.size ? props.size : 14
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('circle', { cx: 5.4, cy: 10.6, r: 2.6, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', { d: 'M7.3 8.7 12.6 3.4M10.9 5.1l1.5 1.5M12.4 3.6l1.4 1.4', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
      )
    }

    /**
     * A hook-shaped no-op used when the seat does not hand the composer its
     * standard machine-state readers (a host without them still renders the
     * panel; only in-draft insertion goes quiet).
     * @param {(state: object) => unknown} selector - the seat's selector.
     * @returns {unknown} the selector applied to an empty state.
     */
    function useNothing(selector) {
      return typeof selector === 'function' ? selector({ draft: '' }) : undefined
    }

    /**
     * Open the conversation's browser tab, or reveal the one already open.
     * @param {string} sessionId - the conversation to open it in.
     * @param {string} url - the address to land on.
     * @returns {boolean} whether a tab type was reachable.
     */
    function revealBrowser(sessionId, url) {
      var right = service.right
      if (right === undefined || right === null) {
        right = service.context === undefined ? undefined : service.context.get('sidebarRight')
      }
      if (right === undefined || right === null) {
        logWarn('右侧栏服务不可用（sidebarRight），无法打开浏览器面板')
        return false
      }
      var options = { params: { url: url, at: Date.now() } }
      try {
        // `openTabIn` names the session explicitly and queues until that
        // session's surface is mounted; `openTab` needs one already mounted.
        if (typeof right.openTabIn === 'function' && typeof sessionId === 'string' && sessionId !== '') {
          right.openTabIn(sessionId, KIND, options)
        } else {
          right.openTab(KIND, options)
        }
        return true
      } catch (error) {
        logWarn(`打开浏览器面板失败：${String((error && error.message) || error)}`)
        return false
      }
    }

    /** Shared handles the components need but do not receive as props. */
    var service = { context: undefined, right: undefined }

    /**
     * The composer's crosshair button. It owns draft writes, so a pick lands in
     * the input box even when the sidebar is scrolled away or collapsed.
     * @param {object} props - the `conversation.input.left` seat's props.
     * @returns {object} the button element.
     */
    function PickerButton(props) {
      var sessionId = props.sessionId
      var inputActions = props.inputActions
      var useInput = props.useInput

      var useDraft = React.useMemo(
        () => (typeof useInput === 'function' ? useInput : useNothing),
        [useInput],
      )
      var draftFromStore = useDraft((state) => (state && typeof state === 'object' ? state.draft : undefined))
      var draftRef = React.useRef(typeof draftFromStore === 'string' ? draftFromStore : '')
      draftRef.current = typeof draftFromStore === 'string' ? draftFromStore : ''
      var inputActionsRef = React.useRef(inputActions)
      inputActionsRef.current = inputActions

      var [inserted, setInserted] = React.useState(0)
      var [opened, setOpened] = React.useState(false)
      var seenRef = React.useRef(new Set())

      React.useEffect(() => {
        return bus.subscribe((event) => {
          if (event.type !== 'pick' || event.sessionId !== sessionId) return
          // Numbers are minted once per pick, so a repeat is the same pick seen
          // twice (a stale frame still mounted, two panes on one conversation)
          // and must not be inserted again.
          if (seenRef.current.has(event.domId)) return
          seenRef.current.add(event.domId)
          var placeholder = `[${event.label}][${event.domId}]`
          var current = draftRef.current
          var next = current.trim() === '' ? placeholder : `${current.replace(/\s+$/, '')}\n${placeholder}`
          draftRef.current = next
          var actions = inputActionsRef.current
          if (actions !== undefined && actions !== null && typeof actions.setDraft === 'function') {
            actions.setDraft(next)
            setInserted((count) => count + 1)
          } else {
            logWarn(`已拾取 ${placeholder}，但输入框不可写，请手动粘贴`)
          }
        })
      }, [sessionId])

      var onClick = React.useCallback(() => {
        var url = normalizeUrl(rememberedUrl()) || DEFAULT_URL
        // Open a page only when the browser is empty: clicking the crosshair on
        // a browser that already has pages must reveal it, never navigate the
        // page the user is working in.
        invoke('browser-state', { sessionId: sessionId })
          .then((result) => {
            if (result !== null && result.ok === true && result.tabs.length === 0) {
              rememberUrl(url)
              pushHistory(url)
              return invoke('browser-open', { sessionId: sessionId, url: url, newTab: true })
            }
            return null
          })
          .then(() => {
            bus.publishState(sessionId)
            var ok = revealBrowser(sessionId, url)
            setOpened(ok)
            if (!ok) logWarn('未找到已注册的 browser 侧边栏页签，请确认侧边栏可用')
          })
      }, [sessionId])

      var title = inserted > 0 ? `在侧边栏中浏览网页并拾取元素（已插入 ${inserted} 个引用）` : '在侧边栏中浏览网页并拾取元素'

      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-sb-button',
          title: title,
          'aria-label': title,
          'data-active': opened ? 'true' : 'false',
          onMouseDown: (event) => event.preventDefault(),
          onClick: onClick,
        },
        h(CrosshairGlyph, { size: 16 }),
      )
    }

    /**
     * The sidebar tab's body: the strip of open pages over one frame each.
     * @param {object} props - the `sidebar.right.pane.tab` seat's props.
     * @returns {object} the panel element.
     */
    function BrowserPanel(props) {
      // The seat injects `hooks.tabInfo`; the framework exposes it as this prop.
      var info = props.useTabInfo()
      var dshTab = info.tab
      var tabId = dshTab.id
      var sessionId = props.sessionId

      var [state, setState] = React.useState(null)
      var [url, setUrl] = React.useState(() => normalizeUrl(storedUrl()) || '')
      var [history, setHistory] = React.useState(() => readHistory())
      var [logins, setLogins] = React.useState(() => readCredentials())
      var [pendingLogin, setPendingLogin] = React.useState(null)
      var [notice, setNotice] = React.useState('')
      var [error, setError] = React.useState('')
      var [busy, setBusy] = React.useState(false)
      var [count, setCount] = React.useState(0)
      var framesRef = React.useRef({})
      // A frame's source is pinned to the navigation that produced it, so a
      // re-render for any other reason (a pick, a title, the count) cannot
      // reload a page the user is already on. Only an explicit navigation — a
      // new port or a bumped `nav` — re-points it.
      var sourcesRef = React.useRef({})
      var mountedRef = React.useRef(true)

      React.useEffect(() => {
        mountedRef.current = true
        return () => {
          mountedRef.current = false
        }
      }, [])

      /** Apply one host answer to the panel's state. */
      var apply = React.useCallback(
        (result) => {
          if (result === null || result === undefined || result.ok !== true) {
            if (result !== null && result !== undefined && result.error !== undefined) {
              setError(String(result.error))
            }
            return false
          }
          setState({ activeId: result.activeId, tabs: result.tabs })
          writeSnapshot(sessionId, result)
          for (const tab of result.tabs) rememberPort(tab.origin, tab.port)
          return true
        },
        [sessionId],
      )

      var call = React.useCallback(
        (method, extra) => {
          var payload = { sessionId: sessionId }
          if (extra !== undefined) {
            for (var key in extra) payload[key] = extra[key]
          }
          return invoke(method, payload).then((result) => {
            if (mountedRef.current) apply(result)
            return result
          })
        },
        [sessionId, apply],
      )

      /**
       * Hand the shell its origin's saved login. The shell cannot read this
       * store itself (it runs on the proxy origin), so the panel is the only
       * party that can fill a page in.
       * @param {string} id - the browser tab whose frame should receive them.
       * @param {string} origin - the origin to look the login up by.
       */
      var pushCredentials = React.useCallback((id, origin) => {
        var frame = framesRef.current[id]
        if (frame === null || frame === undefined || frame.contentWindow === null || frame.contentWindow === undefined) return
        var entries = readCredentials().filter((entry) => entry.origin === origin)
        frame.contentWindow.postMessage(
          { __dshPicker: true, source: PARENT_SOURCE, cmd: 'credentials', entries: entries },
          '*',
        )
      }, [])

      /**
       * @param {{origin: string, username: string, password: string}} entry - the login to store.
       */
      var acceptLogin = React.useCallback(
        (entry) => {
          saveCredential(entry)
          setLogins(readCredentials())
          setPendingLogin(null)
          setNotice(`已保存 ${hostOf(entry.origin)} 的账号密码`)
          for (var id in framesRef.current) pushCredentials(id, entry.origin)
        },
        [pushCredentials],
      )

      /** Re-read the authority; the panel owns no copy of the tab list. */
      var refresh = React.useCallback(() => {
        return invoke('browser-state', { sessionId: sessionId }).then((result) => {
          if (mountedRef.current) apply(result)
          return result
        })
      }, [sessionId, apply])

      /** Open one address in a new page and remember it. */
      var openNew = React.useCallback(
        (raw) => {
          var next = normalizeUrl(raw)
          if (next === '') {
            setError('请输入有效的网址，例如 localhost:3000/admin')
            return Promise.resolve(null)
          }
          setError('')
          setBusy(true)
          rememberUrl(next)
          pushHistory(next)
          setHistory(readHistory())
          return call('browser-open', { url: next, newTab: true, preferredPort: portForUrl(next) }).then((result) => {
            setBusy(false)
            return result
          })
        },
        [call],
      )

      // Mount: the host's live state wins; the local-storage snapshot is only
      // the fallback that carries pages across a DSH restart.
      var bootRef = React.useRef(false)
      React.useEffect(() => {
        if (bootRef.current) return
        bootRef.current = true
        invoke('browser-state', { sessionId: sessionId, restore: readSnapshot(sessionId) }).then((result) => {
          if (!mountedRef.current) return
          apply(result)
          if (result === null || result.ok !== true || result.tabs.length > 0) return
          // This panel exists to show a page, not to ask permission to show
          // one: with an address already known, open it immediately. Only a
          // browser that has never been used anywhere reaches the start page.
          var seed = normalizeUrl(storedUrl())
          if (seed === '') {
            var recent = readHistory()[0]
            seed = recent === undefined ? '' : normalizeUrl(recent.url)
          }
          if (seed === '') return
          setUrl(seed)
          setBusy(true)
          rememberUrl(seed)
          void call('browser-open', { url: seed, newTab: true }).then(() => setBusy(false))
        })
        invoke('context-list', { sessionId: sessionId }).then((result) => {
          if (!mountedRef.current) return
          if (result !== null && result.ok === true && typeof result.count === 'number') setCount(result.count)
        })
      }, [sessionId, apply, call])

      // The composer button changes the browser outside this panel.
      React.useEffect(() => {
        return bus.subscribe((event) => {
          if (event.type !== 'state' || event.sessionId !== sessionId) return
          void refresh()
        })
      }, [sessionId, refresh])

      // The active page's title feeds the sidebar chip.
      var activeTab = state === null ? undefined : state.tabs.filter((tab) => tab.id === state.activeId)[0]
      var activeLabel = activeTab === undefined ? '' : labelOfTab(activeTab)
      React.useEffect(() => {
        titleStore.set(tabId, activeLabel)
      }, [tabId, activeLabel])
      React.useEffect(() => {
        return () => titleStore.set(tabId, '')
      }, [tabId])

      // Elements and address changes reach the panel from the framed shells;
      // each message is attributed back to the tab whose frame sent it.
      React.useEffect(() => {
        var onMessage = (event) => {
          var data = event.data
          if (data === null || typeof data !== 'object' || data.__dshPicker !== true) return
          if (data.source !== SHELL_SOURCE) return
          var from = null
          var frames = framesRef.current
          for (var id in frames) {
            if (frames[id] !== null && frames[id] !== undefined && frames[id].contentWindow === event.source) from = id
          }
          if (from === null) return
          if (data.ev === 'picked') {
            bus.publishPick({ sessionId: sessionId, domId: data.domId, label: data.label, element: data.element })
            setCount((value) => value + 1)
          } else if (data.ev === 'url') {
            invoke('browser-sync', { sessionId: sessionId, id: from, url: data.url, title: data.title })
            if (typeof data.url === 'string' && data.url !== '') {
              rememberUrl(data.url)
              pushHistory(data.url, data.title)
            }
            if (data.title) titleStore.set(tabId, data.title)
            // Show the page's own title and address immediately instead of
            // waiting for the next host round trip.
            setState((previous) => {
              if (previous === null) return previous
              return {
                activeId: previous.activeId,
                tabs: previous.tabs.map((tab) =>
                  tab.id === from
                    ? { ...tab, title: typeof data.title === 'string' ? data.title : tab.title, url: String(data.url ?? tab.url) }
                    : tab,
                ),
              }
            })
          } else if (data.ev === 'view') {
            invoke('browser-view', {
              sessionId: sessionId,
              id: from,
              zoom: data.zoom,
              deviceKey: data.deviceKey,
              landscape: data.landscape,
            })
          } else if (data.ev === 'navigate') {
            void call('browser-navigate', { id: from, url: data.url, preferredPort: portForUrl(data.url) })
          } else if (data.ev === 'openTab') {
            void call('browser-open', { url: data.url, newTab: true, preferredPort: portForUrl(data.url) })
          } else if (data.ev === 'needCredentials') {
            pushCredentials(from, String(data.origin ?? ''))
          } else if (data.ev === 'saveCredential') {
            setNotice('')
            setPendingLogin({
              origin: String(data.origin ?? ''),
              username: String(data.username ?? ''),
              password: String(data.password ?? ''),
            })
          }
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [call, pushCredentials, sessionId, tabId])

      var onSubmit = React.useCallback(
        (event) => {
          event.preventDefault()
          void openNew(url)
        },
        [openNew, url],
      )

      var onNewTab = React.useCallback(() => {
        void openNew(rememberedUrl())
      }, [openNew])

      var onSelect = React.useCallback(
        (id) => {
          if (state !== null && state.activeId === id) return
          void call('browser-select', { id: id })
        },
        [call, state],
      )

      var onClose = React.useCallback(
        (id) => {
          void call('browser-close', { id: id })
        },
        [call],
      )

      var onClear = React.useCallback(() => {
        invoke('context-clear', { sessionId: sessionId }).then(() => setCount(0))
      }, [sessionId])

      var dropHistory = React.useCallback((target) => {
        try {
          var list = readHistory().filter((entry) => entry.url !== target)
          if (list.length === 0) window.localStorage.removeItem(HISTORY_KEY)
          else window.localStorage.setItem(HISTORY_KEY, JSON.stringify(list))
        } catch (error) {
          /* storage can be unavailable */
        }
        setHistory(readHistory())
      }, [])

      var clearHistory = React.useCallback(() => {
        try {
          window.localStorage.removeItem(HISTORY_KEY)
        } catch (error) {
          /* storage can be unavailable */
        }
        setHistory([])
      }, [])

      var dropLogin = React.useCallback((origin) => {
        forgetCredential(origin)
        setLogins(readCredentials())
        setNotice(`已删除 ${hostOf(origin)} 的账号密码`)
        for (var id in framesRef.current) pushCredentials(id, origin)
      }, [pushCredentials])

      React.useEffect(() => {
        if (notice === '') return undefined
        var timer = setTimeout(() => setNotice(''), 2600)
        return () => clearTimeout(timer)
      }, [notice])

      if (state === null) {
        return h('div', { className: 'dsh-sb-pane' }, h('div', { className: 'dsh-sb-busy' }, '正在恢复浏览器…'))
      }

      if (state.tabs.length === 0) {
        return h(
          'div',
          { className: 'dsh-sb-pane' },
          h(
            'div',
            { className: 'dsh-sb-start' },
            h(
              'div',
              { className: 'dsh-sb-hero' },
              h('span', { className: 'dsh-sb-heroGlyph', 'aria-hidden': 'true' }, h(CrosshairGlyph, { size: 18 })),
              h(
                'div',
                { className: 'dsh-sb-heroText' },
                h('p', { className: 'dsh-sb-heroTitle' }, busy ? '正在打开…' : '打开一个网址开始'),
                h('p', { className: 'dsh-sb-heroHint' }, '在下面的记录里点一个，或者直接输入。'),
              ),
            ),
            h(
              'form',
              { className: 'dsh-sb-composer', onSubmit: onSubmit },
              h('input', {
                className: 'dsh-sb-input',
                type: 'text',
                spellCheck: false,
                autoComplete: 'off',
                placeholder: 'localhost:3000/admin',
                value: url,
                autoFocus: true,
                onChange: (event) => setUrl(event.target.value),
              }),
              h('button', { className: 'dsh-sb-open', type: 'submit', disabled: busy }, busy ? '打开中…' : '打开'),
            ),
            error === '' ? null : h('p', { className: 'dsh-sb-error' }, error),
            notice === '' ? null : h('p', { className: 'dsh-sb-notice' }, notice),
            history.length === 0
              ? null
              : h(
                  'section',
                  { className: 'dsh-sb-section' },
                  h(
                    'div',
                    { className: 'dsh-sb-sectionHead' },
                    h('span', null, '最近访问'),
                    h('button', { className: 'dsh-sb-sectionAction', type: 'button', onClick: clearHistory }, '清空'),
                  ),
                  h(
                    'div',
                    { className: 'dsh-sb-list' },
                    ...history.map((entry) =>
                      h(
                        'div',
                        { className: 'dsh-sb-item', key: entry.url },
                        h(
                          'button',
                          {
                            className: 'dsh-sb-itemMain',
                            type: 'button',
                            title: entry.title === '' ? entry.url : `${entry.title}\n${entry.url}`,
                            onClick: () => {
                              setUrl(entry.url)
                              void openNew(entry.url)
                            },
                          },
                          h('span', { className: 'dsh-sb-itemBadge', 'aria-hidden': 'true' }, h(GlobeGlyph, { size: 13 })),
                          h(
                            'span',
                            { className: 'dsh-sb-itemText' },
                            h(
                              'span',
                              { className: 'dsh-sb-itemTitle' },
                              entry.title === '' ? hostOf(originOf(entry.url)) : entry.title,
                            ),
                            h(
                              'span',
                              { className: 'dsh-sb-itemUrl' },
                              entry.title === '' ? pathOf(entry.url) : shortLabel(entry.url),
                            ),
                          ),
                        ),
                        h(
                          'button',
                          {
                            className: 'dsh-sb-itemX',
                            type: 'button',
                            title: '从最近访问中移除',
                            'aria-label': '从最近访问中移除',
                            onClick: () => dropHistory(entry.url),
                          },
                          '×',
                        ),
                      ),
                    ),
                  ),
                ),
            logins.length === 0
              ? null
              : h(
                  'section',
                  { className: 'dsh-sb-section' },
                  h(
                    'div',
                    { className: 'dsh-sb-sectionHead' },
                    h('span', null, '已保存的账号密码'),
                    h('span', { className: 'dsh-sb-sectionCount' }, String(logins.length)),
                  ),
                  h(
                    'div',
                    { className: 'dsh-sb-list' },
                    ...logins.map((entry) =>
                      h(
                        'div',
                        { className: 'dsh-sb-item', key: entry.origin },
                        h('span', { className: 'dsh-sb-itemBadge isKey', 'aria-hidden': 'true' }, h(KeyGlyph, { size: 12 })),
                        h(
                          'span',
                          { className: 'dsh-sb-itemText' },
                          h(
                            'span',
                            { className: 'dsh-sb-itemTitle' },
                            entry.username === '' ? hostOf(entry.origin) : entry.username,
                          ),
                          h('span', { className: 'dsh-sb-itemUrl' }, hostOf(entry.origin)),
                        ),
                        h(
                          'button',
                          {
                            className: 'dsh-sb-itemX',
                            type: 'button',
                            title: '忘记这个网站的账号密码',
                            'aria-label': '忘记这个网站的账号密码',
                            onClick: () => dropLogin(entry.origin),
                          },
                          '×',
                        ),
                      ),
                    ),
                  ),
                ),
            history.length === 0 && logins.length === 0
              ? h(
                  'p',
                  { className: 'dsh-sb-idleHint' },
                  '打开后点页面工具栏的「拾取」（或按 ` 键），再点页面上的元素，即可把它作为 ',
                  h('code', { className: 'dsh-sb-code' }, '[标签][DOMn]'),
                  ' 引用加入对话。登录过的网站会问你要不要保存账号密码，下次自动填。',
                )
              : null,
          ),
        )
      }

      var frames = state.tabs.map((tab) => {
        var visible = tab.id === state.activeId
        var pinned = sourcesRef.current[tab.id]
        if (pinned === undefined || pinned.port !== tab.port || pinned.nav !== tab.nav) {
          pinned = { port: tab.port, nav: tab.nav, src: shellUrl(tab) }
          sourcesRef.current[tab.id] = pinned
        }
        return h('iframe', {
          key: tab.id,
          ref: (element) => {
            framesRef.current[tab.id] = element
          },
          className: 'dsh-sb-frame',
          'data-hidden': visible ? 'false' : 'true',
          src: pinned.src,
          title: labelOfTab(tab),
          // Same-origin and scripts are what make the picker possible at all;
          // top navigation stays denied so a framed page cannot take the
          // harness window with it.
          sandbox:
            'allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-presentation',
        })
      })

      return h(
        'div',
        { className: 'dsh-sb-pane' },
        pendingLogin === null
          ? null
          : h(
              'div',
              { className: 'dsh-sb-savebar' },
              h('span', { className: 'dsh-sb-saveGlyph', 'aria-hidden': 'true' }, h(KeyGlyph, { size: 14 })),
              h(
                'div',
                { className: 'dsh-sb-saveText' },
                h('span', { className: 'dsh-sb-saveTitle' }, `保存 ${hostOf(pendingLogin.origin)} 的账号密码？`),
                h(
                  'span',
                  { className: 'dsh-sb-saveSub' },
                  pendingLogin.username === '' ? '未填用户名' : `账号：${pendingLogin.username}`,
                ),
              ),
              h('button', { className: 'dsh-sb-saveGo', type: 'button', onClick: () => acceptLogin(pendingLogin) }, '保存'),
              h('button', { className: 'dsh-sb-saveSkip', type: 'button', onClick: () => setPendingLogin(null) }, '不用'),
            ),
        notice === ''
          ? null
          : h('div', { className: 'dsh-sb-flash' }, h('span', { className: 'dsh-sb-saveGlyph', 'aria-hidden': 'true' }, h(KeyGlyph, { size: 12 })), notice),
        h(
          'div',
          { className: 'dsh-sb-strip' },
          h(
            'div',
            { className: 'dsh-sb-tabs' },
            state.tabs.map((tab) =>
              h(
                'button',
                {
                  key: tab.id,
                  type: 'button',
                  className: 'dsh-sb-tab',
                  'data-active': tab.id === state.activeId ? 'true' : 'false',
                  title: tab.url,
                  onClick: () => onSelect(tab.id),
                  onAuxClick: (event) => {
                    if (event.button === 1) onClose(tab.id)
                  },
                },
                h('span', { className: 'dsh-sb-tabTitle' }, labelOfTab(tab)),
                h(
                  'span',
                  {
                    className: 'dsh-sb-tabClose',
                    role: 'button',
                    'aria-label': '关闭标签页',
                    onClick: (event) => {
                      event.stopPropagation()
                      onClose(tab.id)
                    },
                  },
                  '×',
                ),
              ),
            ),
            h('button', { type: 'button', className: 'dsh-sb-newtab', title: '新建标签页', onClick: onNewTab }, '＋'),
          ),
          h(
            'div',
            { className: 'dsh-sb-stripTools' },
            h('span', null, count > 0 ? `已拾取 ${count}` : ''),
            count > 0
              ? h('button', { className: 'dsh-sb-link', type: 'button', onClick: onClear, title: '清空本对话的页面元素上下文' }, '清空')
              : null,
          ),
        ),
        h('div', { className: 'dsh-sb-frames' }, frames),
      )
    }

    /**
     * The strip chip: the picker's glyph plus the active page's title.
     * @param {object} props - the title seat's props.
     * @returns {object} the chip content.
     */
    function BrowserTabTitle(props) {
      var info = props.useTabInfo()
      var tabId = info.tab.id
      var subscribe = React.useCallback((listener) => titleStore.subscribe(listener), [])
      var snapshot = React.useCallback(() => titleStore.get(tabId), [tabId])
      var title = React.useSyncExternalStore(subscribe, snapshot)
      return h(
        React.Fragment,
        null,
        h(
          'span',
          { 'aria-hidden': 'true', style: { display: 'inline-flex', marginRight: 4, verticalAlign: '-2px' } },
          h(CrosshairGlyph, { size: 14 }),
        ),
        title === '' ? info.tab.title || TAB_TITLE : title,
      )
    }

    /**
     * Register both surfaces. The tab type waits for the registry service,
     * which the native seat provides a moment after it declares the slot.
     * @param {object} ctx - the client plugin context.
     */
    function apply(ctx) {
      migrateLegacyStorage()
      ensureStyles()
      service.context = ctx

      ctx.effect(
        () =>
          ctx.slots.inject('conversation.input.left', () =>
            ctx.slots.register(
              { name: 'conversation.input.left', id: PLUGIN_ID, order: 0 },
              PickerButton,
            ),
          ),
        'dsh-sidebar-browser: composer button',
      )

      var disposeRegistry = ctx.inject(['sidebarRightTabs'], (injected) => {
        var tabs = injected.get('sidebarRightTabs')
        if (tabs === undefined || tabs === null) return
        var disposeType = tabs.register({
          id: TYPE_ID,
          kind: KIND,
          priority: 'extension',
          title: () => TAB_TITLE,
          guide: [
            {
              order: 40,
              title: () => TAB_TITLE,
              description: () => '在侧边栏中浏览网页并拾取元素',
              icon: (iconProps) => h(CrosshairGlyph, { size: iconProps && iconProps.size ? iconProps.size : 16 }),
            },
          ],
        })
        var disposeBody = ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register(
            {
              name: 'sidebar.right.pane.tab',
              key: TYPE_ID,
              inject: (sessionId) => ({ sessionId: sessionId }),
            },
            BrowserPanel,
          ),
        )
        var disposeTitle = ctx.slots.inject('sidebar.right.pane.tab.title', () =>
          ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TYPE_ID }, BrowserTabTitle),
        )
        logInfo('侧边栏页签类型 browser 已注册')
        return () => {
          disposeTitle()
          disposeBody()
          disposeType()
        }
      })

      // Keep a handle on the navigation face for the composer button, which
      // lives outside the sidebar's seats and therefore never receives it.
      ctx.inject(['sidebarRight'], (injected) => {
        service.right = injected.get('sidebarRight')
        return () => {
          service.right = undefined
        }
      })

      ctx.effect(() => () => {
        disposeRegistry()
        service.context = undefined
        service.right = undefined
      }, 'dsh-sidebar-browser: tab type')
    }

    module.exports = {
      name: PLUGIN_ID,
      inject: ['slots'],
      apply: apply,
    }

    return module.exports
  },
})
