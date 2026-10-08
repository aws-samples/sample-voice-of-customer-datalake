/**
 * Desktop notifications for assistant runs: which run ends announce, when the
 * user is considered to be looking already, the generic (lock-screen safe)
 * text, one tag per thread and kind, click → open the conversation, and the
 * permission helpers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { announceRunEnd, notificationAccess, requestNotificationAccess } from './runNotifications'

interface Shown {
  title: string
  options: NotificationOptions | undefined
  instance: FakeNotification
}

const shown: Shown[] = []
/** The permission the fake reports (a static field would have to be mutable). */
const browser: { permission: NotificationPermission } = { permission: 'granted' }

class FakeNotification {
  static get permission(): NotificationPermission {
    return browser.permission
  }

  static readonly requestPermission = vi.fn(() => Promise.resolve<NotificationPermission>('granted'))
  onclick: (() => void) | null = null
  close = vi.fn()
  constructor(title: string, options?: NotificationOptions) {
    shown.push({ title, options, instance: this })
  }
}

function stubTab({ visible, focused }: { visible: boolean; focused: boolean }) {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(visible ? 'visible' : 'hidden')
  vi.spyOn(document, 'hasFocus').mockReturnValue(focused)
}

const offScreen = { enabled: true, threadOnScreen: false, onOpen: () => undefined }

function only(): Shown {
  expect(shown).toHaveLength(1)
  const [first] = shown
  if (first === undefined) throw new Error('nothing shown')
  return first
}

describe('announceRunEnd', () => {
  beforeEach(() => {
    shown.length = 0
    browser.permission = 'granted'
    vi.stubGlobal('Notification', FakeNotification)
    stubTab({ visible: true, focused: true })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it.each([
    ['awaiting_approval', 'The assistant needs your approval', 'A conversation is waiting for you to approve an action.'],
    ['idle', 'The assistant replied', 'A conversation has a new reply.'],
    ['error', 'An assistant run failed', 'Open the conversation to see what went wrong.'],
  ] as const)('announces a run that ended %s with generic text', (status, title, body) => {
    expect(announceRunEnd('t1', { status }, offScreen)).toBe(true)
    expect(only().title).toBe(title)
    expect(only().options?.body).toBe(body)
  })

  it('keeps an approval on screen until it is clicked; replies and failures may time out', () => {
    announceRunEnd('t1', { status: 'awaiting_approval' }, offScreen)
    announceRunEnd('t2', { status: 'idle' }, offScreen)
    announceRunEnd('t3', { status: 'error' }, offScreen)
    expect(shown.map((s) => s.options?.requireInteraction)).toStrictEqual([true, false, false])
  })

  it('tags by thread and kind so repeats replace instead of stacking', () => {
    announceRunEnd('t1', { status: 'idle' }, offScreen)
    expect(only().options?.tag).toBe('voc-assistant:t1:reply')
  })

  it('stays silent while a run is still streaming', () => {
    expect(announceRunEnd('t1', { status: 'streaming' }, offScreen)).toBe(false)
    expect(shown).toHaveLength(0)
  })

  it('stays silent when the user has not opted in', () => {
    expect(announceRunEnd('t1', { status: 'idle' }, { ...offScreen, enabled: false })).toBe(false)
    expect(shown).toHaveLength(0)
  })

  it.each(['default', 'denied'] as const)('stays silent when permission is %s', (permission) => {
    browser.permission = permission
    expect(announceRunEnd('t1', { status: 'idle' }, offScreen)).toBe(false)
    expect(shown).toHaveLength(0)
  })

  it('stays silent when the thread is on screen in a focused, visible tab', () => {
    expect(announceRunEnd('t1', { status: 'idle' }, { ...offScreen, threadOnScreen: true })).toBe(false)
    expect(shown).toHaveLength(0)
  })

  it.each([
    ['hidden', { visible: false, focused: false }],
    ['visible but unfocused', { visible: true, focused: false }],
    ['hidden but focused', { visible: false, focused: true }],
  ] as const)('announces a thread on screen when the tab is %s', (_label, tab) => {
    stubTab(tab)
    expect(announceRunEnd('t1', { status: 'idle' }, { ...offScreen, threadOnScreen: true })).toBe(true)
  })

  it('a click focuses the window, opens the conversation and closes the notification', () => {
    const onOpen = vi.fn()
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined)
    announceRunEnd('t1', { status: 'idle' }, { ...offScreen, onOpen })
    only().instance.onclick?.()
    expect(focus).toHaveBeenCalledExactlyOnceWith()
    expect(onOpen).toHaveBeenCalledExactlyOnceWith()
    expect(only().instance.close).toHaveBeenCalledExactlyOnceWith()
  })

  it('reports false instead of throwing where the constructor is refused (Chrome on Android)', () => {
    vi.stubGlobal('Notification', class extends FakeNotification {
      constructor() {
        super('')
        throw new TypeError('Illegal constructor')
      }
    })
    expect(announceRunEnd('t1', { status: 'idle' }, offScreen)).toBe(false)
  })

  it('stays silent where the browser has no Notification API', () => {
    vi.stubGlobal('Notification', undefined)
    expect(announceRunEnd('t1', { status: 'idle' }, offScreen)).toBe(false)
  })
})

describe('notification access', () => {
  beforeEach(() => {
    FakeNotification.requestPermission.mockClear()
    vi.stubGlobal('Notification', FakeNotification)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reports the browser permission, or unsupported without the API', () => {
    browser.permission = 'denied'
    expect(notificationAccess()).toBe('denied')
    vi.stubGlobal('Notification', undefined)
    expect(notificationAccess()).toBe('unsupported')
  })

  it('asks the browser only while the permission is still undecided', async () => {
    browser.permission = 'default'
    await expect(requestNotificationAccess()).resolves.toBe('granted')
    browser.permission = 'denied'
    await expect(requestNotificationAccess()).resolves.toBe('denied')
    expect(FakeNotification.requestPermission).toHaveBeenCalledExactlyOnceWith()
  })

  it('reports unsupported where Notification exists but is not a constructor', () => {
    vi.stubGlobal('Notification', { permission: 'granted' })
    expect(notificationAccess()).toBe('unsupported')
  })

  it('answers unsupported without the API', async () => {
    vi.stubGlobal('Notification', undefined)
    await expect(requestNotificationAccess()).resolves.toBe('unsupported')
  })
})
