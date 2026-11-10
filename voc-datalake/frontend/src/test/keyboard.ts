/**
 * Keyboard helpers for focus-management tests.
 */

/** Presses Tab `times` times, one after another (user-event presses must not overlap). */
export function tabTimes(user: { tab: () => Promise<void> }, times: number): Promise<void> {
  return Array.from({ length: times }).reduce<Promise<void>>((done) => done.then(() => user.tab()), Promise.resolve())
}
