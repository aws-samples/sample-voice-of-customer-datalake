/**
 * @fileoverview One AI draft request at a time (the picker's "Describe your form" and the builder's "Improve with
 * AI"): its busy state, Cancel (the request is aborted), and why it failed (aiRefusal.ts). After a rate limit, the
 * request waits until its time is up (`waitMinutes` counts down, visible beside Draft it).
 *
 * @module pages/FeedbackForms/ai/useAiDraftRequest
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { feedbackFormsV2Api } from '../../../api/feedbackFormsV2Api'
import type { DraftAnswer, DraftRequest } from '../../../api/feedbackFormsV2Api'
import { aiRefusalOf, isAbort } from './aiRefusal'
import type { AiRefusal } from './aiRefusal'
import { noCleanup } from '../../../hooks/noCleanup'

const TICK_MS = 15_000

export interface AiDraftRequest {
  readonly busy: boolean
  readonly refusal: AiRefusal | null
  /** Minutes left of a rate limit (0: none, Draft it may be pressed). */
  readonly waitMinutes: number
  /** Ask; resolves to the draft, or null when it failed (see `refusal`) or was cancelled. */
  readonly run: (request: DraftRequest) => Promise<DraftAnswer | null>
  readonly cancel: () => void
  /** Forget the last refusal (the person edits their text, or presses Try again). */
  readonly clear: () => void
}

export function useAiDraftRequest(): AiDraftRequest {
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<AiRefusal | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const controller = useRef<AbortController | null>(null)

  const until = refusal?.kind === 'rateLimited' ? refusal.until : 0
  useEffect(() => {
    if (until === 0) return noCleanup
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS)
    return () => window.clearInterval(timer)
  }, [until])
  useEffect(() => () => controller.current?.abort(), [])

  const run = useCallback(async (request: DraftRequest): Promise<DraftAnswer | null> => {
    controller.current?.abort()
    const own = new AbortController()
    controller.current = own
    setBusy(true)
    setRefusal(null)
    try {
      const answer = await feedbackFormsV2Api.draftForm(request, own.signal)
      return own.signal.aborted ? null : answer
    } catch (error) {
      if (!isAbort(error, own.signal)) {
        setNow(Date.now())
        setRefusal(aiRefusalOf(error))
      }
      return null
    } finally {
      if (controller.current === own) {
        controller.current = null
        setBusy(false)
      }
    }
  }, [])

  const cancel = useCallback(() => {
    controller.current?.abort()
    controller.current = null
    setBusy(false)
  }, [])

  const clear = useCallback(() => setRefusal((current) => (current?.kind === 'rateLimited' ? current : null)), [])
  const waitMinutes = until > now ? Math.max(1, Math.ceil((until - now) / 60_000)) : 0
  return { busy, refusal, waitMinutes, run, cancel, clear }
}
