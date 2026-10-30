import { describe, expect, it, vi } from 'vitest'
import { STALE_BUILD_RELOAD_KEY, installStaleBuildReload } from './staleBuildReload'

/** A window stand-in that records its listener, and an in-memory sessionStorage. */
function setup(build = 'abc1234', stored: Record<string, string> = {}, online = true) {
  const target = new EventTarget()
  const data = new Map(Object.entries(stored))
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
  const reload = vi.fn()
  installStaleBuildReload({ target, storage, reload, build, isOnline: () => online })
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
    const storage = { getItem: () => { throw new Error('blocked') }, setItem: () => {} }
    installStaleBuildReload({ target, storage, reload, build: 'abc1234', isOnline: () => true })
    target.dispatchEvent(new Event('vite:preloadError', { cancelable: true }))
    expect(reload).not.toHaveBeenCalled()
  })

  it('leaves the page to its own error state while offline, and keeps the one reload for later', () => {
    // 5.48.03 prod e2e: offline, a lazy chunk failed, the reload swapped the app for the browser's offline page.
    const { fire, reload, data } = setup('abc1234', {}, false)
    const event = fire()
    expect(reload).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
    expect(data.has(STALE_BUILD_RELOAD_KEY)).toBe(false)
  })
})
