/**
 * Install this plugin into a DSH web profile.
 *
 * Deliberately not `dsh plugin add`: that runs pnpm, which re-resolves the
 * whole profile (including the GitHub and generation-linked dependencies) over
 * the network. This does the three things the profile actually needs, in place
 * and idempotently:
 *
 *   1. link the package into the profile's `node_modules`;
 *   2. list it in `dependencies` and in `dsh.profile.bundles` — the bundle form
 *      is the supported mount. A hand-written row in the profile's own
 *      `cordis.patch.yml` also loads, but the loader applies that file as a
 *      delta on reload and a re-applied insert leaves a stale duplicate entry
 *      behind (`duplicate loader entry id`), while bundle layers are rebuilt
 *      from scratch every time;
 *   3. disable the previous window-based picker when it is still installed,
 *      since it registers a tool of the same name.
 *
 * A bundle change is a boot-time change: DSH must be restarted. Client-only
 * edits afterwards need just a hard refresh.
 *
 * Usage: node tools/install-into-profile.mjs [--profile <dir>] [--copy] [--dry-run]
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, cpSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-sidebar-browser'
/**
 * Names this package was installed under before the rename from
 * `dsh-sidebar-element-picker`. A stale dependency, bundle row or link would
 * mount the same code twice and register `read_picked_element` twice, which the
 * tool registry refuses — so installing the renamed bundle has to sweep them.
 */
const PREVIOUS_NAMES = ['dsh-sidebar-element-picker']
/** The tool-name rival this plugin replaces, if it is still installed. */
const LEGACY_PACKAGE = 'dsh-webpage-element-picker'
const LEGACY_ENTRY_ID = 'webpage-element-picker'
/** Insert the bundle row after the web app, so UI plugins stay grouped. */
const BUNDLE_AFTER = '@deepseek-ai/dsh-web-app'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const option = (name, fallback) => {
  const at = argv.indexOf(name)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}

const dshHome = process.env.DSH_HOME ?? join(homedir(), 'Library', 'Application Support', 'dsh-desktop', 'harness')
const profileDir = resolve(
  option('--profile', process.env.DSH_PROFILE_DIR ?? join(dshHome, 'profiles', option('--name', 'web'))),
)
const dryRun = flag('--dry-run')
const copy = flag('--copy')

/**
 * @param {string} message - progress line.
 */
const say = (message) => console.log(`${dryRun ? '[dry-run] ' : ''}${message}`)

/**
 * Remove one `- id:` patch entry together with the comment paragraph that
 * documents it (comments may be separated from the entry by a blank line).
 * @param {string} text - the patch file's contents.
 * @param {string} id - the entry id to drop.
 * @returns {string} the patch without that entry.
 */
