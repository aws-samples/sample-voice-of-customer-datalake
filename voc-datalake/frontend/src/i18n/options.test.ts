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
 * failure this module's history is made of. `scripts/i18n-check.mjs` reads its
 * namespaces from the `en` catalogue directory, so it audits every shipped one,
 * but it never sees the list the app REGISTERS — this spec does.
 *
 * The reference for "which namespaces exist" is the shipped catalogue files, not
 * any of the three hardcoded lists — a namespace IS a catalogue.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import i18n from 'i18next'
import { I18N_INIT_OPTIONS } from './options'
import { sortedStrings, stringList } from '@test/stringLists'
import { at } from '@test/defined'

const SRC = join(__dirname, '..')
const FRONTEND = join(SRC, '..')
const LOCALES = join(FRONTEND, 'public', 'locales')
const LOCALES_EN = join(LOCALES, 'en')
const SCRIPTS = join(FRONTEND, 'scripts')

/** Catalogue names in one locale directory. */
function cataloguesIn(dir: string): string[] {
  return sortedStrings(readdirSync(dir)
    .filter((f) => extname(f) === '.json')
    .map((f) => basename(f, '.json')))
}

/** The namespaces actually shipped: one catalogue file each, per `en`. */
function shippedNamespaces(): string[] {
  return cataloguesIn(LOCALES_EN)
}

/** The locales the app declares support for — what the detector will accept. */
function supportedLocales(): string[] {
  return sortedStrings(stringList(I18N_INIT_OPTIONS.supportedLngs, 'supportedLngs'))
}

/**
 * Directories under `public/locales` that are not locales.
 *
 * A convention rather than a name list: anything starting with `_` or `.` is
 * infrastructure (templates, tooling, dotfiles). Without this, such a directory
 * fails the parity test with a message about missing catalogues.
 */
function isIgnoredLocaleDir(name: string): boolean {
  return name.startsWith('_') || name.startsWith('.')
}

