import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asPreviewHandle, startPreview } from './widgetScript'

function fakeHandle() {
  return {
    update: vi.fn(), goTo: vi.fn(), restart: vi.fn(), setLanguage: vi.fn(), setScheme: vi.fn(), destroy: vi.fn(),
    setHiddenFields: vi.fn(),
  }
}

describe('the preview handle of the widget', () => {
  it('drives the widget through the handle init returned', () => {
    const raw = fakeHandle()
    const handle = asPreviewHandle(raw)
    handle?.goTo('q_why')
    handle?.goTo('welcome')
    handle?.goTo('end:thanks')
    handle?.setLanguage('pl')
    handle?.setScheme('dark')
    handle?.setScheme(null)
    expect(raw.goTo.mock.calls).toStrictEqual([['q_why'], ['welcome'], ['end:thanks']])
    expect(raw.setLanguage).toHaveBeenCalledWith('pl')
    expect(raw.setScheme.mock.calls).toStrictEqual([['dark'], [null]])
  })

  it('is null for a widget that answers without one (older than 7.04.00)', () => {
    expect(asPreviewHandle(undefined)).toBeNull()
    expect(asPreviewHandle({ setHiddenFields: vi.fn() })).toBeNull()
  })

  it('still previews with a widget that cannot force a palette (no setScheme): forcing one does nothing', () => {
    const older: Record<string, unknown> & { restart: ReturnType<typeof vi.fn> } = fakeHandle()
    delete older['setScheme']
    const handle = asPreviewHandle(older)
    expect(handle).not.toBeNull()
    expect(() => handle?.setScheme('dark')).not.toThrow()
    handle?.restart()
    expect(older.restart).toHaveBeenCalledExactlyOnceWith()
  })

  it('starts a preview of the draft in the container, in the language asked for', () => {
    const init = vi.fn<(options: Record<string, unknown>) => unknown>(() => fakeHandle())
    const container = document.createElement('div')
    const handle = startPreview({ init }, container, { schema_version: 2 }, 'pl')
    expect(init).toHaveBeenCalledWith({ container, language: 'pl', preview: { config: { schema_version: 2 } } })
    expect(handle).not.toBeNull()
  })

  it('passes the session seed and a forced palette, and leaves out a palette the device picks', () => {
    const init = vi.fn<(options: Record<string, unknown>) => unknown>(() => fakeHandle())
    const container = document.createElement('div')
    startPreview({ init }, container, { schema_version: 2 }, 'en', { seed: 42, scheme: 'dark' })
    startPreview({ init }, container, { schema_version: 2 }, 'en', { seed: 7, scheme: null })
    expect(init.mock.calls[0]?.[0]).toStrictEqual({ container, language: 'en', preview: { config: { schema_version: 2 }, seed: 42, scheme: 'dark' } })
    expect(init.mock.calls[1]?.[0]).toStrictEqual({ container, language: 'en', preview: { config: { schema_version: 2 }, seed: 7 } })
  })
})

describe('loading the widget script', () => {
  beforeEach(() => {
    // (each test gets the module afresh: it loads the script once per page)
    vi.resetModules()
    document.head.replaceChildren()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const loader = async () => (await import('./widgetScript')).loadWidget
  const widgetScripts = () => [...document.head.querySelectorAll('script')]

  it('answers the API at once when the page already has it', async () => {
    const api = { init: vi.fn<(options: Record<string, unknown>) => unknown>() }
    vi.stubGlobal('VoCFeedbackForm', api)
    const loadWidget = await loader()
    await expect(loadWidget()).resolves.toBe(api)
    expect(widgetScripts()).toStrictEqual([])
  })

  it('adds the widget\'s script once, and answers its API when it ran', async () => {
    const loadWidget = await loader()
    const loads = Promise.all([loadWidget(), loadWidget()])
    const api = { init: vi.fn<(options: Record<string, unknown>) => unknown>() }
    vi.stubGlobal('VoCFeedbackForm', api)
    widgetScripts()[0]?.dispatchEvent(new Event('load'))
    await expect(loads).resolves.toStrictEqual([api, api])
    expect(widgetScripts().map((script) => [script.async, script.getAttribute('src')])).toStrictEqual([[true, expect.stringMatching(/feedback-widget\.js/)]])
  })

  it('fails when the script ran without the widget\'s API', async () => {
    const loadWidget = await loader()
    const load = loadWidget()
    widgetScripts()[0]?.dispatchEvent(new Event('load'))
    await expect(load).rejects.toThrow('The feedback widget loaded without its API.')
  })

  it('fails when the script cannot be loaded, and tries again on the next call', async () => {
    const loadWidget = await loader()
    const load = loadWidget()
    widgetScripts()[0]?.dispatchEvent(new Event('error'))
    await expect(load).rejects.toThrow('The feedback widget could not be loaded.')
    void loadWidget()
    expect(widgetScripts()).toHaveLength(2)
  })
})