function dropEntry(text, id) {
  const lines = text.split('\n')
  const at = lines.findIndex((line) => new RegExp(`^\\s*-\\s*id:\\s*${id}\\s*$`).test(line))
  if (at < 0) return text
  let end = at + 1
  while (end < lines.length && /^\s{2,}\S/.test(lines[end])) end += 1
  let start = at
  while (start > 0 && (lines[start - 1].trim() === '' || /^\s*#/.test(lines[start - 1]))) start -= 1
  lines.splice(start, end - start)
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '')}\n`
}

if (!existsSync(join(profileDir, 'package.json'))) {
  console.error(`找不到 profile：${profileDir}（先启动一次 DSH 让它初始化）`)
  process.exit(1)
}
say(`profile: ${profileDir}`)
say(`source:  ${projectRoot}`)

// ------------------------------------------------------------------ 1. link

for (const previous of PREVIOUS_NAMES) {
  const stale = join(profileDir, 'node_modules', previous)
  if (existsSync(stale) || lstatSync(stale, { throwIfNoEntry: false }) !== undefined) {
    say(`删除旧包链接 ${stale}`)
    if (!dryRun) rmSync(stale, { recursive: true, force: true })
  }
}

const target = join(profileDir, 'node_modules', PACKAGE_NAME)
if (dryRun) {
  say(`会${copy ? '复制' : '软链'}到 ${target}`)
} else {
  mkdirSync(dirname(target), { recursive: true })
  if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
    rmSync(target, { recursive: true, force: true })
  }
  if (copy) {
    cpSync(projectRoot, target, {
      recursive: true,
      filter: (source) => !source.includes('/backup') && !source.includes('/.git') && !source.includes('/docs'),
    })
    say(`已复制到 ${target}`)
  } else {
    symlinkSync(projectRoot, target, 'dir')
    say(`已软链 ${target} → ${projectRoot}`)
  }
}

// ---------------------------------------------------- 2. dependency + bundle

const manifestPath = join(profileDir, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.dependencies = manifest.dependencies ?? {}
manifest.dsh = manifest.dsh ?? {}
manifest.dsh.profile = manifest.dsh.profile ?? {}

const dependencySpec = copy ? `file:${target}` : `link:${projectRoot}`
let manifestChanged = false

for (const previous of PREVIOUS_NAMES) {
  if (manifest.dependencies[previous] !== undefined) {
    delete manifest.dependencies[previous]
    manifestChanged = true
    say(`dependencies -= ${previous}（改名前的包名）`)
  }
}

if (manifest.dependencies[PACKAGE_NAME] !== dependencySpec) {
  manifest.dependencies[PACKAGE_NAME] = dependencySpec
  manifestChanged = true
  say(`dependencies += ${PACKAGE_NAME}: ${dependencySpec}`)
} else {
  say(`dependencies 已包含 ${PACKAGE_NAME}`)
}

const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
for (const previous of PREVIOUS_NAMES) {
  if (!bundles.includes(previous)) continue
  while (bundles.includes(previous)) bundles.splice(bundles.indexOf(previous), 1)
  manifestChanged = true
  say(`dsh.profile.bundles -= ${previous}（改名前的包名）`)
}
if (!bundles.includes(PACKAGE_NAME)) {
  const at = bundles.indexOf(BUNDLE_AFTER)
  if (at >= 0) bundles.splice(at + 1, 0, PACKAGE_NAME)
  else bundles.push(PACKAGE_NAME)
  manifestChanged = true
  say(`dsh.profile.bundles += ${PACKAGE_NAME}`)
} else {
  say(`dsh.profile.bundles 已包含 ${PACKAGE_NAME}`)
}
manifest.dsh.profile.bundles = bundles

if (manifestChanged && !dryRun) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

// ---------------------------------------------------------------- 3. the patch

const patchPath = join(profileDir, 'cordis.patch.yml')
let patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
let patchChanged = false

// A hand-mounted row from an earlier revision of this installer must go: it
// would collide with the row the bundle contributes. That includes a row naming
// the package's pre-rename name.
const insertStart = patch.indexOf('\n# 侧边栏浏览器 + 元素拾取')
if (insertStart >= 0) {
  const nextEntry = patch.indexOf('\n- id:', insertStart + 1)
  const insertBlock = nextEntry < 0 ? patch.slice(insertStart) : patch.slice(insertStart, nextEntry)
  if (insertBlock.includes(PACKAGE_NAME) || PREVIOUS_NAMES.some((name) => insertBlock.includes(name))) {
    patch = `${patch.slice(0, insertStart)}${nextEntry < 0 ? '' : patch.slice(nextEntry)}`
    patchChanged = true
    say('cordis.patch.yml -= 手写的挂载行（改由 bundle 层提供）')
  }
}

const legacyInstalled = manifest.dependencies[LEGACY_PACKAGE] !== undefined || bundles.includes(LEGACY_PACKAGE)
const legacyEntry = new RegExp(`^\\s*-\\s*id:\\s*${LEGACY_ENTRY_ID}\\s*$`, 'm')
if (legacyInstalled && !legacyEntry.test(patch)) {
  patch =
    `${patch.replace(/\s*$/, '')}\n\n` +
    '# 元素拾取已由侧边栏浏览器接管。\n' +
    '# 旧版会另开一个 Chrome 窗口，且注册了同名的 read_picked_element 工具；\n' +
    '# 想恢复旧版：把这里改成 false，并停用新插件。\n' +
    `- id: ${LEGACY_ENTRY_ID}\n  disabled: true\n`
  patchChanged = true
  say(`cordis.patch.yml += 停用 ${LEGACY_ENTRY_ID}`)
} else if (legacyEntry.test(patch) && !legacyInstalled) {
  patch = dropEntry(patch, LEGACY_ENTRY_ID)
  patchChanged = true
  say(`cordis.patch.yml -= 失效的 ${LEGACY_ENTRY_ID} 条目（旧版已不在 profile 中）`)
} else {
  say(legacyInstalled ? `cordis.patch.yml 已停用 ${LEGACY_ENTRY_ID}` : '旧版未安装，无需停用条目')
}

if (patchChanged && !dryRun) writeFileSync(patchPath, patch.replace(/\n{3,}/g, '\n\n'))

say(manifestChanged ? 'package.json 已更新' : 'package.json 无变化')
say('完成。bundle 属于启动期配置：请重启 DSH Desktop；之后只改 client 半时硬刷新即可。')
