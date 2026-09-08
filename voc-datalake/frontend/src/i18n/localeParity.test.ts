/**
 * Locale parity guard (issue #183).
 *
 * Hardcoded strings and half-translated features both start the same way: a
 * key exists in one locale file but not the others. Every namespace must
 * expose the same key set in all supported locales, and every key English
 * pluralizes must stay pluralized everywhere.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const LOCALES_DIR = path.join(__dirname, '../../public/locales')
const REFERENCE_LOCALE = 'en'
// Collapses i18next plural suffixes to the base key. Caveat: a key
// legitimately NAMED like a plural form (e.g. `step_two`) would collapse
// too and could silently merge with a `step` sibling — avoid such names.
const PLURAL_SUFFIX = /_(one|other|zero|two|few|many)$/

interface KeyShape {
  /** Plural-collapsed key names. */
  base: Set<string>
  /** Base names that appear with at least one plural suffix. */
  pluralized: Set<string>
  /** Base names that appear WITHOUT any suffix. */
  bare: Set<string>
}

function collectKeys(value: unknown, prefix = '', shape: KeyShape = { base: new Set(), pluralized: new Set(), bare: new Set() }): KeyShape {
  if (typeof value !== 'object' || value === null) return shape
  for (const [key, child] of Object.entries(value)) {
    const base = `${prefix}${key.replace(PLURAL_SUFFIX, '')}`
    if (typeof child === 'object' && child !== null) {
      collectKeys(child, `${base}.`, shape)
    } else {
      shape.base.add(base)
      if (PLURAL_SUFFIX.test(key)) {
        shape.pluralized.add(base)
      } else {
        shape.bare.add(base)
      }
    }
  }
  return shape
}

function readNamespace(locale: string, namespace: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, namespace), 'utf8'))
}

function suffixedKeysOf(value: unknown, prefix = '', out: Set<string> = new Set()): Set<string> {
  if (typeof value !== 'object' || value === null) return out
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'object' && child !== null) {
      suffixedKeysOf(child, `${prefix}${key}.`, out)
    } else {
      out.add(`${prefix}${key}`)
    }
  }
  return out
}

/** Every leaf string in a catalogue, as `[dotted.key, value]`. */
function stringEntries(value: unknown, prefix = '', out: [string, string][] = []): [string, string][] {
  if (typeof value !== 'object' || value === null) return out
  for (const [key, child] of Object.entries(value)) {
    const path = `${prefix}${key}`
    if (typeof child === 'string') out.push([path, child])
    else stringEntries(child, `${path}.`, out)
  }
  return out
}

// Stray files (a .DS_Store, a README) must not masquerade as locales.
const locales = fs.readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== REFERENCE_LOCALE)
  .map((entry) => entry.name)
const namespaces = fs.readdirSync(path.join(LOCALES_DIR, REFERENCE_LOCALE)).filter((f) => f.endsWith('.json'))

