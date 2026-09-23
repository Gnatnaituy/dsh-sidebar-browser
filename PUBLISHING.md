# 发布到 dsh-market

先厘清三个容易混淆的东西：

| 名字 | 是什么 | 投稿去这里？ |
|---|---|---|
| [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) | **精选列表仓库**，插件条目的唯一数据源（`data/plugins/*.yml`） | ✅ **就是这里** |
| [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com) | 由上面的数据生成的目录站（每次市场打开时实时拉 `plugins.json`） | 自动收录 |
| [dsh-market](https://github.com/dsh-market/dsh-market) | **市场应用本身**（就是你现在装着的 `dshmarket`） | ❌ 明确不收条目 |

所以「发布到 dsh-market」的实际动作是：**把插件放进一个公开 GitHub 仓库，然后往 awesome-dsh-plugin 提一个 PR，加一个 YAML 文件。** 合并后站点和市场通常一天内自动收录。

---

## 0. 三步总览

```sh
# ① 代码已在 https://github.com/Gnatnaituy/dsh-sidebar-browser
# ② 身份信息已填好（见下"身份信息"）
# ③ 往 awesome-dsh-plugin 提 PR：data/plugins/Gnatnaituy__dsh-sidebar-browser.yml
```

提交用的 YAML 已经写好了两处副本：

- 正文可见：`submission/README.md`（含逐条对照说明）
- 可直接提交的条目：`submission/Gnatnaituy__dsh-sidebar-browser.yml`

---

## 1. 放进公开 GitHub 仓库

仓库里必须有这些（都已经在）：

```
package.json            ← 声明 dsh.bundle（这是"可被 dsh plugin add 安装"的依据）
cordis.patch.yml        ← 上面 dsh.bundle.patch 指向的文件，仓库根
lib/index.js            ← host 半
lib/client.js           ← client 半
resources/              ← 外壳页面 + 反向代理
screenshots.json        ← 市场详情页的截图清单（可选，但已生成）
assets/screenshot-*.png ← 上面引用的图
LICENSE / README.md
```

```sh
cd dsh-sidebar-browser
git init -b main
git add -A
git commit -m "dsh-sidebar-browser: sidebar browser with element picking"
git remote add origin git@github.com:Gnatnaituy/dsh-sidebar-browser.git
git push -u origin main
```

`.gitignore` 已经排除了 `backup/`（那是本机 profile 配置的备份，**不要推到公开仓库**）、`node_modules/`、以及预览脚本生成的临时图。

### 身份信息（已填好）

| 位置 | 当前值 |
|---|---|
| `package.json` 的 `repository` / `homepage` / `bugs` / `author` | `Gnatnaituy` / `dsh-sidebar-browser` |
| `LICENSE` 第 3 行 | `Copyright (c) 2026 Gnatnaituy` |
| `submission/Gnatnaituy__dsh-sidebar-browser.yml` 的 `url` / `name` | `https://github.com/Gnatnaituy/dsh-sidebar-browser` |

仓库名与 npm 包名是**同一个** `dsh-sidebar-browser`：仓库 URL、`repository` / `homepage` / `bugs`、条目文件名、`dsh plugin add` 的包名全用它。这是市场里的常规做法（4183 条里 4011 条仓库名带连字符，1382 条仓库名与包名完全一致）。

名字里唯一需要留意的分隔符是**条目文件名** `data/plugins/<owner>__<repo>.yml`：owner 与 repo 之间是**双下划线**，repo 自己带的是连字符，例如 `ParticleLight__dsh-browser-plus.yml`。本插件对应 `Gnatnaituy__dsh-sidebar-browser.yml`。

✅ **改名两面都已落地**：npm 包名与 GitHub 仓库名现在都是 `dsh-sidebar-browser`。改名当时做过（供换机器时参考）：

```sh
gh repo rename dsh-sidebar-browser --repo Gnatnaituy/dsh_sidebar_element_picker
git remote set-url origin https://github.com/Gnatnaituy/dsh-sidebar-browser.git
```

改名后本地目录也跟着改了名（`dsh_sidebar_element_picker` → `dsh-sidebar-browser`），profile 里的软链与 `link:` 依赖指向旧路径会直接失效，所以**目录改名后必须重跑 `node tools/install-into-profile.mjs` 并重启 DSH Desktop**，否则侧边栏浏览器面板会报 `ENOENT ... resources/chrome.html`。

`repository` 不是装饰：**如果你之后发了 npm，市场只会把 `repository` 指回被收录仓库的 npm 包关联起来**，指错了就没有下载量数字。

### 仓库设置

- ✅ **`dsh-plugin` topic 已有**（2026-09-23 核实：`cordis` / `deepseek-harness` / `dsh` / `dsh-plugin` / `element-picker` / `sidebar`）。这是列表的硬性要求，换仓库时记得补。
- 仓库**创建满 1 天**才能提交，CI 会自动检查。本仓库创建于 2026-09-23 19:15 +0800，所以**最早 9/24 19:15 +0800 之后**才不会被拒——把功能做完再来，重新提交不会有任何影响。

---

## 2. （可选，推荐）发 npm

好处：市场能显示下载量，且预构建安装免掉 `allowBuilds` 构建授权。

这个插件**零运行时依赖、没有构建步骤**，所以从源码安装本来就很干净；发 npm 只是让安装更快、多一个下载量数字。

```sh
npm pack --dry-run      # 先看会发什么：10 个文件、约 51KB
npm publish --access public
```

包内容由 `package.json` 的 `files` 白名单控制，已经收敛到运行时真正需要的文件（`lib/`、四个 `resources/*`、`cordis.patch.yml`、README、LICENSE）——测试套件、`docs/`、`backup/` 都不会进包。

⚠️ 不要往条目 YAML 里写 `npm:` 字段：映射由 CI 从 registry 自动采集，手写会被校验拒绝。

---

## 3. （可选）GitHub Release tarball

只有**仓库无法从源码安装**时才需要（本项目不需要）。若要用，`tarball:` 必须是 GitHub Release 托管的 `https` `.tgz`：

```yaml
tarball: https://github.com/Gnatnaituy/dsh-sidebar-browser/releases/latest/download/dsh-sidebar-browser.tgz
```

用 `latest/download/` 时**文件名不要带版本号**，否则下一次发版就 404。要带版本就把 tag 钉死。

---

## 4. 提 PR 到 awesome-dsh-plugin

```sh
git clone https://github.com/<you>/awesome-dsh-plugin
cd awesome-dsh-plugin
git checkout -b add-dsh-sidebar-browser

# 文件名必须是 <owner>__<repo>.yml
cp /path/to/dsh-sidebar-browser/submission/Gnatnaituy__dsh-sidebar-browser.yml \
   data/plugins/Gnatnaituy__dsh-sidebar-browser.yml

git add data/plugins/Gnatnaituy__dsh-sidebar-browser.yml
git commit -m "Add dsh-sidebar-browser"
git push -u origin add-dsh-sidebar-browser
```

然后开 PR。**只加这一个文件**：两个 README 由脚本从 `data/plugins/*.yml` 生成，手改会撞车，CI 也会要求重生成。

想预览自己那一行长什么样（可选，提交生成结果也接受，但必须与数据源一致）：

```sh
npm ci && node scripts/generate-readme.mjs
```

---

## 5. CI 会检查什么

按顺序：

1. **条目数** —— 一个 PR 最多 3 条（这里只提 1 条）。
2. **`dsh.bundle`** —— 从你仓库的 `package.json` 读取。**只声明 `dsh.client` 会在这里失败**（这是最常见的被拒原因）。本仓库两个都声明了，且 `bundle` 在前。
3. **仓库年龄** —— 满 1 天（本仓库创建于 2026-09-23 19:15 +0800，最早 **9/24 19:15 +0800** 之后提交）。
4. **`awesome-lint` 与站点构建** —— 双语一致性、分隔符、日期、截图。

失败会明确说明改什么，在**同一个分支**上推送修复即可。

---

## 6. 合并前自己验一遍

干净 profile 里从 GitHub 安装（和用户的安装路径一致）：

```sh
dsh plugin --profile web add "github:Gnatnaituy/dsh-sidebar-browser#main"
dsh --profile web --dump-config | grep -A4 sidebar-browser
```

期望看到一层 `# == dsh-sidebar-browser` 和一行 `id: sidebar-browser`，没有 `duplicate loader entry id`。

本地目录安装（开发时用）：

```sh
node tools/install-into-profile.mjs --dry-run
node tools/install-into-profile.mjs
```

运行时自测：

```sh
npm test              # 5 个套件里的 4 个，不需要浏览器
npm run test:browser  # 真 Chromium 端到端（需要 playwright-core，见下）
```

浏览器测试需要一个驱动：`npm i -D playwright-core`，或用 `DSH_TEST_CHROME=/path/to/chrome` 指向本机 Chrome。

---

## 7. 描述写作（会被逐句核对）

条目里那句英文/中文描述会被维护者**对着代码核对**，夸大是唯一会让一个本来不错的插件被打回的原因。当前描述里每一项的出处：

| 描述里的说法 | 代码位置 |
|---|---|
| 右侧栏里的浏览器面板 | `lib/client.js` 注册 `sidebar.right.pane.tab`（原生右侧栏 API） |
| 每个目标源一个回环反向代理 | `resources/proxy.js`、`lib/index.js` 的端口分配（`ensurePort`） |
| 点选元素生成 `[标签][DOMn]`，模型用工具读取 | 输入框插入 + `read_picked_element`（`lib/index.js`） |
| 多标签页 | 面板标签条 + host 侧的 `tabs`（`browser-open/select/close`） |
| 页面缩放 | 外壳工具栏 `chrome.js` 的 `applyView` |
| 手机/平板视口预览 | 同上（设备预设 + 旋转）；**只是视口**，不是完整设备仿真 |
| 保存登录账号 | 面板凭据存储 + 外壳自动填入 |

如果你改了功能，**回来改这一行**（编辑 `data/plugins/<owner>__<repo>.yml` 后重新生成 README）——不要顺手改别人的条目。

---

## 8. 截图

`screenshots.json`（仓库根）列出 1–8 张图，路径相对于该文件、不能以 `/` 开头、不能含 `..`。市场详情页用它，**不用提 PR 到列表仓库**——推自己仓库，下一次夜间构建自动生效。

重新生成（真渲染：真代理、真外壳、真 Chromium，不是画出来的）：

```sh
node tools/make-screenshots.mjs
```

当前三张：

1. 浏览器面板里正在拾取元素（工具行「拾取」已激活、目标元素被高亮并显示选择器）
2. 同一个页面切到 iPhone 15 Pro 393×852 视口后的重排效果
3. 启动页（最近访问 + 已保存的账号密码）

想换成你自己项目的截图（通常更好看），把文件放到 `assets/` 并改 `screenshots.json` 即可。

---

## 9. 收录之后

- 更新描述 / 换分类 / 加截图：改自己的 `data/plugins/<owner>__<repo>.yml` 再提 PR。
- 条目不是永久的：仓库消失、归档、长期停更会被定期扫描并在确认后移除。
- 收录**不等于**安全审查：列表和市场的 README 都明确写了这一点。这个插件会**摘掉被测站点的 CSP 与 `X-Frame-Options`** 才能把它框起来，也把登录密码存在浏览器 localStorage 里（明文）——这些都应该在 README 的「已知限制与信任边界」里写清楚，现在已经写了。
