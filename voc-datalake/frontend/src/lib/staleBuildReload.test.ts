import { describe, expect, it, vi } from 'vitest'
import { STALE_BUILD_RELOAD_KEY, installStaleBuildReload } from './staleBuildReload'

/** A window stand-in that records its listener, and an in-memory sessionStorage. */
function setup(build = 'abc1234', stored: Record<string, string> = {}) {
  const target = new EventTarget()
  const data = new Map(Object.entries(stored))
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
  const reload = vi.fn()
  installStaleBuildReload({ target, storage, reload, build })
  const fire = () => {
    const event = new Event('vite:preloadError', { cancelable: true })
    target.dispatchEvent(event)
    return event
  }
  return { fire, reload, data }
}

describe('installStaleBuildReload', () => {
  it('reloads once when a stale tab fails to load a removed chunk, and remembers the build', () => {
    const { fire, reload, data } = setup()
    const event = fire()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
    expect(data.get(STALE_BUILD_RELOAD_KEY)).toBe('abc1234')
  })

  it('does not reload again for the same build, so a real outage cannot loop', () => {
    const { fire, reload } = setup('abc1234', { [STALE_BUILD_RELOAD_KEY]: 'abc1234' })
    const event = fire()
    expect(reload).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('reloads again after a later deploy (a different build)', () => {
    const { fire, reload } = setup('def5678', { [STALE_BUILD_RELOAD_KEY]: 'abc1234' })
    fire()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('never reloads when sessionStorage is blocked', () => {
    const target = new EventTarget()
    const reload = vi.fn()
    const storage = { getItem: () => { throw new Error('blocked') }, setItem: () => undefined }
    installStaleBuildReload({ target, storage, reload, build: 'abc1234' })
    target.dispatchEvent(new Event('vite:preloadError', { cancelable: true }))
    expect(reload).not.toHaveBeenCalled()
  })
})
