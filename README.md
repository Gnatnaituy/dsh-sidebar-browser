# dsh-sidebar-browser

DSH（DeepSeek Harness）动态插件：**一个长在右侧栏里的浏览器，元素拾取是它的一项能力**。多标签页、缩放、手机/平板视口、记住账号密码，页面就在侧栏里跑。需要时点「拾取」再点页面上的任意元素，元素就以 `[标签][DOMn]` 进入输入框，完整信息由模型通过 `read_picked_element` 工具按需读取。

<img src="assets/screenshot-1.png" width="320" alt="在侧边栏浏览器里拾取元素：目标元素被高亮并显示 CSS 选择器"> <img src="assets/screenshot-2.png" width="320" alt="同一个页面切到 iPhone 15 Pro 视口后的重排效果">

## 原理

浏览器不允许跨源读取 iframe，而拾取必须读到目标页面的 DOM。所以插件在 loopback 上为每个「对话 + 目标源」开一个**反向代理端口**，把它当作目标站点的「同源替身」：外壳页面（工具栏 + 高亮框 + 拾取逻辑）与被测页面同源，于是能直接读 `contentDocument`、悬浮高亮、点击拦截、快照元素；这个源又和 DSH GUI 不同源，被测页面因此碰不到 GUI 的 DOM，也无法用 `window.top` 导航走 GUI。

代理把整个源映射到目标站点的根（**不改写 URL**，用 `location.origin` 拼绝对地址的应用照常工作），原样隧道转发 `Upgrade`（Vite / Next 热更新可用），只动框架相关响应头：摘掉 `X-Frame-Options` / CSP、去掉 `Set-Cookie` 的 `Domain`、把指向目标源的绝对 `Location` 改回本端口。同源多标签共用一个端口，异源各自一个，**cookie 与 localStorage 不会在站点之间串**。

## 特性

| 特性 | 说明 |
|---|---|
| 多标签页 | 标签条跟随页面标题；`＋` 新建、`×`/中键关闭；`target="_blank"`、`window.open`、外链都变成新标签页而不是逃出代理 |
| 页面不会丢 | 标签状态由 host 持有，所有 iframe 始终挂载（切标签只换可见性），iframe 地址钉在产生它的那次导航上——拾取、标题变化这类重渲染不会重载页面 |
| 重启后还原 | 标签、地址、缩放、设备预览镜像到 localStorage，DSH 重启后自动恢复（页面本身会重新加载） |
| 缩放 25%–300% | 按 `宽度/缩放` 布局再整体 transform，媒体查询按缩放后的宽度生效，和真实浏览器缩放一致，不是拉伸模糊 |
| 手机 / 平板视口 | Galaxy S23、iPhone SE / 15 Pro / 15 Pro Max、Pixel 8、iPad mini / Air / Pro 11"，可横竖屏；页面拿到真实的窄视口，`@media` 真的命中 |
| 原生侧边栏页签 | 注册为右侧栏 `browser` 页签，与文件/终端/Git 并列，无第三方依赖 |
| 输入框入口 | 工具行十字图标：浏览器为空时打开记忆中的地址，否则只把面板唤到前面，**绝不会导航走你正在编辑的页面** |
| 记住账号密码 | 登录提交后像浏览器一样问「保存 localhost:8081 的账号密码？」，之后打开该站点自动填入（触发 `input`/`change`，React/Vue 受控表单也认）；SPA 可用工具栏钥匙按钮手动保存 |
| 端口记忆 | 每个目标源记住上次用的端口并优先复用，应用自己存在 localStorage / IndexedDB 里的登录态不会因为重启换端口而失效 |
| 拾取 | 点击即插入 `[标签][DOMn]`（同一次拾取去重）；完整信息含 HTML、CSS 选择器、DOM 路径、全部属性、坐标与尺寸、关键计算样式、页面 URL 及拾取时的视口尺寸 |
| 不注入被测页面 | 高亮框画在外壳里，被测 DOM 一个节点都不加；工具栏「拾取」或页面内 `` ` `` 启停，`Esc` 退出 |
| 地址栏容错 | `localhost:3000/admin` 这种不带协议的写法会被当成主机与端口；`mailto:` / `file:` 之类才拒绝 |
| 按需启停 | 端口在被打开时才分配，插件加载本身不开任何端口 |

## 安装

已装在 `web` profile 上。重装或换机器：

```sh
node tools/install-into-profile.mjs --dry-run   # 先看要改什么
node tools/install-into-profile.mjs             # 幂等：软链 + link: 依赖 + bundle 挂载
node tools/uninstall-from-profile.mjs           # 卸载 / 回退
```

脚本还会清掉改名前的旧包名残留（本包以前叫 `dsh-sidebar-element-picker`），并把旧的窗口版拾取器（`dsh-webpage-element-picker`）置为 `disabled`——它注册同名的 `read_picked_element`，不能并存。

**为什么用 bundle 挂载**：手写进 profile 的 `cordis.patch.yml` 也能加载，但 loader 把它当增量应用，同一个 `insert` 行重复应用会留下陈旧条目并报 `duplicate loader entry id`；bundle 层每次重载都从零重建。代价是它属于**启动期配置**：

```sh
# 改完 host 半（lib/index.js）：重启 DSH Desktop
# 只改 client 半（lib/client.js、resources/*）：硬刷新浏览器
# 只改 resources/（外壳页面）：新开一个标签页或换源，下一个代理端口生效
```

⚠️ **目录改名后必须重跑安装脚本并重启**：profile 里的软链与 `link:` 依赖会指向旧路径，面板报 `ENOENT ... resources/chrome.html`。

## 使用

1. 点输入框工具行的十字图标 → 右侧栏打开「浏览器」页签；还没有页面时直接打开上次的地址。
2. 地址栏输入回车换页；`＋` 开新标签，`×` 或中键关闭，点标签切换（不重载）。
3. `− / 100% / + / ⤢` 缩放；设备下拉切手机 / 平板视口，`↻` 横竖屏。
4. 点「拾取」或按 `` ` ``，划过元素出现高亮与选择器提示，点击即插入 `[提交订单][DOM1]`。
5. 继续提问（如「把 [提交订单][DOM1] 改成红色」）；模型需要细节时调用 `read_picked_element`。登录场景先按 `` ` `` 退出拾取模式。

只有从没用过、或把所有标签页都关掉时才会看到启动页（网址输入 + 最近访问 + 已保存的账号密码）。

## 校验

```sh
npm test                                            # 四个套件，不需要 DSH、不需要浏览器
npm i -D playwright-core && npm run test:browser    # 真 Chromium 跑完整流程（或设 DSH_TEST_CHROME 指向本机 Chrome）
```

需要目标站点的套件默认起自带的 fixture 站点（`resources/test/fixture.mjs`，故意带难缠响应头），所以不依赖你本机跑着什么；想打真实站点就把地址作为第一个参数传入，例如 `node resources/test/proxy-smoke.mjs http://localhost:3000`。

