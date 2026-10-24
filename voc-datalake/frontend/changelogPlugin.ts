/**
 * Vite plugin: serves the repo-root CHANGELOG.md as the module
 * `virtual:changelog.md?raw` (a string default export) for the
 * Administration > Version tab.
 *
 * A virtual module rather than a relative `../../CHANGELOG.md?raw` import:
 * the file sits outside the frontend root, and letting Vite load it directly
 * would need `server.fs.allow` widened to the whole repo in dev and tests.
 * The `?raw` suffix only borrows vite/client's `*?raw` typing; the id is
 * resolved here before Vite's own raw loader sees it. Imported dynamically,
 * it becomes its own lazily-fetched, same-origin chunk.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

const PUBLIC_ID = 'virtual:changelog.md?raw'
const RESOLVED_ID = '\0voc-changelog'
const CHANGELOG_PATH = fileURLToPath(new URL('../../CHANGELOG.md', import.meta.url))

export function changelogPlugin(): Plugin {
  return {
    name: 'voc-changelog',
    enforce: 'pre',
    resolveId(id) {
      return id === PUBLIC_ID ? RESOLVED_ID : null
    },
    load(id) {
      if (id !== RESOLVED_ID) return null
      this.addWatchFile(CHANGELOG_PATH)
      return `export default ${JSON.stringify(readFileSync(CHANGELOG_PATH, 'utf8'))}`
    },
  }
}
