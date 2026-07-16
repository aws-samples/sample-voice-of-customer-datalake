/**
 * Locale parity guard (issue #183).
 *
 * Hardcoded strings and half-translated features both start the same way: a
 * key exists in one locale file but not the others. Every namespace must
 * expose the same key set in all supported locales — plural-form suffixes
 * (_one/_other/...) are collapsed to their base key first, because CJK
 * locales legitimately carry only the _other form.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const LOCALES_DIR = path.join(__dirname, '../../public/locales')
const REFERENCE_LOCALE = 'en'
const PLURAL_SUFFIX = /_(one|other|zero|two|few|many)$/

function baseKeys(value: unknown, prefix = ''): Set<string> {
  const keys = new Set<string>()
  if (typeof value !== 'object' || value === null) return keys
  for (const [key, child] of Object.entries(value)) {
    const base = `${prefix}${key.replace(PLURAL_SUFFIX, '')}`
    if (typeof child === 'object' && child !== null) {
      for (const nested of baseKeys(child, `${base}.`)) keys.add(nested)
    } else {
      keys.add(base)
    }
  }
  return keys
}

function readNamespace(locale: string, namespace: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, namespace), 'utf8'))
}

const locales = fs.readdirSync(LOCALES_DIR).filter((entry) => entry !== REFERENCE_LOCALE)
const namespaces = fs.readdirSync(path.join(LOCALES_DIR, REFERENCE_LOCALE)).filter((f) => f.endsWith('.json'))

describe('locale parity', () => {
  it('covers the expected locales and namespaces', () => {
    // Guard against a vacuous pass if the directory layout ever changes.
    expect(locales).toHaveLength(7)
    expect(namespaces.length).toBeGreaterThan(0)
  })

  for (const namespace of namespaces) {
    it(`${namespace} has the same keys in every locale`, () => {
      const reference = baseKeys(readNamespace(REFERENCE_LOCALE, namespace))
      for (const locale of locales) {
        const actual = baseKeys(readNamespace(locale, namespace))
        const missing = [...reference].filter((key) => !actual.has(key)).sort()
        const extra = [...actual].filter((key) => !reference.has(key)).sort()
        expect({ locale, missing, extra }).toStrictEqual({ locale, missing: [], extra: [] })
      }
    })
  }
})
