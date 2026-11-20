/**
 * Administration's search index (7.59.00): every tab, section and card a link names is in it, at its address, its
 * words resolve in English, and the examples find their places ("invite" → Users, "erase" → Source policies' Erasure,
 * "GDPR" → Source policies, "theme" → General's Default theme and Account › Preferences, "quota" → AI models, "Kiro" →
 * Engineering agents' Roles' models).
 */
import { describe, expect, it } from 'vitest'
import i18n from 'i18next'
import { cardsOf, hasSections, sectionOfCard, visibleSections, visibleTabs } from './adminTabs'
import type { AdminViewer } from './adminTabs'
import { adminPath } from './adminPaths'
import { searchSettings, settingsIndex } from './settingsIndex'
import type { ResolvedEntry } from './settingsIndex'

const say = (key: string) => i18n.t(key, { ns: 'settings' })
const EVERYONE: AdminViewer = { isAdmin: true, isPlatformAdmin: true, inWorkspace: true, agentsShown: true }

function resolved(viewer: AdminViewer = EVERYONE): ResolvedEntry[] {
  return settingsIndex(viewer).map((entry) => ({
    entry, title: say(entry.titleKey), place: entry.placeKey === null ? null : say(entry.placeKey),
    terms: entry.termsKey === null ? '' : say(entry.termsKey),
  }))
}

const paths = (query: string, entries = resolved()) => searchSettings(entries, query).map((hit) => hit.entry.path)

describe('the index', () => {
  it('holds every tab, section and card a link names, at its address', () => {
    const expected = visibleTabs(EVERYONE).flatMap((tab) => {
      const sections = visibleSections(tab, EVERYONE)
      const cards = (hasSections(tab) ? sections.flatMap((section) => cardsOf(tab, section)) : cardsOf(tab, null))
        .filter((card) => card !== 'api' || import.meta.env.DEV)
      return [adminPath({ tab, section: sections[0] ?? null }), ...sections.map((section) => adminPath({ tab, section })),
        ...cards.map((card) => adminPath({ tab, section: sectionOfCard(tab, card), card }))]
    })
    expect(resolved().map((hit) => hit.entry.path).filter((path) => path.startsWith('/admin'))).toStrictEqual(expected)
  })

  it('resolves every title, tab and terms key in English (no raw key)', () => {
    const raw = resolved().flatMap((hit) => [hit.title, hit.place ?? '', hit.terms]).filter((text) => /^(search|tabs|sections)\./.test(text))
    expect(raw).toStrictEqual([])
  })

  it('leaves out what this viewer may not see, and Agents › Spend without the engineering agents', () => {
    const plain = resolved({ ...EVERYONE, isPlatformAdmin: false, inWorkspace: false, agentsShown: false }).map((hit) => hit.entry.id)
    expect([plain.includes('workspaces'), plain.includes('agents'), plain.includes('elsewhere/spend'), plain.includes('elsewhere/preferences')])
      .toStrictEqual([false, false, false, true])
  })
})

describe('searchSettings', () => {
  it.each([
    ['invite', '/admin/access/users'],
    ['erase', '/admin/access/policies#erasure'],
    ['GDPR', '/admin/access/policies'],
    ['quota', '/admin/ai'],
    ['radar', '/admin/sources/radar'],
    ['Figma', '/admin/sources/integrations'],
    ['Kiro', '/admin/agents#models'],
    ['hard cap', '/admin/agents#hard-cap'],
    ['GitHub App', '/admin/agents#connections'],
    ['members', '/admin/workspaces/members'],
  ])('"%s" finds %s first', (query, path) => {
    expect(paths(query)[0]).toBe(path)
  })

  it('finds both places a theme is set', () => {
    expect(paths('theme').filter((path) => path === '/admin/general#theme' || path === '/account/preferences'))
      .toStrictEqual(['/admin/general#theme', '/account/preferences'])
  })

  it('ignores case and accents, needs every word, and shows at most eight', () => {
    const accented: ResolvedEntry[] = [{ entry: { id: 'x', titleKey: '', placeKey: null, termsKey: null, path: '/x' }, title: 'Données', place: null, terms: '' }]
    expect([paths('DONNEES', accented), paths('  '), paths('invite zzz'), paths('a').length]).toStrictEqual([['/x'], [], [], 8])
  })
})
