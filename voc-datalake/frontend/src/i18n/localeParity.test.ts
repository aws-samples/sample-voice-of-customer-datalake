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
        const suffixed = suffixedKeysOf(readNamespace(locale, namespace))
        const actual = collectKeys(readNamespace(locale, namespace))
        const unrenderable = [...reference.pluralized]
          .filter((base) => !suffixed.has(`${base}_other`) && !actual.bare.has(base))
          .sort()
        expect({ locale, unrenderable }).toStrictEqual({ locale, unrenderable: [] })
      }
    })
  }
})
