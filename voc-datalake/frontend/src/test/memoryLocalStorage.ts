/**
 * @fileoverview A localStorage that remembers, for the suites that read back what a store saved there.
 *
 * `setup.ts` makes `window.localStorage` a mock that remembers nothing. {@link withMemoryLocalStorage}, called at
 * `describe` (or file) level, backs it with a map before each test, `length` and `key` included (what a walk over
 * every key needs), and puts the forgetful mock back after it.
 */
import { afterEach, beforeEach, vi } from 'vitest'

/** Back `window.localStorage` with the returned map in each test of the calling suite. */
export function withMemoryLocalStorage(): Map<string, string> {
  const saved = new Map<string, string>()
  const local = window.localStorage
  beforeEach(() => {
    saved.clear()
    vi.mocked(local.getItem).mockImplementation((key) => saved.get(key) ?? null)
    vi.mocked(local.setItem).mockImplementation((key, value) => { saved.set(key, value) })
    vi.mocked(local.removeItem).mockImplementation((key) => { saved.delete(key) })
    Object.defineProperty(local, 'length', { get: () => saved.size, configurable: true })
    Object.defineProperty(local, 'key', { value: (index: number) => [...saved.keys()][index] ?? null, configurable: true })
  })
  afterEach(() => {
    vi.mocked(local.getItem).mockReturnValue(null)
    vi.mocked(local.setItem).mockReset()
    vi.mocked(local.removeItem).mockReset()
    Reflect.deleteProperty(local, 'length')
    Reflect.deleteProperty(local, 'key')
  })
  return saved
}