describe('locale parity', () => {
  it('covers the expected locales and namespaces', () => {
    // Anti-vacuous guard: the 8 supported locales are en (reference) plus
    // de, es, fr, ja, ko, pt, zh. Adding or dropping a locale should be a
    // conscious change — bump this list alongside it.
    expect([REFERENCE_LOCALE, ...locales].sort()).toStrictEqual(['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt', 'zh'])
    expect(namespaces.length).toBeGreaterThan(0)
  })

  it('keeps every remix wizard key in all eight real catalogs', () => {
    const required = [
      'wizards.remixDocuments',
      'wizards.remixInstructions',
      'wizards.remixInstructionsPlaceholder',
      'wizards.selectAtLeast2',
      'wizards.submitRemixDocuments',
    ]
    for (const locale of [REFERENCE_LOCALE, ...locales]) {
      const keys = collectKeys(readNamespace(locale, 'projectDetail.json')).base
      const missing = required.filter((key) => !keys.has(key))
      expect({ locale, missing }).toStrictEqual({ locale, missing: [] })
    }
  })

  it('keeps every global-chrome key in all eight real catalogs', () => {
    // The four surfaces a deployed German run found still in English. Named
    // explicitly rather than left to the parity sweep below, which only proves
    // the catalogues AGREE — eight catalogues that all lack a key agree perfectly.
    const required = [
      'header.title',
      'header.subtitle',
      'timeRange.90d',
      'timeRange.90dFull',
      'timeRange.basisLabel',
      'timeRange.basisSelected',
      'timeRange.basisImported',
      'timeRange.basisImportedDescription',
      'timeRange.basisImportedTooltip',
      'timeRange.basisReview',
      'timeRange.basisReviewDescription',
      'timeRange.basisReviewTooltip',
      'timeRange.customRange',
      'timeRange.selectCustomRange',
      'timeRange.closeCustomRange',
      'timeRange.lastNDays',
      'timeRange.lastDays',
      'timeRange.days',
      'timeRange.daysHint',
      'timeRange.daysPlaceholder',
    ]
    for (const locale of [REFERENCE_LOCALE, ...locales]) {
      const keys = collectKeys(readNamespace(locale, 'common.json')).base
      const missing = required.filter((key) => !keys.has(key))
      expect({ locale, missing }).toStrictEqual({ locale, missing: [] })
    }
  })

  it('never translates a canonical (vN) document suffix', () => {
    // A managed document's `(vN)` is STORED IDENTITY, minted by
    // `shared/document_versions.canonical_document_title` and matched back by
    // `VERSION_SUFFIX_RE`. A catalogue that localized it — "(V1)", "（v1）",
    // "(Version 1)" — would make the displayed title stop round-tripping, and a
    // reviewer citing "PRD (v2)" would be naming a document the backend cannot
    // find. So the suffix must appear in NO catalogue value at all: it is data
    // arriving on the wire, never chrome this bundle composes.
    const suffix = /\(\s*v(?:ersion)?\s*\d+\s*\)/i
    for (const locale of [REFERENCE_LOCALE, ...locales]) {
      for (const namespace of namespaces) {
        const offenders = stringEntries(readNamespace(locale, namespace))
          .filter(([, value]) => suffix.test(value))
          .map(([key]) => key)
          .sort()
        expect({ locale, namespace, offenders })
          .toStrictEqual({ locale, namespace, offenders: [] })
      }
    }
  })

  it('would flag a translated version suffix, so the guard above is not vacuous', () => {
    // The complement: an empty `offenders` list has to mean "nothing localizes a
    // vN", not "the detector never matches anything".
    const suffix = /\(\s*v(?:ersion)?\s*\d+\s*\)/i
    for (const localized of ['Anforderungsdokument (v1)', 'PRD (Version 2)', 'PRD (V10)']) {
      expect(suffix.test(localized), localized).toBe(true)
    }
    // ...and ordinary copy that merely contains a parenthesis is not flagged.
    for (const innocent of ['Delete (permanent)', 'Last 14 days', 'v1 of the plan']) {
      expect(suffix.test(innocent), innocent).toBe(false)
    }
  })

  for (const namespace of namespaces) {
    it(`${namespace} has the same keys in every locale`, () => {
      const reference = collectKeys(readNamespace(REFERENCE_LOCALE, namespace))
      for (const locale of locales) {
        const actual = collectKeys(readNamespace(locale, namespace))
        const missing = [...reference.base].filter((key) => !actual.base.has(key)).sort()
        const extra = [...actual.base].filter((key) => !reference.base.has(key)).sort()
        expect({ locale, missing, extra }).toStrictEqual({ locale, missing: [], extra: [] })
      }
    })

    it(`${namespace} keeps English's pluralized keys renderable in every locale`, () => {
      // For every key en pluralizes, each locale must have SOMETHING i18next
      // can select for a { count } interpolation: the `_other` form (the
      // universal fallback category — the only one CJK locales carry) or a
      // bare base key (the repo's own en files pair bare fallbacks with
      // plural forms, e.g. categories.json `issues`). A locale with only a
      // `_one` form renders raw key names for count > 1 — that is the
      // breakage this guards against. Deliberately NOT requiring every
      // Intl.PluralRules category per locale: that would demand e.g. `_many`
      // for fr/es/pt, which English itself does not provide and these
      // small-count UIs never hit.
      const reference = collectKeys(readNamespace(REFERENCE_LOCALE, namespace))
      for (const locale of locales) {
        const content = readNamespace(locale, namespace)
        const suffixed = suffixedKeysOf(content)
        const actual = collectKeys(content)
        const unrenderable = [...reference.pluralized]
          .filter((base) => !suffixed.has(`${base}_other`) && !actual.bare.has(base))
          .sort()
        expect({ locale, unrenderable }).toStrictEqual({ locale, unrenderable: [] })
      }
    })
  }
})
