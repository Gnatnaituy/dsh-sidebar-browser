/**
 * Undo {@link ./install-into-profile.mjs}: unmount the plugin, drop the
 * dependency and (optionally) re-enable the window-based picker it replaced.
 *
 * Usage: node tools/uninstall-from-profile.mjs [--profile <dir>] [--keep-legacy-disabled] [--dry-run]
 */
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const PACKAGE_NAME = 'dsh-sidebar-browser'
/** Names this package was installed under before the rename. */
const PREVIOUS_NAMES = ['dsh-sidebar-element-picker']
/** Every name this package answers to, current one first. */
const ALL_NAMES = [PACKAGE_NAME, ...PREVIOUS_NAMES]
const LEGACY_ENTRY_ID = 'webpage-element-picker'
const LEGACY_PACKAGE = 'dsh-webpage-element-picker'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const option = (name, fallback) => {
  const at = argv.indexOf(name)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}

const dshHome = process.env.DSH_HOME ?? join(homedir(), 'Library', 'Application Support', 'dsh-desktop', 'harness')
const profileDir = resolve(option('--profile', join(dshHome, 'profiles', option('--name', 'web'))))
const dryRun = flag('--dry-run')
const restoreLegacy = !flag('--keep-legacy-disabled')

/**
 * @param {string} message - progress line.
 */
const say = (message) => console.log(`${dryRun ? '[dry-run] ' : ''}${message}`)

if (!existsSync(join(profileDir, 'package.json'))) {
  console.error(`找不到 profile：${profileDir}`)
  process.exit(1)
}

// ------------------------------------------------------------------- unmount

// Read before the patch pass: deciding whether a re-enabled legacy entry is
// still installed needs it, and declaring it further down would be a TDZ error.
const manifestPath = join(profileDir, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

const patchPath = join(profileDir, 'cordis.patch.yml')
if (existsSync(patchPath)) {
  const patch = readFileSync(patchPath, 'utf8')
  const lines = patch.split('\n')
  const kept = []
  for (let i = 0; i < lines.length; i += 1) {
    // Drop the `- insert:` block whose row names this package, plus the comment
    // paragraph that explains it.
    if (/^\s*-\s*insert:\s*$/.test(lines[i])) {
      const block = [lines[i]]
      let j = i + 1
      while (j < lines.length && /^\s{4,}\S/.test(lines[j])) {
        block.push(lines[j])
        j += 1
      }
      const named = ALL_NAMES.find((name) => block.some((line) => line.includes(`name: ${name}`)))
      if (named !== undefined) {
        while (kept.length > 0 && /^\s*#/.test(kept[kept.length - 1])) kept.pop()
        say(`cordis.patch.yml -= 挂载 ${named}`)
        i = j - 1
        continue
      }
      kept.push(...block)
      i = j - 1
      continue
    }
    if (restoreLegacy && new RegExp(`^\\s*-\\s*id:\\s*${LEGACY_ENTRY_ID}\\s*$`).test(lines[i])) {
      // Re-enable it only when the old package is actually installed; a
      // dangling entry just makes the loader warn on every reload.
      const stillInstalled = manifest.dependencies[LEGACY_PACKAGE] !== undefined
      while (kept.length > 0 && /^\s*#/.test(kept[kept.length - 1])) kept.pop()
      if (stillInstalled) {
        kept.push(lines[i], '  disabled: false')
        say(`cordis.patch.yml: ${LEGACY_ENTRY_ID} 已恢复启用`)
      } else {
        say(`cordis.patch.yml: 删除失效的 ${LEGACY_ENTRY_ID} 条目`)
      }
      i += 1
      continue
    }
    kept.push(lines[i])
  }
  const next = `${kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '')}\n`
  if (!dryRun && next !== patch) writeFileSync(patchPath, next)
}

// ---------------------------------------------------------------- dependency

let changed = false
for (const name of ALL_NAMES) {
  if (manifest.dependencies !== undefined && manifest.dependencies[name] !== undefined) {
    delete manifest.dependencies[name]
    changed = true
    say(`dependencies -= ${name}`)
  }
  const bundles = manifest.dsh?.profile?.bundles
  if (Array.isArray(bundles) && bundles.includes(name)) {
    manifest.dsh.profile.bundles = bundles.filter((entry) => entry !== name)
    changed = true
    say(`dsh.profile.bundles -= ${name}`)
  }
}
if (changed && !dryRun) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

// ---------------------------------------------------------------------- link

for (const name of ALL_NAMES) {
  const target = join(profileDir, 'node_modules', name)
  if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
    say(`删除 ${target}`)
    if (!dryRun) rmSync(target, { recursive: true, force: true })
  }
}

say('完成。loader 会热卸载；硬刷新浏览器即可。')
