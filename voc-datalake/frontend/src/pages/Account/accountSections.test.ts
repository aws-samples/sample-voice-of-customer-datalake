/**
 * Account's tabs as paths (`/account/<id>`): each tab's path opens it, an unknown tab opens Profile (its path
 * replacing the address), and no query names a tab (no `?tab=` / `?section=` link of before is read).
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
    ['/account', '', 'profile', null],
    ['/account', '?tab=briefing&section=password', 'profile', null],
    ['/account/password', '?review=fb_1', 'profile', { pathname: '/account/profile', search: '?review=fb_1' }],
    ['/account/nope', '', 'profile', { pathname: '/account/profile', search: '' }],
  ])('%s%s opens %s, replaced by %o', (pathname, search, tab, replaceWith) => {
    expect(read(pathname, search)).toStrictEqual({ place: tab, replaceWith })
  })

  it('builds the links Home and the "Go to settings" buttons use', () => {
    expect([accountTabPath('briefing'), accountTabPath('preferences')]).toStrictEqual(['/account/briefing', '/account/preferences'])
  })
})
