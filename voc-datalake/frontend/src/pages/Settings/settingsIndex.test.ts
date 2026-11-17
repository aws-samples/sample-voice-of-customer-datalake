/**
 * Administration's search index (7.54.00): every tab and every card a path names is in it, with its path, its
 * words resolve in English, and the spec's examples find their places ("invite" → People, "GitHub" → Agents ›
 * Connections, "erase" → Privacy's Erasure, "GDPR" → Privacy, "theme" → Brand & appearance and Account ›
 * Preferences, "quota" → AI models).
 */
import { describe, expect, it } from 'vitest'
import i18n from 'i18next'
import { ADMIN_GROUPS, visibleSections } from './adminTabs'
import { adminPath } from './adminPaths'
import { searchSettings, settingsIndex } from './settingsIndex'
import type { ResolvedEntry } from './settingsIndex'

const say = (key: string) => i18n.t(key, { ns: 'settings' })

function resolved(isAdmin = true, isPlatformAdmin = true, agents = true): ResolvedEntry[] {
  return settingsIndex(isAdmin, isPlatformAdmin, agents).map((entry) => ({
    entry, title: say(entry.titleKey), place: entry.placeKey === null ? null : say(entry.placeKey), terms: say(entry.termsKey),
  }))
}

const paths = (query: string, entries = resolved()) => searchSettings(entries, query).map((hit) => hit.entry.path)

describe('the index', () => {
  it('holds every tab and every card a path names, at its path', () => {
    const tabs = [...ADMIN_GROUPS.flatMap((group) => group.tabs), 'version' as const]
    const expected = tabs.flatMap((tab) => [adminPath({ tab, section: null }),
      ...visibleSections(tab, true, true).map((section) => adminPath({ tab, section }))])
    expect(resolved().map((hit) => hit.entry.path).filter((path) => path.startsWith('/admin'))).toStrictEqual(expected)
  })

  it('resolves every title, page and terms key in English (no raw key)', () => {
    const raw = resolved().flatMap((hit) => [hit.title, hit.place ?? '', hit.terms]).filter((text) => /^(search|tabs|sections)\./.test(text))
    expect(raw).toStrictEqual([])
  })

  it('leaves out what this caller may not see, and the Agents places without the Agents page', () => {
    const plain = resolved(true, false, false).map((hit) => hit.entry.id)
    expect([plain.includes('platform'), plain.includes('elsewhere/spend'), plain.includes('elsewhere/preferences')])
      .toStrictEqual([false, false, true])
  })
})

describe('searchSettings', () => {
  it.each([
    ['invite', '/admin/people'],
    ['GitHub', '/agents/connections'],
    ['erase', '/admin/privacy/erasure'],
    ['GDPR', '/admin/privacy'],
    ['quota', '/admin/ai'],
    ['radar', '/admin/sources/radar'],
  ])('"%s" finds %s first', (query, path) => {
    expect(paths(query)[0]).toBe(path)
  })

  it('finds both places a theme is set', () => {
    expect(paths('theme').filter((path) => path === '/admin/brand/theme' || path === '/account/preferences'))
      .toStrictEqual(['/admin/brand/theme', '/account/preferences'])
  })

  it('ignores case and accents, needs every word, and shows at most eight', () => {
    const accented: ResolvedEntry[] = [{ entry: { id: 'x', titleKey: '', placeKey: null, termsKey: '', path: '/x' }, title: 'Données', place: null, terms: '' }]
    expect([paths('DONNEES', accented), paths('  '), paths('invite zzz'), paths('a').length]).toStrictEqual([['/x'], [], [], 8])
  })
})
