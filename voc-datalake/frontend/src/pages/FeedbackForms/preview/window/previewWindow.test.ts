/**
 * @fileoverview The preview window's page (form-preview.html): its words from the app's own catalogs, its toolbar,
 * its `ready` until a draft comes, then the widget in preview mode following the builder's messages; a new address
 * for another form starts over on that form's channel. The widget is a stub (its own specs: feedbackWidget*.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeBroadcastChannel, listen } from '../../test/fakeBroadcastChannel'
import { widget } from '../../test/widgetScriptStub'
import { readPreviewMessage } from '../previewChannel'
import { bootPreviewWindow, presetOfViewport } from './previewWindow'
import { fill, windowLanguage } from './windowWords'

vi.mock('../widgetScript', () => import('../../test/widgetScriptStub'))

/** The app's catalogs as the window reads them: Polski has some of its words, English the rest. */
const CATALOGS: Readonly<Record<string, unknown>> = {
  pl: { previewWindow: { restart: 'Od nowa', presets: { phone: 'Telefon' } } },
  en: { previewWindow: { restart: 'Restart', waiting: 'Waiting for the form. Keep it open in the builder.', sizeOption: '{{name}} · {{width}} × {{height}}' } },
}

const SESSION = 'abcd1234-session'
const CONFIG = { schema_version: 2, name: 'Exit survey', language: 'pl', languages: ['pl', 'en'] }

function serveCatalogs(): void {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const language = /\/locales\/(\w+)\//u.exec(url)?.[1] ?? ''
    const catalog = CATALOGS[language]
    return Promise.resolve({ ok: catalog !== undefined, json: () => Promise.resolve(catalog) })
  }))
}

const teardowns: (() => void)[] = []

async function boot(hash: string): Promise<void> {
  window.location.hash = hash
  teardowns.push(await bootPreviewWindow(document.body))
}

const actions = (heard: readonly unknown[]) => heard.map((message) => readPreviewMessage(message)?.action)

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
  serveCatalogs()
})

afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown()
  FakeBroadcastChannel.reset()
  document.body.replaceChildren()
  window.location.hash = ''
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the preview window\'s words', () => {
  it('fills placeholders and speaks a language the app ships, else English', () => {
    expect(fill('{{name}} · {{width}} × {{height}}', { name: 'Tablet', width: 768, height: 1024 })).toBe('Tablet · 768 × 1024')
    expect(fill('{{missing}}')).toBe('{{missing}}')
    expect([windowLanguage('pl-PL'), windowLanguage('xx'), windowLanguage('../en')]).toStrictEqual(['pl', 'en', 'en'])
  })

  it('knows a size by its viewport under the 40 px toolbar', () => {
    expect([presetOfViewport(390, 884), presetOfViewport(1280, 520), presetOfViewport(1012, 700)]).toStrictEqual(['phone', 'embedded', null])
  })
})

describe('the preview window', () => {
  it('builds its toolbar in the app\'s language, word by word from English where Polski has none, and waits', async () => {
    const { heard } = listen(`voc-form-preview:${SESSION}`)
    await boot(`#s=${SESSION}&ui=pl&p=phone`)
    expect(document.documentElement.lang).toBe('pl')
    expect(document.querySelector('button')?.textContent).toBe('Od nowa')
    expect([...document.querySelectorAll('#pw-size option')].map((option) => option.textContent).slice(0, 2)).toStrictEqual(['Telefon · 390 × 844', 'Phone, rotated · 844 × 390'])
    expect([document.querySelector('.pw-message')?.textContent, actions(heard)]).toStrictEqual(['Waiting for the form. Keep it open in the builder.', ['ready']])
  })

  it('starts the widget on the first draft, in the language and palette asked for meanwhile, then follows', async () => {
    const { channel } = listen(`voc-form-preview:${SESSION}`)
    await boot(`#s=${SESSION}&ui=en&p=phone`)
    channel.postMessage({ type: 'voc-form-preview', action: 'config', config: CONFIG, seed: 9, name: 'Exit survey', languages: [{ value: 'pl', label: 'Polski' }, { value: 'en', label: 'English' }] })
    channel.postMessage({ type: 'voc-form-preview', action: 'language', language: 'en' })
    channel.postMessage({ type: 'voc-form-preview', action: 'scheme', scheme: 'dark' })
    channel.postMessage({ type: 'voc-form-preview', action: 'goTo', questionId: 'end:thanks' })
    await vi.waitFor(() => expect(widget.startPreview).toHaveBeenCalledWith(expect.anything(), document.querySelector('.pw-stage'), CONFIG, 'en', { seed: 9, scheme: 'dark' }))
    expect(widget.handle.goTo).toHaveBeenCalledExactlyOnceWith('end:thanks')
    expect([document.title, document.querySelector('.pw-stage')?.getAttribute('aria-label')]).toStrictEqual(['Form preview · Exit survey', 'Form preview, English'])
    channel.postMessage({ type: 'voc-form-preview', action: 'config', config: { ...CONFIG, name: 'Renamed' }, seed: 9, name: 'Renamed', languages: [] })
    expect(widget.handle.update).toHaveBeenCalledExactlyOnceWith({ ...CONFIG, name: 'Renamed' })
  })

  it('asks again until a draft comes, then says it is still open, and goodbye when it goes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { channel, heard } = listen(`voc-form-preview:${SESSION}`)
    await boot(`#s=${SESSION}&ui=en&p=phone`)
    vi.advanceTimersByTime(3000)
    expect(actions(heard)).toStrictEqual(['ready', 'ready', 'ready'])
    channel.postMessage({ type: 'voc-form-preview', action: 'config', config: CONFIG, seed: 1, name: '', languages: [] })
    vi.advanceTimersByTime(3000)
    expect(actions(heard.slice(3))).toStrictEqual(['alive', 'alive'])
    window.dispatchEvent(new Event('pagehide'))
    expect(actions(heard).at(-1)).toBe('closed')
  })

  it('moves to the channel of another form when the builder opens it for that one', async () => {
    const first = listen(`voc-form-preview:${SESSION}`)
    const second = listen('voc-form-preview:efgh5678-other')
    await boot(`#s=${SESSION}&ui=en&p=phone`)
    window.location.hash = '#s=efgh5678-other&ui=en&p=phone&tab=1'
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    // (the first session hears the window leave it)
    expect([actions(first.heard), actions(second.heard)]).toStrictEqual([['ready', 'closed'], ['ready']])
    expect(FakeBroadcastChannel.named(`voc-form-preview:${SESSION}`)).toStrictEqual([first.channel])
  })

  it('says where it opens from when its address has no session', async () => {
    await boot('#p=phone')
    expect(document.body.textContent).toBe('Open this preview from the form builder.')
  })
})
