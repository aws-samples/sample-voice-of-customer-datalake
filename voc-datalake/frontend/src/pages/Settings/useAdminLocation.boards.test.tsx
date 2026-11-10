/**
 * @fileoverview `&board=<id>` belongs to the Boards section: a section switch drops it, and a
 * canonical redirect keeps it only when the link still lands in Boards.
 */
import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { TestRouter } from '@test/TestRouter'
import { useAdminLocation } from './useAdminLocation'

function mount(entry: string, isAdmin = true) {
  const wrapper = ({ children }: Readonly<{ children: ReactNode }>) => <TestRouter initialEntries={[entry]}>{children}</TestRouter>
  return renderHook(() => useAdminLocation(isAdmin), { wrapper })
}

describe('the board param', () => {
  it('opens Privacy & access → Boards with no redirect', () => {
    const { result } = mount('/admin?tab=access&section=boards&board=brd_sales')
    expect([result.current.location, result.current.redirectTo]).toStrictEqual([{ tab: 'access', section: 'boards' }, null])
  })

  it('is dropped by a section switch', () => {
    const { result } = mount('/admin?tab=access&section=boards&board=brd_sales&review=r1')
    act(() => result.current.selectSection('users'))
    expect(result.current.location).toStrictEqual({ tab: 'access', section: 'users' })
    act(() => result.current.selectSection('boards'))
    expect(result.current.redirectTo).toBeNull()
  })

  it('survives a canonical redirect that lands in Boards, not one that does not', () => {
    expect([
      mount('/admin?tab=access&section=boards&board=brd_sales&extra=1').result.current.redirectTo,
      mount('/admin?tab=access&section=nope&board=brd_sales').result.current.redirectTo,
      mount('/admin?tab=access&section=boards&board=brd_sales', false).result.current.redirectTo,
    ]).toStrictEqual([null, '?tab=access&section=policies', '?tab=brand'])
  })
})
