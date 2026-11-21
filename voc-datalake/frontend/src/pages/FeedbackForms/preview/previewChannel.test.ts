import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  keepPreviewSession, knownPreviewSession, openPreviewWindow, previewSession, previewWindowUrl, readPreviewMessage,
  readWindowAddress,
} from './previewChannel'

afterEach(() => {
  window.sessionStorage.clear()
  vi.restoreAllMocks()
})

const MESSAGE = { type: 'voc-form-preview' } as const

describe('the preview window protocol', () => {
  it.each([
    ['ready', { ...MESSAGE, action: 'ready' }],
    ['an ending to go to', { ...MESSAGE, action: 'goTo', questionId: 'end:thanks' }],
    ['the device palette', { ...MESSAGE, action: 'scheme', scheme: null }],
    ['a language', { ...MESSAGE, action: 'language', language: 'pl' }],
  ])('reads %s as sent', (_what, message) => {
    expect(readPreviewMessage(message)).toStrictEqual(message)
  })

  it('reads a draft with its seed, name and the languages that are well formed', () => {
    const config = { ...MESSAGE, action: 'config', config: { schema_version: 2 }, seed: 7, name: 'NPS' }
    expect(readPreviewMessage({ ...config, languages: [{ value: 'pl', label: 'Polski' }, { value: 3 }] }))
      .toStrictEqual({ ...config, languages: [{ value: 'pl', label: 'Polski' }] })
  })

  it.each([
    ['an unknown palette', { ...MESSAGE, action: 'scheme', scheme: 'sepia' }],
    ['a draft without its seed', { ...MESSAGE, action: 'config', config: { schema_version: 2 } }],
    ['a goTo without a target', { ...MESSAGE, action: 'goTo' }],
    ['an inherited property as the action', { ...MESSAGE, action: 'toString' }],
    ['another type', { type: 'other', action: 'ready' }],
    ['a plain string', 'ready'],
  ])('ignores %s', (_what, data) => {
    expect(readPreviewMessage(data)).toBeNull()
  })

  it('reads its address back: the session, the app language, the size and whether it is a tab', () => {
    const url = previewWindowUrl({ session: 'abc12345-xyz', ui: 'pl', preset: 'tablet', tab: false })
    expect(url).toMatch(/^\/form-preview\.html#s=abc12345-xyz&ui=pl&p=tablet&n=\w+$/u)
    expect(readWindowAddress(url.slice(url.indexOf('#')))).toStrictEqual({ session: 'abc12345-xyz', ui: 'pl', preset: 'tablet', tab: false })
    expect(readWindowAddress('#s=abc12345-xyz&p=huge&tab=1')).toStrictEqual({ session: 'abc12345-xyz', ui: 'en', preset: 'phone', tab: true })
  })

  it.each(['#s=../../etc', '#p=phone', ''])('has no session without a valid one (%j)', (hash) => {
    expect(readWindowAddress(hash)).toBeNull()
  })

  it('keeps one session per form in this tab, so a reloaded builder finds its window again', () => {
    expect(knownPreviewSession('form_1')).toBeNull()
    const session = previewSession('form_1')
    expect([previewSession('form_1'), knownPreviewSession('form_1')]).toStrictEqual([session, session])
    expect(previewSession('form_2')).not.toBe(session)
    keepPreviewSession('form_9', session)
    expect(knownPreviewSession('form_9')).toBe(session)
  })

  it.each([
    ['phone', 'popup=yes,width=390,height=884'],
    ['rotate', 'popup=yes,width=844,height=430'],
    ['tablet', 'popup=yes,width=768,height=1064'],
    ['desktop', 'popup=yes,width=1280,height=840'],
    ['embedded', 'popup=yes,width=1280,height=520'],
  ] as const)('opens the %s pop-up at its size plus the 40 px toolbar, and brings it forward', (preset, features) => {
    const open = vi.spyOn(window, 'open').mockReturnValue(window)
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {})
    expect(openPreviewWindow({ session: 'abc12345', ui: 'en', preset, tab: false })).toBe(true)
    expect(open).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(new RegExp(`^/form-preview\\.html#s=abc12345&ui=en&p=${preset}&`, 'u')), 'voc-form-preview', features)
    expect(focus).toHaveBeenCalledExactlyOnceWith()
  })

  it('opens a plain tab on a phone, and says when the browser blocked the window', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    expect(openPreviewWindow({ session: 'abc12345', ui: 'en', preset: 'phone', tab: true })).toBe(false)
    expect(open).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/&tab=1$/u), 'voc-form-preview')
  })
})
