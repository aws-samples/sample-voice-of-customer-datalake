/** The skills' answers as the screens read them: an unreadable answer is an error, never "no versions". */
import { describe, it, expect } from 'vitest'
import { parseDetail, parseHistory, parseRoles, parseScorecards } from './engineeringSkillsApi'

describe('the skills answers', () => {
  it('refuse an answer with no list where the list should be', () => {
    expect(() => parseRoles({})).toThrow('The skills answer was unreadable')
    expect(() => parseHistory({ versions: 'none' })).toThrow('The skills answer was unreadable')
    expect(() => parseScorecards(null)).toThrow('The skills answer was unreadable')
    expect(() => parseDetail({ version: { version: 0 } })).toThrow('The skill version answer was unreadable')
  })

  it('keep the good entries of a list and drop a role off the catalog', () => {
    const roles = parseRoles({ roles: [{ role: 'fixer', current_version: 2, versions: 3, latest: null }, { role: 'wizard' }] })
    expect(roles.map((line) => line.role)).toStrictEqual(['fixer'])
  })

  it('read the scorecards\' scope as unknown unless the server says it is known', () => {
    expect(parseScorecards({ cards: [] }).scopeKnown).toBe(false)
    expect(parseScorecards({ cards: [], scope_known: true }).scopeKnown).toBe(true)
  })

  it('read the next page\'s token as the server gave it, and none on the last page', () => {
    expect(parseHistory({ versions: [], next_page: 'abc', current_version: 2 })).toStrictEqual(
      { currentVersion: 2, versions: [], nextPage: 'abc' })
    expect(parseHistory({ versions: [], next_page: null }).nextPage).toBeNull()
  })
})
