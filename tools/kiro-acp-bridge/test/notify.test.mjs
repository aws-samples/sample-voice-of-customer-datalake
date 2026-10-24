import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

// Minimal browser globals for public/notify.js (it only touches these).
const shown = []
class FakeNotification {
  static permission = 'granted'
  static requested = 0
  static async requestPermission() {
    FakeNotification.requested += 1
    FakeNotification.permission = 'granted'
    return 'granted'
  }
  constructor(title, options) {
    shown.push({ title, ...options })
    this.closed = false
  }
  close() {
    this.closed = true
  }
}
const page = { visibility: 'hidden', focused: false, focusCalls: 0 }
globalThis.window = { Notification: FakeNotification, focus: () => (page.focusCalls += 1) }
globalThis.Notification = FakeNotification
globalThis.document = { get visibilityState() { return page.visibility }, hasFocus: () => page.focused }

const { createNotifier } = await import('../public/notify.js')

function fakeCheckbox(checked = true) {
  const listeners = []
  return { checked, disabled: false, addEventListener: (_type, fn) => listeners.push(fn), fire: () => listeners.forEach((fn) => fn()) }
}

describe('createNotifier', () => {
  beforeEach(() => {
    shown.length = 0
    FakeNotification.permission = 'granted'
    FakeNotification.requested = 0
    Object.assign(page, { visibility: 'hidden', focused: false, focusCalls: 0 })
  })

  it('notifies while the tab is in the background and focuses the tab on click', () => {
    const { notify } = createNotifier({ checkbox: fakeCheckbox(), status: {} })
    notify('Kiro needs your approval', 'A tool call is waiting.', { tag: 'kiro-approval', requireInteraction: true })
    assert.equal(shown.length, 1)
    assert.deepEqual(shown[0], { title: 'Kiro needs your approval', body: 'A tool call is waiting.', tag: 'kiro-approval', requireInteraction: true })
  })

  it('stays silent while the tab is visible and focused', () => {
    Object.assign(page, { visibility: 'visible', focused: true })
    createNotifier({ checkbox: fakeCheckbox(), status: {} }).notify('Kiro finished', 'done')
    assert.equal(shown.length, 0)
  })

  it('still notifies when the tab is visible but the window is not focused', () => {
    Object.assign(page, { visibility: 'visible', focused: false })
    createNotifier({ checkbox: fakeCheckbox(), status: {} }).notify('Kiro finished', 'done')
    assert.equal(shown.length, 1)
  })

  it('stays silent when the user unticks the checkbox', () => {
    createNotifier({ checkbox: fakeCheckbox(false), status: {} }).notify('Kiro finished', 'done')
    assert.equal(shown.length, 0)
  })

  it('stays silent when the browser permission is not granted', () => {
    for (const permission of ['denied', 'default']) {
      FakeNotification.permission = permission
      createNotifier({ checkbox: fakeCheckbox(), status: {} }).notify('Kiro finished', 'done')
    }
    assert.equal(shown.length, 0)
  })

  it('asks for permission only when it is still undecided, and reports the outcome', async () => {
    FakeNotification.permission = 'default'
    const status = {}
    const { ensurePermission } = createNotifier({ checkbox: fakeCheckbox(), status })
    assert.match(status.textContent, /will ask for permission/)
    await ensurePermission()
    await ensurePermission()
    assert.equal(FakeNotification.requested, 1)
    assert.equal(status.textContent, 'Notifications are on.')
  })

  it('tells the user when notifications are blocked in the browser', () => {
    FakeNotification.permission = 'denied'
    const status = {}
    createNotifier({ checkbox: fakeCheckbox(), status })
    assert.match(status.textContent, /blocked/)
  })

  it('wires the click handler to focus the tab and close the notification', () => {
    let created
    const Original = window.Notification
    window.Notification = class extends Original {
      constructor(...args) {
        super(...args)
        created = this
      }
    }
    try {
      createNotifier({ checkbox: fakeCheckbox(), status: {} }).notify('Kiro finished', 'done')
      created.onclick()
      assert.equal(page.focusCalls, 1)
      assert.equal(created.closed, true)
    } finally {
      window.Notification = Original
    }
  })
})
