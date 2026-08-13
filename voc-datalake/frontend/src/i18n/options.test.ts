/**
 * @fileoverview Gates on the i18n init options.
 *
 * These exist because the options moved out of `config.ts` into `options.ts` and
 * NOTHING imports `config.ts` in a test — it runs `init()` with an HTTP backend at
 * module scope. So every option in it was, and would remain, untested: drop
 * `supportedLngs` and the app still boots, just without the guard that rejects a
 * stale cached locale.
 *
 * The load-bearing one is the namespace list. A page that calls
 * `useTranslation('somewhere')` for a namespace absent from `ns` does not throw —
 * i18next resolves nothing and the page renders raw key paths. That is the same
 * failure this module's own history is made of (a relative key read through the
 * wrong namespace, and a data-held key invisible to the i18n gate), and
 * `scripts/i18n-check.mjs` cannot catch it: its own `NAMESPACES` array is a
 * separate hardcoded copy, so it validates keys against the namespaces IT knows,
 * never against the ones the app registers.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { I18N_INIT_OPTIONS } from './options'

const SRC = join(__dirname, '..')

/**
 * Drop comments before scanning.
 *
 * Not fussiness: this file's own docblocks discuss the shape of a translation key
 * (`xKey: 'ns:key'`), and a naive scan reads that prose as a namespace called `ns`
 * and reports the app as broken. `scripts/i18n-check.mjs` has the same blind spot
 * and warns about that exact comment.
 *
 * Block comments and whole-line comments only — a `//` inside a string literal (a
 * URL) is left alone, so no line of real code is truncated.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*')
    })
    .join('\n')
}

/** Every namespace the source asks `useTranslation` for, or addresses as `ns:key`. */
function namespacesReferencedInSource(): Set<string> {
  const found = new Set<string>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'test') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!['.ts', '.tsx'].includes(extname(entry))) continue
      // Test files are excluded deliberately: they address namespaces directly
      // (`t('feedbackForms:...')`) for assertions, which is not the app asking
      // i18next to load one.
      if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) continue
      const source = stripComments(readFileSync(full, 'utf-8'))
      for (const [, ns] of source.matchAll(/useTranslation\(\s*['"](\w+)['"]/g)) found.add(ns)
      for (const [, ns] of source.matchAll(/\bt\(\s*['"](\w+):/g)) found.add(ns)
      // Namespace-qualified keys held in data and passed to t() indirectly — the
      // shape SCORABLE_TYPE_META uses. Same extraction rule as i18n-check.mjs.
      for (const [, ns] of source.matchAll(/\b\w*[Kk]ey:\s*['"](\w+):[\w.]+['"]/g)) found.add(ns)
    }
  }
  walk(SRC)
  return found
}

describe('I18N_INIT_OPTIONS', () => {
  it('registers every namespace the app actually asks for', () => {
    const registered = new Set(I18N_INIT_OPTIONS.ns as string[])
    const referenced = namespacesReferencedInSource()

    // Guard against the scan silently finding nothing — a broken walk would make
    // the assertion below pass over an empty set.
    expect(referenced.size, 'the source scan found no namespaces at all')
      .toBeGreaterThan(5)
    expect(referenced.has('feedbackForms'), 'scan missed a known namespace').toBe(true)
    expect(referenced.has('prioritization'), 'scan missed the data-held namespace').toBe(true)

    const unregistered = [...referenced].filter((ns) => !registered.has(ns))
    expect(
      unregistered,
      'these namespaces are used in source but not in I18N_INIT_OPTIONS.ns — '
      + 'i18next will resolve nothing for them and the UI renders raw key paths',
    ).toEqual([])
  })

  it('keeps the options that are load-bearing rather than cosmetic', () => {
    // One assertion per behaviour, with the behaviour named: a bare snapshot of
    // this object would fail on any edit without saying what broke.
    expect(I18N_INIT_OPTIONS.fallbackLng, 'first visit must land on English').toBe('en')
    expect(
      I18N_INIT_OPTIONS.nonExplicitSupportedLngs,
      'must stay false, or a regional variant we do not ship can be selected',
    ).toBe(false)
    expect(
      (I18N_INIT_OPTIONS.supportedLngs as string[] | undefined)?.length,
      'without supportedLngs a stale localStorage value selects an unshipped locale',
    ).toBeGreaterThan(1)
    expect(
      I18N_INIT_OPTIONS.detection?.order,
      "detection must read ONLY the user's stored choice — 'navigator' is "
      + 'deliberately absent so a non-English browser still gets English',
    ).toEqual(['localStorage'])
    expect(I18N_INIT_OPTIONS.detection?.lookupLocalStorage).toBe('voc-language')
    expect(
      I18N_INIT_OPTIONS.interpolation?.escapeValue,
      'React escapes already; true would double-escape every interpolated value',
    ).toBe(false)
  })
})
