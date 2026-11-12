/**
 * The browser-saved state of a workspace: the assistant's UI record, the manual-import draft and the config store's
 * filters are saved per workspace inside one (`<name>:w/{slug}`), so what was saved in acme is not seen in juniper and
 * is back on return to acme; outside a workspace they keep their deployment-wide names. Sign-out and an expired
 * session forget every workspace's records; "Reset local settings" forgets every config record but the page's own.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stubLocationAssign } from '../test/location'
import { withMemoryLocalStorage } from '../test/memoryLocalStorage'

/** The browser's localStorage, kept in a map for this file. */
const saved = withMemoryLocalStorage()

beforeEach(() => window.sessionStorage.clear())

/** The three stores as a full page load of `pathname` creates them (each hydrates from storage when it loads). */
async function storesAt(pathname: string) {
  vi.resetModules()
  stubLocationAssign(pathname)
  const [{ useAssistantUiStore }, { useManualImportStore }, { useConfigStore }] = await Promise.all([
    import('../assistant/store/assistantStore'), import('../store/manualImportStore'), import('../store/configStore'),
  ])
  return {
    save(thread: string, text: string) {
      useAssistantUiStore.getState().setActiveThreadId(thread)
      useManualImportStore.getState().setRawText(text)
      useConfigStore.getState().setTimeRange('7d')
    },
    read: () => ({
      thread: useAssistantUiStore.getState().activeThreadId,
      draft: useManualImportStore.getState().rawText,
      timeRange: useConfigStore.getState().timeRange,
    }),
  }
}

/** A page load of `pathname` that saves a conversation in view, a draft and a 7-day filter. */
async function saveAt(pathname: string, thread: string, text: string): Promise<void> {
  const stores = await storesAt(pathname)
  stores.save(thread, text)
}

/** What a page load of `pathname` reads back. */
async function readAt(pathname: string) {
  const stores = await storesAt(pathname)
  return stores.read()
}

const FRESH = { thread: null, draft: '', timeRange: '14d' }

describe('the stores of a page load', () => {
  it('do not carry what was saved in acme into juniper', async () => {
    await saveAt('/w/acme/dashboard', 'thread-acme', 'A review from Acme Outfitters')
    await expect(readAt('/w/juniper/dashboard')).resolves.toStrictEqual(FRESH)
  })

  it('give acme back what was saved there on return, whatever juniper saved meanwhile', async () => {
    await saveAt('/w/acme/dashboard', 'thread-acme', 'A review from Acme Outfitters')
    await saveAt('/w/juniper/feedback', 'thread-juniper', 'A review from Juniper Trail Co.')
    await expect(readAt('/w/acme/chat')).resolves.toStrictEqual({ thread: 'thread-acme', draft: 'A review from Acme Outfitters', timeRange: '7d' })
  })

  it('keep the deployment-wide records outside a workspace, apart from every workspace\'s', async () => {
    await saveAt('/dashboard', 'thread-plain', 'A review')
    expect([...saved.keys()].sort((a, b) => a.localeCompare(b))).toStrictEqual(['voc-assistant-ui', 'voc-config', 'voc-manual-import'])
    await expect(readAt('/w/acme/dashboard')).resolves.toStrictEqual(FRESH)
    await expect(readAt('/settings')).resolves.toStrictEqual({ thread: 'thread-plain', draft: 'A review', timeRange: '7d' })
  })

  it.each<[string, readonly string[]]>([
    ['/w/acme/dashboard', ['voc-assistant-ui:w/acme', 'voc-config:w/acme', 'voc-manual-import:w/acme']],
    // A /w/ address no workspace can have: the gate's not-found, which opens no page.
    ['/w/ADMIN/dashboard', ['voc-assistant-ui', 'voc-config', 'voc-manual-import']],
  ])('save a page load of %s under its names', async (pathname, names) => {
    await saveAt(pathname, 'thread-acme', 'A review')
    expect(savedKeys()).toStrictEqual(names)
  })
})

const savedKeys = () => [...saved.keys()].sort((a, b) => a.localeCompare(b))

/** The helpers as a page load of `pathname` has them. */
async function helpersAt(pathname: string) {
  vi.resetModules()
  stubLocationAssign(pathname)
  return import('./workspaceStorage')
}

/** Records of acme, juniper and outside workspaces, plus a key of another store and the assistant's per-tab half. */
function seed(): void {
  for (const key of ['voc-assistant-ui', 'voc-assistant-ui:w/acme', 'voc-manual-import:w/juniper', 'voc-config', 'voc-config:w/acme', 'voc-config:w/juniper', 'voc-theme']) {
    saved.set(key, '{}')
  }
  window.sessionStorage.setItem('voc-assistant-ui:w/juniper', '{}')
  window.sessionStorage.setItem('voc-refused-workspaces', '[]')
}

describe('forgetWorkspaceStores (sign-out, an expired session)', () => {
  it('removes every workspace\'s record of the three stores and the plain assistant record, in both storages', async () => {
    seed()
    const { forgetWorkspaceStores } = await helpersAt('/w/acme/dashboard')
    forgetWorkspaceStores()
    // The plain config (filters) stays as before 6.15.00; the plain assistant record goes with the session.
    expect(savedKeys()).toStrictEqual(['voc-config', 'voc-theme'])
    expect(Object.keys(window.sessionStorage)).toStrictEqual(['voc-refused-workspaces'])
  })
})

describe('forgetOtherRecords (Reset local settings)', () => {
  it('removes every config record but the page load\'s own', async () => {
    seed()
    const { forgetOtherRecords } = await helpersAt('/w/acme/settings')
    forgetOtherRecords('voc-config')
    expect(savedKeys()).toStrictEqual(['voc-assistant-ui', 'voc-assistant-ui:w/acme', 'voc-config:w/acme', 'voc-manual-import:w/juniper', 'voc-theme'])
  })

  it('outside a workspace keeps the plain record and removes every workspace\'s', async () => {
    seed()
    const { forgetOtherRecords } = await helpersAt('/account')
    forgetOtherRecords('voc-config')
    expect(savedKeys()).toStrictEqual(['voc-assistant-ui', 'voc-assistant-ui:w/acme', 'voc-config', 'voc-manual-import:w/juniper', 'voc-theme'])
  })
})
