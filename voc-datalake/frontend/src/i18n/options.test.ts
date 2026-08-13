/**
 * @fileoverview Gates on the i18n init options, and on the namespace list in
 * particular.
 *
 * These exist because the options moved out of `config.ts` into `options.ts` and
 * NOTHING imports `config.ts` in a test — it runs `init()` with an HTTP backend at
 * module scope. So every option in it was, and would have remained, untested: drop
 * `supportedLngs` and the app still boots, just without the guard that rejects a
 * stale cached locale.
 *
 * The load-bearing one is the namespace list. A page that calls
 * `useTranslation('somewhere')` for a namespace absent from `ns` does not throw —
 * i18next resolves nothing and the page renders raw key paths. That is the same
 * failure this module's history is made of, and `scripts/i18n-check.mjs` cannot
 * catch it: its own `NAMESPACES` array is a separate hardcoded copy, so it
 * validates keys against the namespaces IT knows, never against the ones the app
 * registers.
 *
 * The reference for "which namespaces exist" is the shipped catalogue files, not
 * any of the four hardcoded lists — a namespace IS a catalogue.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import i18n from 'i18next'
import { I18N_INIT_OPTIONS } from './options'

const SRC = join(__dirname, '..')
const FRONTEND = join(SRC, '..')
const LOCALES_EN = join(FRONTEND, 'public', 'locales', 'en')
const SCRIPTS = join(FRONTEND, 'scripts')

/** The namespaces actually shipped: one catalogue file each. */
function shippedNamespaces(): string[] {
  return readdirSync(LOCALES_EN)
    .filter((f) => extname(f) === '.json')
    .map((f) => basename(f, '.json'))
    .sort()
}

/**
 * Parse a `const NAME = ['a', 'b']` array literal out of a script.
 *
 * Throws rather than returning empty on a miss: an unparsed list would make every
 * comparison below trivially pass.
 */
function arrayLiteral(file: string, variable: string): string[] {
  const text = readFileSync(file, 'utf-8')
  const match = new RegExp(`${variable}\\s*=\\s*\\[([^\\]]*)\\]`, 's').exec(text)
  if (!match) throw new Error(`${basename(file)}: could not find the ${variable} array`)
  const items = [...match[1].matchAll(/['"](\w+)['"]/g)].map((m) => m[1])
  if (items.length === 0) throw new Error(`${basename(file)}: ${variable} parsed as empty`)
  return items.sort()
}

/**
 * Drop comments before scanning.
 *
 * Not fussiness: a docblock in `ValidationLinkPicker.tsx` discusses the shape of a
 * translation key (`xKey: 'ns:key'`), and a naive scan reads that prose as a
 * namespace called `ns` and reports the app as broken. It did, on the first run.
 * `scripts/i18n-check.mjs` has the same blind spot and warns about that comment.
 *
 * Block comments are stripped only where `/*` opens the line, so a `/*` inside a
 * string or regex literal cannot pair with a later `*␘/` and delete real code
 * between them — that would be a false negative, the worse direction for a gate.
 */
function stripComments(source: string): string {
  const lines = source.split('\n')
  const kept: string[] = []
  let inBlock = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false
      continue
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true
      continue
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
    kept.push(line)
  }
  return kept.join('\n')
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'test' || entry.name === '__tests__') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      sourceFiles(full, acc)
      continue
    }
    if (!['.ts', '.tsx'].includes(extname(entry.name))) continue
    // Tests address namespaces directly for their assertions, which is not the app
    // asking i18next to load one.
    if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue
    acc.push(full)
  }
  return acc
}

/**
 * Every namespace the app asks i18next for, and how many files were read to find
 * them (returned so a broken walk cannot look like a clean result).
 *
 * Forms understood:
 *   useTranslation('ns')            — single string
 *   useTranslation(['a', 'b'])      — array, which IS used (Categories/FeedbackResults)
 *   t('ns:key')                     — qualified key
 *   somethingKey: 'ns:key'          — namespace-qualified key held in data
 *
 *   tr('ns:key')                    — where `t` was renamed (`{ t: tr }`), which
 *                                     Chat.tsx does; the alias is resolved per file
 *                                     rather than banned, since a bare key through a
 *                                     renamed `t` is perfectly correct
 *
 * The one form that cannot be resolved statically — a namespace passed as a variable
 * or template literal — is asserted absent by a test below rather than left as a
 * silent blind spot.
 */
