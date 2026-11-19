/**
 * @fileoverview The forms list's ⋯ › Preview: the preview window (previewChannel.ts) showing the STORED form, which
 * never submits. The window opens in the click itself (pop-up rules); the form is read once the window says it is
 * ready, then posted to it, and the channel closes. There is no draft to follow from the list.
 *
 * @module pages/FeedbackForms/preview/openStoredFormPreview
 */
import type { QueryClient } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { feedbackFormsV2Api } from '../../../api/feedbackFormsV2Api'
import { toWireForm } from '../model/formsV2Schema'
import { openChannel, openPreviewWindow, postPreview, previewSession, randomSeed, readPreviewMessage } from './previewChannel'
import { languageChoices } from './previewForm'
import { uiLanguage } from './usePreviewWindowSync'

/** How long the list waits for the window's `ready` before it stops listening. */
const ANSWER_WITHIN_MS = 120_000
/** A failed read is tried again when the window asks again, this many times. */
const MAX_READS = 3

const storedPreviewKey = (formId: string) => ['feedback-forms', 'v2', formId, 'preview'] as const

/** Below md the window is a tab: a phone has no window to size. */
const narrowScreen = (): boolean => typeof window.matchMedia === 'function' && !window.matchMedia('(min-width: 768px)').matches

/** Open the preview window of the stored form `formId`. False when the browser blocked the window. */
export function openStoredFormPreview(queryClient: QueryClient, formId: string, words: { readonly t: TFunction<'feedbackForms'>; readonly language: string }): boolean {
  const session = previewSession(formId)
  const channel = openChannel(session)
  const opened = openPreviewWindow({ session, ui: uiLanguage(words.language), preset: 'phone', tab: narrowScreen() })
  if (!opened || channel === null) {
    channel?.close()
    return opened
  }
  const seed = randomSeed()
  const state = { reading: false, reads: 0 }
  const stop = window.setTimeout(() => channel.close(), ANSWER_WITHIN_MS)
  const answer = async () => {
    const { form } = await queryClient.query({ queryKey: storedPreviewKey(formId), queryFn: () => feedbackFormsV2Api.getForm(formId), staleTime: 0 })
    postPreview(channel, { action: 'config', config: toWireForm(form), seed, name: form.name, languages: languageChoices(words.t, form) })
    postPreview(channel, { action: 'language', language: form.language })
  }
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (state.reading || state.reads >= MAX_READS || readPreviewMessage(event.data)?.action !== 'ready') return
    state.reading = true
    state.reads += 1
    answer().then(() => {
      window.clearTimeout(stop)
      channel.close()
    }, (error: unknown) => {
      // (the window keeps asking; the next `ready` reads again)
      console.warn('The form could not be read for its preview:', error)
      state.reading = false
    })
  }
  return true
}