| 套件 | 覆盖 |
|---|---|
| `proxy-smoke.mjs` | 外壳资源、能力 cookie 门禁、目标文档与子资源代理、`frame-ancestors` 摘除、pick 接收 |
| `tunnel-smoke.mjs` | 裸 socket 跑 `Upgrade`：101 握手、`Host` 改写、`Sec-WebSocket-Accept`、双向字节 |
| `host-smoke.mjs` | `/invoke` 全部方法、标签增删改选、同源共端口 / 异源分端口 / 关闭释放、快照还原、`read_picked_element` |
| `client-smoke.mjs` | 装载与页签槽位注册、空则开页、启动页时机、切标签与拾取后不重载、缩放设备随 URL 还原、拾取去重写入草稿 |
| `browser-e2e.mjs` | 上面全部在真 Chromium 里跑通：视口 / 横竖屏 / 缩放、同异源导航分流、手机视口下高亮与拾取、登录自动填入、密码框在元素记录中被抹除 |

`npm run preview:start` 把启动页渲染成一张图（改样式时看效果）；`npm run screenshots` 生成上架截图。

## 结构

```
lib/index.js        host 半：每个对话的浏览器状态 / 代理端口 / 上下文 / 工具 / 系统提示 / /invoke
lib/client.js       client 半：输入框按钮 + 原生 browser 页签（标签条 + 每标签一个 iframe）
resources/proxy.js  每个（对话, 目标源）一个 loopback 反向代理（含 Upgrade 隧道）
resources/chrome.*  浏览器外壳（工具栏 / 缩放 / 设备预览 / 同源拾取），由代理在自身源上提供
resources/test/     五个套件 + fixture 目标站点 + 启动页预览
tools/              幂等安装与卸载
docs/research/      动手前对 DSH 侧边栏 / 宿主 / 旧插件的逐项考证
```

## 已知限制与信任边界

- **同源既是拾取的前提，也是信任边界**：被测页面理论上能访问外壳页面，也就能伪造一次「拾取」把内容推进对话上下文。**只浏览你自己信任的页面。**
- 保存的账号密码是 **DSH GUI 源 localStorage 里的明文**（这里没有系统钥匙串），按目标源一一对应；不发往 host、不进对话、不出现在拾取结果里（密码框 `value` 被显式抹除）。
- 代理会摘掉被测页面的 CSP 与 `X-Frame-Options`——这正是原本不能被框的站点现在能被框的原因，也意味着**页面的安全策略在侧栏里不生效**。
- 设备预览是**视口预览**：媒体查询、布局、滚动按设备尺寸生效，但 `devicePixelRatio`、`pointer: coarse`、`hover: none`、User-Agent、触摸事件仍是桌面浏览器的。
- GUI 需跑在 `localhost` / `127.0.0.1`（DSH Desktop 默认）；从别的机器打开 GUI 时面板拿不到本机端口。
- 一个对话里的 `browser` 页签按 kind 唯一，所以浏览器面板同时只有一个，标签页在面板内部。
- 元素按「光标下最内层元素」命中，高亮会先告诉你要选的是哪一层；嵌套 iframe 内部的元素暂不支持。
- DSH 重启后页面会重新加载（地址 / 标签 / 缩放 / 视口还原），重启前未提交的表单内容不保留。

## 发布

投稿目标是精选列表 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)：往 `data/plugins/` 加一个 YAML 条目（`submission/` 里已备好），市场和 [dsh-market](https://github.com/dsh-market/dsh-market) 会在一天内自动收录。完整步骤见 [`PUBLISHING.md`](PUBLISHING.md)。

## License

MIT