function scanSource(): { namespaces: Set<string>; filesScanned: number } {
  const namespaces = new Set<string>()
  const files = sourceFiles(SRC)
  for (const file of files) {
    const source = stripComments(readFileSync(file, 'utf-8'))
    for (const [, ns] of source.matchAll(/useTranslation\(\s*['"](\w+)['"]/g)) namespaces.add(ns)
    for (const [, list] of source.matchAll(/useTranslation\(\s*\[([^\]]*)\]/g)) {
      for (const [, ns] of list.matchAll(/['"](\w+)['"]/g)) namespaces.add(ns)
    }
    for (const [, ns] of source.matchAll(/\b\w*[Kk]ey:\s*['"](\w+):[\w.]+['"]/g)) namespaces.add(ns)

    // `t` plus every name `t` was renamed to in this file, so a qualified key
    // reached through an alias is not invisible.
    const callers = new Set(['t'])
    for (const [, alias] of source.matchAll(/\bt\s*:\s*(\w+)/g)) callers.add(alias)
    for (const caller of callers) {
      const qualified = new RegExp(`\\b${caller}\\(\\s*['"](\\w+):`, 'g')
      for (const [, ns] of source.matchAll(qualified)) namespaces.add(ns)
    }
  }
  return { namespaces, filesScanned: files.length }
}

describe('I18N_INIT_OPTIONS', () => {
  it('registers every namespace the app actually asks for', () => {
    const registered = new Set(I18N_INIT_OPTIONS.ns as string[])
    const { namespaces, filesScanned } = scanSource()

    // Liveness, structural rather than by name: a walk that silently returns
    // nothing would make the assertion below pass over an empty set. Names are
    // deliberately not pinned here — a legitimately renamed namespace should not
    // fail as though the app were broken.
    expect(filesScanned, 'the source walk found almost no files').toBeGreaterThan(100)
    const shipped = shippedNamespaces()
    expect(
      [...namespaces].filter((ns) => shipped.includes(ns)).length,
      'the scan matched no shipped namespace at all — it is not reading source',
    ).toBeGreaterThan(3)

    const unregistered = [...namespaces].filter((ns) => !registered.has(ns))
    expect(
      unregistered,
      'used in source but absent from I18N_INIT_OPTIONS.ns — i18next resolves '
      + 'nothing for these and the UI renders raw key paths',
    ).toEqual([])
  })

  it('sees every form the source uses to name a namespace', () => {
    // The gate's own fidelity, asserted rather than assumed: a scan that silently
    // under-matches reads green on exactly the defect it exists to catch.
    //
    // Only one form is unresolvable by any static scan — a namespace that is not a
    // literal. The renamed-`t` and array forms are both IN USE (Chat.tsx,
    // Categories/FeedbackResults.tsx) and `scanSource` handles them, so banning
    // them would fail on correct code.
    const offenders: string[] = []
    for (const file of sourceFiles(SRC)) {
      const source = stripComments(readFileSync(file, 'utf-8'))
      for (const match of source.matchAll(/useTranslation\(\s*([^)]{0,40})/g)) {
        const arg = match[1].trim()
        if (arg === '' || arg.startsWith(')')) continue      // useTranslation()
        if (/^['"[]/.test(arg)) continue                     // literal or array
        offenders.push(`${file}: useTranslation(${arg.slice(0, 24)}…)`)
      }
    }
    expect(
      offenders,
      'a namespace passed as a variable or template literal cannot be resolved '
      + 'statically, so the gate above would silently stop covering it',
    ).toEqual([])
  })

  it('keeps all four copies of the namespace list in step with the shipped catalogues', () => {
    // The root cause the previous test only mitigates: the list is duplicated four
    // times. The shipped catalogue files are the reference — a namespace IS a
    // catalogue — so each copy is compared against them rather than against each
    // other, which would let all four drift together.
    const shipped = shippedNamespaces()
    expect(shipped.length, 'no catalogues found — wrong locales path').toBeGreaterThan(5)

    expect([...(I18N_INIT_OPTIONS.ns as string[])].sort(), 'src/i18n/options.ts').toEqual(shipped)
    expect(arrayLiteral(join(SCRIPTS, 'i18n-check.mjs'), 'NAMESPACES'), 'scripts/i18n-check.mjs')
      .toEqual(shipped)
    expect(arrayLiteral(join(SCRIPTS, 'fix-i18n.mjs'), 'NAMESPACES'), 'scripts/fix-i18n.mjs')
      .toEqual(shipped)
    // The fourth copy is src/test/setup.ts's `namespaceResources`; the harness has
    // already initialised i18next from it, so read the live value instead of
    // re-parsing the file.
    expect([...(i18n.options.ns as string[])].sort(), 'src/test/setup.ts').toEqual(shipped)
  })

  it('keeps the options that are load-bearing rather than cosmetic', () => {
    // One assertion per behaviour, with the behaviour named: a snapshot of this
    // object would fail on any edit without saying what broke.
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
