/**
 * Links are underlined, not just coloured (E2E F7, axe `link-in-text-block`).
 *
 * The app used `text-accent-text hover:underline` for links, so at rest a link
 * differed from the sentence around it by hue alone (WCAG 1.4.1). The shared
 * `.link` class underlines always; this pins the class and bans the hover-only
 * spelling from coming back anywhere in the app.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = resolve(__dirname, '..')
const css = readFileSync(join(SRC, 'index.css'), 'utf8')

/** Every non-test .tsx/.ts file under src. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

describe('.link', () => {
  it('underlines at rest, not only on hover', () => {
    const rule = /\n {2}\.link \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(rule).toContain('text-decoration-line: underline')
    expect(rule).toContain('color: var(--accent-text)')
  })

  it('is never replaced by a hover-only underline in a class string', () => {
    const offenders = sourceFiles(SRC).filter((path) => /"[^"\n]*\bhover:underline\b[^"\n]*"|'[^'\n]*\bhover:underline\b[^'\n]*'/.test(readFileSync(path, 'utf8')))
    expect(offenders.map((path) => relative(SRC, path))).toStrictEqual([])
  })

  it('is what the two links axe flagged now use', () => {
    const uses = (file: string) => readFileSync(join(SRC, file), 'utf8')
    expect(uses('pages/Account/ProfileSections.tsx')).toMatch(/<Link to="\/connect" className="link">/)
    expect(uses('pages/Settings/IntegrationsSection.tsx')).toMatch(/<Link to="\/connect" className="link">/)
  })
})