/** Locale directories present on disk, ignoring non-locale infrastructure. */
function localeDirsOnDisk(): string[] {
  return sortedStrings(readdirSync(LOCALES, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !isIgnoredLocaleDir(e.name))
    .map((e) => e.name))
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
  const items = [...at(match, 1).matchAll(/['"](\w+)['"]/g)].map((m) => at(m, 1))
  if (items.length === 0) throw new Error(`${basename(file)}: ${variable} parsed as empty`)
  return sortedStrings(items)
}

/**
 * Drop comments before scanning.
 *
 * Not fussiness: a docblock in `ValidationLinkPicker.tsx` discusses the shape of a
 * translation key (`xKey: 'ns:key'`), and a naive scan reads that prose as a
 * namespace called `ns` and reports the app as broken. It did, on the first run.
 * `scripts/i18n-check.mjs` has the same blind spot and warns about that comment.
 *
 * Block comments are stripped only where a line OPENS one, so an inline block-comment
 * marker inside a string or regex literal cannot pair with a later terminator and
 * delete the real code between them. That direction is a false negative, which is the
 * worse one for a gate: it would read green while covering less.
 */
function stripComments(source: string): string {
  const lines = source.split('\n')
  const kept: string[] = []
  const state = { inBlock: false }
  for (const line of lines) {
    const trimmed = line.trim()
    if (state.inBlock) {
      if (trimmed.includes('*/')) state.inBlock = false
      continue
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) state.inBlock = true
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
    for (const ns of namespacesIn(stripComments(readFileSync(file, 'utf-8')))) namespaces.add(ns)
  }
  return { namespaces, filesScanned: files.length }
}

/** The namespaces one (comment-stripped) source file names, in every form `scanSource` lists. */
function namespacesIn(source: string): Set<string> {
  const namespaces = new Set<string>()
  for (const m of source.matchAll(/useTranslation\(\s*['"](\w+)['"]/g)) namespaces.add(at(m, 1))
  for (const listMatch of source.matchAll(/useTranslation\(\s*\[([^\]]*)\]/g)) {
    for (const m of at(listMatch, 1).matchAll(/['"](\w+)['"]/g)) namespaces.add(at(m, 1))
  }
  for (const m of source.matchAll(/\b\w*[Kk]ey:\s*['"](\w+):[\w.]+['"]/g)) namespaces.add(at(m, 1))

  // `t` plus every name `t` was renamed to in this file, so a qualified key
  // reached through an alias is not invisible.
  //
  // Brace-scoped, which drops bare `(t: number)` parameters. It does NOT
  // distinguish a destructuring from a type literal — `{ t: TFunction }` still
  // contributes `TFunction` — and that is fine rather than fixed, because the
  // two directions are not symmetric: an extra caller name matches no call site
  // and changes nothing, while a MISSED alias is the silent blind spot this
  // whole scan exists to avoid. So the regex is deliberately generous.
  //
  // Caveat worth knowing: `[^{}]*` cannot cross a nested object, so a future
  // `const { data: { x }, t: tr }` would drop out of the caller set. Unused today.
  //
  // The negated class spans newlines, which it must — Chat.tsx's rename is in a
  // multi-line destructuring.
  const callers = new Set(['t'])
  for (const m of source.matchAll(/\{[^{}]*\bt\s*:\s*(\w+)/g)) callers.add(at(m, 1))
  for (const caller of callers) {
    const qualified = new RegExp(`\\b${caller}\\(\\s*['"](\\w+):`, 'g')
    for (const m of source.matchAll(qualified)) namespaces.add(at(m, 1))
  }
  return namespaces
}

describe('I18N_INIT_OPTIONS', () => {
  it('registers every namespace the app actually asks for', () => {
    const registered = new Set(stringList(I18N_INIT_OPTIONS.ns, 'ns'))
    const { namespaces, filesScanned } = scanSource()

    // Liveness, structural rather than by name: a walk that silently returns
    // nothing would make the assertion below pass over an empty set. Names are
    // deliberately not pinned here — a legitimately renamed namespace should not
    // fail as though the app were broken.
    // A floor that says "the walk ran", not an assertion about how much code exists:
    // a high threshold would fail on a legitimate large deletion. A broken walk
    // returns 0 or a handful.
    expect(filesScanned, 'the source walk found almost no files').toBeGreaterThan(20)
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
    ).toStrictEqual([])
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
        const arg = at(match, 1).trim()
        if (arg === '') continue                             // useTranslation()
        if (/^['"[]/.test(arg)) continue                     // literal or array
        offenders.push(`${file}: useTranslation(${arg.slice(0, 24)}…)`)
      }
    }
    expect(
      offenders,
      'a namespace passed as a variable or template literal cannot be resolved '
      + 'statically, so the gate above would silently stop covering it',
    ).toStrictEqual([])
  })

  // The root cause the previous test only mitigates: the list is duplicated three
  // times. The shipped catalogue files are the reference — a namespace IS a
  // catalogue — so each copy is compared against them rather than against each
  // other, which would let all three drift together.
  it('finds the shipped catalogues the copies are compared against', () => {
    expect(shippedNamespaces().length, 'no catalogues found — wrong locales path').toBeGreaterThan(5)
  })

  it.each([
    ['src/i18n/options.ts', () => sortedStrings(stringList(I18N_INIT_OPTIONS.ns, 'ns'))],
    ['scripts/fix-i18n.mjs', () => arrayLiteral(join(SCRIPTS, 'fix-i18n.mjs'), 'NAMESPACES')],
    // The third copy is src/test/setup.ts's `namespaceResources`; the harness has
    // already initialised i18next from it, so read the live value instead of
    // re-parsing the file.
    ['src/test/setup.ts', () => sortedStrings(stringList(i18n.options.ns, 'i18n.options.ns'))],
  ])('keeps the namespace list in %s in step with the shipped catalogues', (label, copy) => {
    expect(copy(), label).toStrictEqual(shippedNamespaces())
  })

  it('lets scripts/i18n-check.mjs read its namespaces from the en catalogues instead of keeping a copy', () => {
    const audit = readFileSync(join(SCRIPTS, 'i18n-check.mjs'), 'utf8')
    expect(/^const NAMESPACES = localeNamespaces\(SOURCE_LANG\)$/m.test(audit), 'i18n-check.mjs NAMESPACES').toBe(true)
    expect(/^const SOURCE_LANG = 'en'$/m.test(audit), 'i18n-check.mjs SOURCE_LANG').toBe(true)
  })

  it('ships a locale directory for exactly the supported locales', () => {
    // Because the check above uses `en` as the reference, an orphan catalogue in
    // another locale (`fr/feedback.json`) would satisfy every list while belonging
    // to no namespace — and now that `fix-i18n.mjs` iterates the registered list, it
    // would skip that file forever. The reverse, a locale missing a catalogue `en`
    // ships, means that whole page falls back to English with no other signal.
    // (The per-locale catalogue comparison is the `it.each` below.)
    const locales = supportedLocales()
    expect(locales, 'supportedLngs must include the reference locale').toContain('en')

    // Both directions, because deriving the loop from `supportedLngs` alone would
    // quietly shrink this gate: a shipped directory absent from `supportedLngs`
    // would never be visited, and pruning an entry while its catalogues stay on disk
    // would reduce coverage instead of failing. Set equality first, then iterate.
    expect(
      localeDirsOnDisk(),
      'locale directories on disk (received) must equal supportedLngs (expected). '
      + 'Extra on disk = translations shipped that the detector will never select. '
      + 'Extra in supportedLngs = a locale the detector accepts with no catalogues '
      + 'to load.',
    ).toStrictEqual(locales)

  })

  it.each(supportedLocales())('ships the en catalogue set in locale %s', (locale) => {
    expect(cataloguesIn(join(LOCALES, locale)), `locale ${locale}`).toStrictEqual(shippedNamespaces())
  })

  it('supports more than one locale, so the parity check above compares something', () => {
    expect(supportedLocales().length, 'only one locale supported; parity across locales is untested')
      .toBeGreaterThan(1)
  })

  // One assertion per behaviour, with the behaviour named: a snapshot of this
  // object would fail on any edit without saying what broke.
  it('keeps the language-selection options that are load-bearing rather than cosmetic', () => {
    expect(I18N_INIT_OPTIONS.fallbackLng, 'first visit must land on English').toBe('en')
    expect(
      I18N_INIT_OPTIONS.nonExplicitSupportedLngs,
      'must stay false, or a regional variant we do not ship can be selected',
    ).toBe(false)
    expect(
      stringList(I18N_INIT_OPTIONS.supportedLngs, 'supportedLngs').length,
      'without supportedLngs a stale localStorage value selects an unshipped locale',
    ).toBeGreaterThan(1)
  })

  it('keeps the detection and interpolation options that are load-bearing rather than cosmetic', () => {
    expect(
      I18N_INIT_OPTIONS.detection?.order,
      "detection must read ONLY the user's stored choice — 'navigator' is "
      + 'deliberately absent so a non-English browser still gets English',
    ).toStrictEqual(['localStorage'])
    expect(I18N_INIT_OPTIONS.detection?.lookupLocalStorage).toBe('voc-language')
    expect(
      I18N_INIT_OPTIONS.interpolation?.escapeValue,
      'React escapes already; true would double-escape every interpolated value',
    ).toBe(false)
  })
})
