/**
 * @fileoverview Reading the shipped locale catalogues, shared by the i18n audit
 * (`i18n-check.mjs`) and its regression tests (`i18n-check.test.mjs`).
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

/** `public/locales`, resolved from this script's location. */
const LOCALES_DIR = resolve(__dirname, '..', 'public', 'locales')

/**
 * Validate that a resolved path stays within an allowed base directory.
 * Prevents path-traversal attacks when building paths from dynamic segments.
 */
export function safePath(base, ...segments) {
  const resolved = normalize(resolve(base, ...segments))
  if (!resolved.startsWith(normalize(base) + '/') && resolved !== normalize(base)) {
    throw new Error(`Path traversal detected: ${resolved} is outside ${base}`)
  }
  return resolved
}

/** The parsed `<lang>/<ns>.json` catalogue, or `null` when the file does not exist. */
/**
 * The namespaces a language ships: one `<ns>.json` per namespace in its locale
 * directory, sorted. Read from disk so a new namespace is audited the moment its
 * English file exists, instead of waiting for a hand-kept list to learn its name.
 */
export function localeNamespaces(lang) {
  return readdirSync(safePath(LOCALES_DIR, lang))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort()
}

export function loadLocale(lang, ns) {
  const filePath = safePath(LOCALES_DIR, lang, `${ns}.json`)
  if (!existsSync(filePath)) return null
  return JSON.parse(readFileSync(filePath, 'utf-8'))
}

/** Flatten nested object into `['dot.path', value]` entries. */
export function flattenEntries(obj, prefix = '') {
  const entries = []
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      entries.push(...flattenEntries(value, fullKey))
    } else {
      entries.push([fullKey, value])
    }
  }
  return entries
}

/**
 * The value with every `{{placeholder}}` removed — a linear scan rather than a
 * regex, so no input shape can make it backtrack.
 */
export function stripPlaceholders(value) {
  let out = ''
  let i = 0
  while (i < value.length) {
    const open = value.indexOf('{{', i)
    const close = open === -1 ? -1 : value.indexOf('}}', open + 2)
    if (close === -1) return out + value.slice(i)
    out += value.slice(i, open)
    i = close + 2
  }
  return out
}
