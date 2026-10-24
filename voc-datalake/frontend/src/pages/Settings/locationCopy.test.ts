/**
 * Copy that names a place in Administration names one that exists (5.10 sweep):
 * in every locale, each "<Administration> → <tab>[ → <section>]" in any
 * namespace starts with a tab label of that locale and, when the tab has a
 * section switch and the path goes on, one of that tab's section labels. No
 * string points to the retired "<Settings> → …" page. Third-party UI paths
 * (Figma / GitHub token steps in `settings:integrationGuide`) are not ours.
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { z } from 'zod'
import { visibleSections, visibleTabs } from './adminTabs'
import type { AdminTabId } from './adminTabs'

const LOCALES_DIR = path.join(__dirname, '../../../public/locales')
const LOCALES = fs.readdirSync(LOCALES_DIR).filter((name) => fs.statSync(path.join(LOCALES_DIR, name)).isDirectory())
const SEPARATOR = String.raw`\s*(?:→|->|>)\s*`
const THIRD_PARTY_PREFIX = 'settings:integrationGuide.'

const commonSchema = z.object({ nav: z.object({ admin: z.string() }) })

/**
 * The retired page's label in each locale (its `common:nav.settings` key went with it),
 * kept here so the guard below still knows what a stale "Settings → …" pointer reads like.
 */
const RETIRED_SETTINGS_LABEL: Readonly<Record<string, string>> = {
  de: 'Einstellungen', en: 'Settings', es: 'Configuración', fr: 'Paramètres', ja: '設定',
  ko: '설정', pl: 'Ustawienia', pt: 'Configurações', zh: '设置',
}
const settingsSchema = z.object({ tabs: z.record(z.string(), z.string()), sections: z.record(z.string(), z.string()) })

function readJson(locale: string, ns: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, `${ns}.json`), 'utf8'))
}

/** Every string leaf of a locale as `ns:dotted.key` → value. */
function leaves(node: unknown, prefix: string): [string, string][] {
  if (typeof node === 'string') return [[prefix, node]]
  if (typeof node !== 'object' || node === null) return []
  const sep = prefix.endsWith(':') ? '' : '.'
  return Object.entries(node).flatMap(([key, value]) => leaves(value, `${prefix}${sep}${key}`))
}

function localeStrings(locale: string): [string, string][] {
  return fs.readdirSync(path.join(LOCALES_DIR, locale))
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.replace(/\.json$/, ''))
    .flatMap((ns) => leaves(readJson(locale, ns), `${ns}:`))
    .filter(([key]) => !key.startsWith(THIRD_PARTY_PREFIX))
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)

interface Place { readonly label: string; readonly sections: readonly string[] }

function places(locale: string): Place[] {
  const labels = settingsSchema.parse(readJson(locale, 'settings'))
  const tabLabel = (id: AdminTabId) => labels.tabs[id === 'brand' ? 'general' : id] ?? id
  return visibleTabs(true).map((id) => ({
    label: tabLabel(id),
    sections: visibleSections(id, true).map((section) => labels.sections[section] ?? section),
  }))
}

/** True when `rest` (the text after "<Administration> →") starts with a real tab [→ section]. */
function namesAPlace(rest: string, known: readonly Place[]): boolean {
  return known.some((place) => {
    if (!rest.startsWith(place.label)) return false
    const after = rest.slice(place.label.length)
    const next = new RegExp(`^${SEPARATOR}`).exec(after)
    if (next === null || place.sections.length === 0) return true
    return place.sections.some((section) => after.slice(next[0].length).startsWith(section))
  })
}

function brokenPlaces(locale: string): string[] {
  const nav = commonSchema.parse(readJson(locale, 'common')).nav
  const known = places(locale)
  const pointer = new RegExp(`${escapeRegExp(nav.admin)}${SEPARATOR}`, 'g')
  return localeStrings(locale).flatMap(([key, text]) => [...text.matchAll(pointer)]
    .filter((match) => !namesAPlace(text.slice(match.index + match[0].length), known))
    .map(() => `${key}: ${text}`))
}

function retiredSettingsPointers(locale: string): string[] {
  const label = RETIRED_SETTINGS_LABEL[locale]
  if (label === undefined) throw new Error(`no retired Settings label for ${locale}`)
  const pointer = new RegExp(`${escapeRegExp(label)}${SEPARATOR}`)
  return localeStrings(locale).filter(([, text]) => pointer.test(text)).map(([key, text]) => `${key}: ${text}`)
}

describe('copy naming an Administration place', () => {
  it('reads the nine shipped locales', () => {
    expect(new Set(LOCALES)).toStrictEqual(new Set(['de', 'en', 'es', 'fr', 'ja', 'ko', 'pl', 'pt', 'zh']))
  })

  it.each(LOCALES)('%s: every "Administration → …" names a real tab and section', (locale) => {
    expect(brokenPlaces(locale)).toStrictEqual([])
  })

  it.each(LOCALES)('%s: nothing points to the retired "Settings → …" page', (locale) => {
    expect(retiredSettingsPointers(locale)).toStrictEqual([])
  })

  it('recognises a stale place (the checker is not vacuous)', () => {
    const known = places('en')
    expect(namesAPlace('Dimensions).', known)).toBe(false)
    expect(namesAPlace('Taxonomy → Users', known)).toBe(false)
    expect(namesAPlace('Taxonomy → Dimensions).', known)).toBe(true)
    expect(namesAPlace('AI models.', known)).toBe(true)
  })
})
