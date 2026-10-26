/**
 * The notification preference (the panel header's "More actions" toggle and
 * Account → Assistant): opting in asks the browser from the click, a refusal
 * leaves it off, opting out needs no prompt, and a blocked or missing API
 * disables it with the reason as its label. A probe button renders the hook the
 * way its callers do (the bell button itself was folded into the menu, wave 4).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '@test/test-utils'
import { useNotifySetting } from './useNotifySetting'
import { useAssistantUiStore } from '../store/assistantStore'

const requestPermission = vi.fn<() => Promise<NotificationPermission>>()
const fake: { permission: NotificationPermission; requestPermission: typeof requestPermission } = { permission: 'default', requestPermission }

function stubApi(permission: NotificationPermission, answer: NotificationPermission = permission) {
  fake.permission = permission
  requestPermission.mockImplementation(() => {
    fake.permission = answer
    return Promise.resolve(answer)
  })
  vi.stubGlobal('Notification', Object.assign(function FakeNotification() {}, fake))
}

function NotifyToggle() {
  const { on, unavailable, label, toggle } = useNotifySetting()
  return <button type="button" aria-pressed={on} disabled={unavailable} aria-label={label} onClick={() => void toggle()}>bell</button>
}

describe('useNotifySetting', () => {
  beforeEach(() => {
    requestPermission.mockReset()
    useAssistantUiStore.getState().reset()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('turns on after the browser grants permission from the click', async () => {
    stubApi('default', 'granted')
    render(<NotifyToggle />)
    await userEvent.click(screen.getByRole('button', { name: 'Notify me when a conversation needs me' }))
    expect(requestPermission).toHaveBeenCalledExactlyOnceWith()
    expect(useAssistantUiStore.getState().notify).toBe(true)
    expect(await screen.findByRole('button', { name: 'Turn off notifications' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('stays off when the user refuses the browser prompt', async () => {
    stubApi('default', 'denied')
    render(<NotifyToggle />)
    await userEvent.click(screen.getByRole('button', { name: 'Notify me when a conversation needs me' }))
    expect(useAssistantUiStore.getState().notify).toBe(false)
    expect(await screen.findByRole('button', { name: 'Notifications are blocked for this site in the browser settings' })).toBeDisabled()
  })

  it('turns off without asking the browser again', async () => {
    stubApi('granted')
    useAssistantUiStore.getState().setNotify(true)
    render(<NotifyToggle />)
    await userEvent.click(screen.getByRole('button', { name: 'Turn off notifications' }))
    expect(requestPermission).not.toHaveBeenCalled()
    expect(useAssistantUiStore.getState().notify).toBe(false)
  })

  it('reads as off while the stored choice is on but the browser no longer grants it', () => {
    stubApi('default')
    useAssistantUiStore.getState().setNotify(true)
    render(<NotifyToggle />)
    expect(screen.getByRole('button', { name: 'Notify me when a conversation needs me' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('is disabled and says so where the browser has no Notification API', () => {
    vi.stubGlobal('Notification', undefined)
    render(<NotifyToggle />)
    expect(screen.getByRole('button', { name: 'This browser does not support notifications' })).toBeDisabled()
  })

  it('treats a failed permission request as blocked', async () => {
    stubApi('default')
    requestPermission.mockImplementation(() => Promise.reject(new Error('no prompt')))
    render(<NotifyToggle />)
    await userEvent.click(screen.getByRole('button', { name: 'Notify me when a conversation needs me' }))
    expect(await screen.findByRole('button', { name: 'Notifications are blocked for this site in the browser settings' })).toBeDisabled()
    expect(useAssistantUiStore.getState().notify).toBe(false)
  })

  it('re-reads the permission when the window regains focus', () => {
    stubApi('default')
    render(<NotifyToggle />)
    // The user blocks the site in the browser settings while the tab is in the background.
    stubApi('denied')
    act(() => {
      fireEvent.focus(window)
    })
    expect(screen.getByRole('button', { name: 'Notifications are blocked for this site in the browser settings' })).toBeDisabled()
  })

  it('stops listening for focus once unmounted', () => {
    stubApi('default')
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const { unmount } = render(<NotifyToggle />)
    const listener = add.mock.calls.find(([type]) => type === 'focus')?.[1]
    unmount()
    // Copied before mockRestore, which clears the recorded calls.
    const removed = remove.mock.calls.filter(([type]) => type === 'focus').map(([, fn]) => fn)
    add.mockRestore()
    remove.mockRestore()
    expect(listener).toBeInstanceOf(Function)
    expect(removed).toStrictEqual([listener])
  })
})
