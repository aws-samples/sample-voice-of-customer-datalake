/**
 * Keyboard helpers for focus-management tests.
 */
import { expect } from 'vitest'
import { screen } from '@testing-library/react'

/** Presses Tab `times` times, one after another (user-event presses must not overlap). */
export function tabTimes(user: { tab: () => Promise<void> }, times: number): Promise<void> {
  return Array.from({ length: times }).reduce<Promise<void>>((done) => done.then(() => user.tab()), Promise.resolve())
}

/**
 * Tab in an open menu in a portal (hooks/usePortalMenu): the menu closes and the focus goes on to the button named
 * `next`, the control after its trigger in the page's tab order.
 */
export async function expectTabLeavesTheMenu(user: { keyboard: (keys: string) => Promise<void> },
  next: string): Promise<void> {
  await user.keyboard('{Tab}')
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: next })).toHaveFocus()
}
