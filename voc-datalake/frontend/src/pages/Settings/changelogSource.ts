/**
 * @fileoverview Lazily loads the repo-root CHANGELOG.md as text.
 *
 * A dynamic import of the virtual module `changelogPlugin.ts` serves: Vite
 * emits it as its own hashed, same-origin JS chunk that is fetched only when
 * the Version tab opens, so it never weighs on the main bundle or the Settings
 * chunk, and no CSP or `public/` asset change is needed. Its own module so
 * specs can stub the boundary.
 *
 * @module pages/Settings/changelogSource
 */

export async function loadChangelog(): Promise<string> {
  const module = await import('virtual:changelog.md?raw')
  return module.default
}
