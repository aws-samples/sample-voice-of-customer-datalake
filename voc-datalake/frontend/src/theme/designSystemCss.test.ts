/**
 * Regression guards for two layout bugs jsdom cannot render:
 *  1. A z-index on Layout's <main> made a stacking context that trapped page
 *     modals (z-50) beneath the sidebar.
 *  2. `space-y-*` gave a dialog overlay rendered inside a list a margin, which
 *     shrank the fixed inset-0 backdrop and left an uncovered strip.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { at } from '@test/defined'

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8')
const css = read('../index.css')

/** Class string of ModalShell's outer `fixed inset-0` wrapper. */
function modalWrapperClass(): string {
  const m = /<div className="(fixed inset-0 [^"]*)"/.exec(read('../components/ModalShell/ModalShell.tsx'))
  if (m === null) throw new Error('ModalShell has no `fixed inset-0` wrapper')
  return at(m, 1)
}

/** Index of the `}` closing the block opened at `open` (or `source.length` when unclosed). */
function blockEnd(source: string, open: number): number {
  const state = { depth: 0 }
  const offset = source.slice(open).split('').findIndex((char) => {
    if (char === '{') state.depth += 1
    else if (char === '}') state.depth -= 1
    return char === '}' && state.depth === 0
  })
  return offset === -1 ? source.length : open + offset
}

/** Source text with every `@layer … { … }` block removed (brace-balanced). */
function unlayered(source: string): string {
  const at = source.indexOf('@layer')
  if (at === -1) return source
  const head = source.slice(0, at)
  const open = source.indexOf('{', at)
  const semi = source.indexOf(';', at)
  if (open === -1 && semi === -1) return head // a dangling `@layer`: nothing after it is a rule
  if (open === -1 || (semi !== -1 && semi < open)) return head + unlayered(source.slice(semi + 1)) // `@layer a, b;`
  return head + unlayered(source.slice(blockEnd(source, open) + 1))
}

describe('design-system CSS', () => {
  it('resets dialog-overlay margin outside any cascade layer so spacing utilities cannot shrink the backdrop', () => {
    expect(unlayered(css)).toMatch(/\.dialog-overlay\s*\{\s*margin:\s*0;?\s*\}/)
  })

  it('gives the ModalShell fixed wrapper m-0 so a space-y-* parent cannot shrink it', () => {
    // The overlay sits INSIDE this wrapper, so the overlay reset above is not
    // enough: a `space-y-6` page put 24px of margin-bottom on the wrapper.
    expect(modalWrapperClass().split(' ')).toContain('m-0')
  })

  it('keeps the ambient wash behind content via isolation instead of a z-index on <main>', () => {
    expect(css).toMatch(/\.app-ambient\s*\{\s*isolation:\s*isolate;?\s*\}/)
    expect(css).toMatch(/\.app-ambient::before\s*\{[^}]*z-index:\s*-1/)
  })

  it('does not give the Layout <main> a z-index (it would trap modals under the sidebar)', () => {
    const layout = read('../components/Layout/Layout.tsx')
    const main = /<main className="([^"]*)"/.exec(layout)
    expect(main).not.toBeNull()
    expect(main?.[1]).not.toMatch(/\bz-/)
  })

  it('stacks ModalShell above the assistant launcher, floating panel and fullscreen panel', () => {
    // At an equal z-50 the launcher (later in the DOM) painted over a dialog's
    // backdrop and stayed clickable behind an aria-modal dialog.
    const zOf = (source: string, anchor: RegExp): number => {
      const m = anchor.exec(source)
      const z = m === null ? null : /\bz-(?:\[(\d+)\]|(\d+))/.exec(m[0])
      if (z === null) throw new Error(`no z-index found for ${anchor.source}`)
      return Number(z.at(1) ?? z.at(2))
    }
    const modal = zOf(modalWrapperClass(), /.+/)
    const panel = read('../assistant/components/AssistantPanel.tsx')
    const assistant = [
      // The launcher is positioned inline (draggable, bubble/useLauncherPosition); its z-index is in the class.
      zOf(read('../assistant/components/AssistantRoot.tsx'), /'fixed z-50 [^']*'/),
      zOf(panel, /FLOATING_CARD = `[^`]*`/),
      zOf(panel, /fullscreen: '[^']*'/),
    ]
    for (const z of assistant) expect(modal).toBeGreaterThan(z)
  })

  it('defines the KiroCrew badge tones and none of the legacy badge names', () => {
    for (const tone of ['ok', 'warn', 'danger', 'muted', 'accent', 'info', 'aim']) {
      expect(css).toMatch(new RegExp(`\\.badge-${tone}\\s*\\{`))
    }
    expect(css).not.toMatch(/\.badge-(positive|negative|neutral|urgent)\b/)
  })

  it('styles rendered markdown with .md-content, not the (uninstalled) typography plugin classes', () => {
    expect(css).toMatch(/\.md-content\s+ul\s*\{\s*list-style:\s*disc/)
    expect(css).not.toMatch(/\.prose/)
  })
})

describe('app source', () => {
  const sources = import.meta.glob(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}'], { query: '?raw', import: 'default', eager: true })
  const entries = Object.entries(sources).filter((e): e is [string, string] => typeof e[1] === 'string')

  it('loads the app sources it scans', () => {
    expect(entries.length).toBeGreaterThan(100)
  })

  it.each([
    ['legacy badge classes', /\bbadge-(positive|negative|neutral|urgent)\b/],
    // A single-line quoted class string containing a prose token — not the
    // English word "prose" in comments, which never sits inside quotes here.
    ['typography-plugin classes', /['"`][^'"`\n]*(?<![\w-])prose(-sm|-headings:|-p:|-ul:|-li:)?(?![\w-])[^'"`\n]*['"`]/],
  ])('uses no %s', (_label, pattern) => {
    const offenders = entries.filter(([, text]) => pattern.test(text)).map(([path]) => path)
    expect(offenders).toStrictEqual([])
  })
})
