// Desktop notifications for the bridge page (Notification API; no push service,
// nothing leaves this machine). They fire only while the tab is in the
// background. Bodies are deliberately generic: a notification can appear on a
// lock screen, so it never contains the command, file paths, or agent text.

export function createNotifier({ checkbox, status }) {
  // Always read through window so there is exactly one reference to the API
  const api = () => window.Notification
  const supported = typeof api() === 'function'

  function describe() {
    if (!supported) {
      status.textContent = 'This browser does not support notifications.'
      checkbox.disabled = true
    } else if (api().permission === 'denied') {
      status.textContent = 'Notifications are blocked for this page in the browser settings.'
    } else if (api().permission === 'granted') {
      status.textContent = checkbox.checked ? 'Notifications are on.' : 'Notifications are off.'
    } else {
      status.textContent = 'The browser will ask for permission when you connect.'
    }
  }

  /** Must be called from a user gesture (click/submit) for the browser to show its prompt. */
  async function ensurePermission() {
    if (supported && checkbox.checked && api().permission === 'default') {
      await api().requestPermission()
    }
    describe()
  }

  function notify(title, body, { tag, requireInteraction = false } = {}) {
    if (!supported || !checkbox.checked || api().permission !== 'granted') return
    if (document.visibilityState === 'visible' && document.hasFocus()) return
    const Api = api()
    const notification = new Api(title, { body, tag, requireInteraction })
    notification.onclick = () => {
      window.focus()
      notification.close()
    }
  }

  checkbox.addEventListener('change', () => void ensurePermission())
  describe()
  return { ensurePermission, notify }
}
