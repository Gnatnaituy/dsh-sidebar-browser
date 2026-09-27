/**
 * Find the DSH profile this plugin installs into.
 *
 * Two apps keep their profiles on one machine, in different Harness homes:
 *
 *   - **DeepSeek Harness** (`com.deepseek.dsh`, the app this plugin targets
 *     now): `~/.dsh`, whose bundled profile is `profiles/desktop`;
 *   - **DSH Desktop** (`io.dsh.desktop`, what the plugin shipped for first):
 *     `~/Library/Application Support/dsh-desktop/harness`, profile `web`.
 *
 * `--profile` / `--name` and `$DSH_PROFILE_DIR` / `$DSH_HOME` still win. The
 * probe is only what makes a bare `node tools/install-into-profile.mjs` land in
 * the right place on either app, preferring the current one.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Harness homes in probe order. `DSH_HOME` replaces this list with the one home
 * it names, so an explicit override is never second-guessed by another app.
 */
const HOMES = [
  {
    app: 'DeepSeek Harness',
    home: () => process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'),
    /** Profile names to try, best first: the app-owned profile, then `dsh web`. */
    profiles: ['desktop', 'web'],
  },
  {
    app: 'DSH Desktop',
    home: () => join(homedir(), 'Library', 'Application Support', 'dsh-desktop', 'harness'),
    profiles: ['web'],
  },
]

/**
 * Name the app a profile directory belongs to, by comparing it against every
 * known Harness home. An unrecognized directory (a `--profile` outside all of
 * them) is left unnamed rather than guessed at.
 * @param {string} dir - absolute profile directory.
 * @returns {string|undefined} the app's name.
 */
function appOf(dir) {
  for (const entry of HOMES) {
    if (dir.startsWith(`${join(entry.home(), 'profiles')}/`)) return entry.app
  }
  return undefined
}

/**
 * @param {{profile?: string, name?: string}} [options] - `--profile` (an exact
 * profile directory) and `--name` (a profile name under the Harness home).
 * @returns {{dir: string, home: string, app: string|undefined, initialized: boolean}}
 * the profile to use. `initialized` is false when no probed profile exists yet,
 * in which case `dir` is the preferred candidate: the caller reports it so the
 * person can start the app once and retry.
 */
export function locateProfile(options = {}) {
  const explicit = options.profile ?? process.env.DSH_PROFILE_DIR
  if (explicit !== undefined && explicit.trim() !== '') {
    const dir = resolve(explicit.trim())
    return { dir, home: resolve(join(dir, '..', '..')), app: appOf(dir), initialized: existsSync(join(dir, 'package.json')) }
  }

  const named = options.name?.trim()
  const homes = process.env.DSH_HOME?.trim() ? [HOMES[0]] : HOMES
  const candidates = homes.flatMap((entry) =>
    (named === undefined || named === '' ? entry.profiles : [named]).map((profile) => ({
      app: entry.app,
      home: entry.home(),
      dir: join(entry.home(), 'profiles', profile),
    })),
  )

  const found = candidates.find((candidate) => existsSync(join(candidate.dir, 'package.json')))
  return found === undefined ? { ...candidates[0], initialized: false } : { ...found, initialized: true }
}
