/**
 * Account's tabs as paths (`/account/<id>`): each tab's path opens it, `/account` and an unknown tab open
 * Preferences (7.54.00, the landing; an unknown tab's path is replaced), and no query names a tab (no `?tab=` /
 * `?section=` link of before is read).
 */
import { describe, it, expect } from 'vitest'
import { readTabAddress } from '../../utils/tabPaths'
import { ACCOUNT_PAGE, ACCOUNT_TAB_IDS, accountTabPath } from './accountSections'

describe('the Account page\'s addresses', () => {
  const read = (pathname: string, search = '') => readTabAddress(ACCOUNT_PAGE, { pathname, search })

  it.each(ACCOUNT_TAB_IDS)('/account/%s opens that tab, as it is', (id) => {
    expect(read(`/account/${id}`)).toStrictEqual({ place: id, replaceWith: null })
  })

  it.each([
    ['/account', '', 'preferences', null],
    ['/account', '?tab=briefing&section=password', 'preferences', null],
    ['/account/password', '?review=fb_1', 'preferences', { pathname: '/account/preferences', search: '?review=fb_1' }],
    ['/account/nope', '', 'preferences', { pathname: '/account/preferences', search: '' }],
  ])('%s%s opens %s, replaced by %o', (pathname, search, tab, replaceWith) => {
    expect(read(pathname, search)).toStrictEqual({ place: tab, replaceWith })
  })

  it('builds the links Home and the "Go to settings" buttons use', () => {
    expect([accountTabPath('briefing'), accountTabPath('preferences')]).toStrictEqual(['/account/briefing', '/account/preferences'])
  })
})
