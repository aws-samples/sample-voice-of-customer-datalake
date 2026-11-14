/**
 * The platform console's record of a workspace it entered: per slug, for the tab (sessionStorage), dropped one by
 * one or all at once, and read leniently.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { forgetPlatformEntries, forgetPlatformEntry, platformEntryFor, rememberPlatformEntry } from './platformEntry'

const FIELD = { id: 'ws_01JCFLDT0000000000000000F1', slug: 'acme-field' }
const TRAIL = { id: 'ws_01JCTRLS0000000000000000T1', slug: 'juniper-trail' }

beforeEach(() => window.sessionStorage.clear())

describe('platformEntry', () => {
  it('answers the record of a slug, and null for any other', () => {
    rememberPlatformEntry(FIELD)
    expect([platformEntryFor('acme-field'), platformEntryFor('juniper-trail')]).toStrictEqual([FIELD, null])
  })

  it('keeps one record per slug and only the fields it needs', () => {
    rememberPlatformEntry({ ...FIELD, id: 'ws_01JCOLDD0000000000000000O1' })
    const listed = { ...FIELD, name: 'Acme Outfitters Field Team', status: 'active' }
    rememberPlatformEntry(listed)
    expect(JSON.parse(window.sessionStorage.getItem('voc-platform-entries') ?? '[]')).toStrictEqual([FIELD])
  })

  it('forgets one slug, or all of them', () => {
    rememberPlatformEntry(FIELD)
    rememberPlatformEntry(TRAIL)
    forgetPlatformEntry('acme-field')
    expect([platformEntryFor('acme-field'), platformEntryFor('juniper-trail')]).toStrictEqual([null, TRAIL])
    forgetPlatformEntries()
    expect(platformEntryFor('juniper-trail')).toBeNull()
  })

  it.each([['not json'], ['{"id":"x"}'], ['[{"slug":"acme-field"}, 3]']])('reads %s as no record', (stored) => {
    window.sessionStorage.setItem('voc-platform-entries', stored)
    expect(platformEntryFor('acme-field')).toBeNull()
  })
})
