# awesome-dsh-plugin 条目（提交用）

dsh-market 的插件列表来自精选仓库
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)：
**投稿 = 往 `data/plugins/` 加一个 YAML 文件**（一个插件一个文件，两个 README 由脚本生成，不要手改）。
合并后站点与市场通常一天内自动收录。

## 1. 文件名

```
data/plugins/<owner>__<repo>.yml
```

本插件对应：

```
data/plugins/Gnatnaituy__dsh_sidebar_element_picker.yml
```

（`<repo>` 是 GitHub 仓库名 `dsh_sidebar_element_picker`（下划线），不是 npm 包名 `dsh-sidebar-element-picker`（连字符）。）

## 2. 文件内容

```yaml
url: https://github.com/Gnatnaituy/dsh_sidebar_element_picker
name: Gnatnaituy/dsh_sidebar_element_picker
category: browser
description:
  en: 'A browser panel in the right sidebar that opens a site through a per-origin loopback proxy and picks page elements into [label][DOMn] placeholders that the model reads with a tool, with tabs, page zoom, phone and tablet viewport preview, and saved logins.'
  zh: '在右侧栏里内嵌浏览器：每个目标源一个回环反向代理，点选页面元素生成 [标签][DOMn] 引用供模型用工具读取；另有多标签页、页面缩放、手机/平板视口预览与登录账号保存。'
```

要点：

- `url` 必须与仓库**完全一致**（`name` 是列表里显示的链接文字）。
- `category` 取 `browser`（列表里叫 “Browser & Web”，这个插件做的事正是它）。
- **只有 `description.en` 是必填**；`zh` 不写也行（维护者会补）。
- 描述里出现 ASCII 的 `: `（冒号加空格）必须加引号，否则 YAML 解析失败——上面两条已经加了。中文全角 `：` 无此问题。
- 描述会被**逐句对着代码核对**，所以不要写数字、不要写营销词。上面这句里每一项都能在仓库里找到：
  「右侧栏面板」= `lib/client.js` 注册 `sidebar.right.pane.tab`；
  「每个目标源一个回环反向代理」= `resources/proxy.js` + `lib/index.js` 的端口分配；
  「[标签][DOMn] 占位符 + 模型用工具读取」= 输入框插入与 `read_picked_element`；
  「多标签页 / 缩放 / 手机平板视口预览 / 保存登录」= 面板标签条、外壳工具栏与凭据存储。

## 3. 仓库侧的前置条件

| 要求 | 状态 |
|---|---|
| `package.json` 声明 `dsh.bundle` | ✅ 已有（`dsh.bundle.patch` → `cordis.patch.yml`） |
| 放 `cordis.patch.yml` | ✅ 已在仓库根 |
| 真实可用代码（非占位/纯 README） | ✅ |
| 仓库**创建满 1 天** | ⚠️ CI 自动检查，新仓库当天提交会被拒 |
| 仓库加 `dsh-plugin` topic | ⚠️ 待做（GitHub 仓库页 → About → Topics） |
| 描述属实 | ✅ 见上 |
| 一个 PR 最多 3 条 | ✅ 只提交 1 条 |

可选但推荐：

- **发 npm**：市场会显示下载量，预构建安装还能免掉 `allowBuilds` 构建授权。本项目**零运行时依赖、无构建步骤**，所以从源码装也很干净；发 npm 的唯一硬要求是 `package.json` 的 `repository` 必须指回被收录的仓库（否则两者不会关联）。**不要**在条目 YAML 里手写 `npm:` 字段，会被校验拒绝。
- **GitHub Release tarball**：只有当仓库无法从源码安装时才需要（本项目不需要）。
- **截图**：见 `screenshots.json`（仓库根），最多 8 张，相对路径、不能跳出插件目录。

## 4. 提 PR

```sh
# fork 之后
git clone https://github.com/<you>/awesome-dsh-plugin
cd awesome-dsh-plugin
git checkout -b add-dsh-sidebar-element-picker
cp /path/to/dsh_sidebar_element_picker/submission/Gnatnaituy__dsh_sidebar_element_picker.yml \
   data/plugins/Gnatnaituy__dsh_sidebar_element_picker.yml
git add data/plugins/Gnatnaituy__dsh_sidebar_element_picker.yml
git commit -m "Add dsh-sidebar-element-picker"
git push -u origin add-dsh-sidebar-element-picker
```

然后在 GitHub 上开 PR。CI 按顺序检查：条目数 → 从你的仓库读 `dsh.bundle` → 仓库年龄 → `awesome-lint` 与站点构建。失败会说明改什么，在同一个分支上推送修复即可，不用重开 PR。

## 5. 合并前自测（和 CI 等价）

```sh
# 干净 profile 里从 GitHub 安装，确认真的能装
dsh plugin --profile web add "github:Gnatnaituy/dsh_sidebar_element_picker#main"
dsh --profile web --dump-config | grep -A3 sidebar-element-picker
```

本地目录安装（等价路径）：

```sh
node tools/install-into-profile.mjs --dry-run
```
