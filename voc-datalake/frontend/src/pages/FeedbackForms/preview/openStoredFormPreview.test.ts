/**
 * @fileoverview The forms list's ⋯ › Preview (openStoredFormPreview): the window opens in the click, the stored form
 * is read when the window says it is ready and posted to it once, and a blocked window reads nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import { blankForm } from '../test/blankForm'
import { FakeBroadcastChannel, listen } from '../test/fakeBroadcastChannel'
import { knownPreviewSession, readPreviewMessage } from './previewChannel'
import { openStoredFormPreview } from './openStoredFormPreview'

const getForm = vi.hoisted(() => vi.fn())
vi.mock('../../../api/feedbackFormsV2Api', () => ({ feedbackFormsV2Api: { getForm } }))

const STORED = { ...blankForm('pl'), name: 'Exit survey' }
const words = { t: i18n.getFixedT('en', 'feedbackForms'), language: 'en' }

beforeEach(() => {
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
  getForm.mockResolvedValue({ form: STORED, meta: {} })
})

afterEach(() => {
  FakeBroadcastChannel.reset()
  window.sessionStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the list card\'s preview', () => {
  it('opens the window, then gives it the stored form once it is ready, and stops listening', async () => {
    vi.spyOn(window, 'open').mockReturnValue(window)
    vi.spyOn(window, 'focus').mockImplementation(() => {})
    expect(openStoredFormPreview(new QueryClient(), 'form_1', words)).toBe(true)
    const { channel, heard } = listen(`voc-form-preview:${knownPreviewSession('form_1') ?? ''}`)
    channel.postMessage({ type: 'voc-form-preview', action: 'ready' })
    channel.postMessage({ type: 'voc-form-preview', action: 'ready' })
    await vi.waitFor(() => expect(heard).toHaveLength(2))
    expect(heard.map((message) => readPreviewMessage(message)?.action)).toStrictEqual(['config', 'language'])
    expect([readPreviewMessage(heard[0]), getForm.mock.calls]).toMatchObject([{ name: 'Exit survey', config: { name: 'Exit survey' } }, [['form_1']]])
  })

  it('reads nothing when the browser blocked the window', () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    expect(openStoredFormPreview(new QueryClient(), 'form_1', words)).toBe(false)
    expect([getForm.mock.calls, FakeBroadcastChannel.open.size]).toStrictEqual([[], 0])
  })
})
