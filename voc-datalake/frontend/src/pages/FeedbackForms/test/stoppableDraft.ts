/**
 * A draft request that never answers and fails with an AbortError once it is stopped (StopDraftButton); every signal
 * it was given is kept, so a spec can see that Stop aborted it.
 */
import type { DraftAnswer, DraftRequest } from '../../../api/feedbackFormsV2Api'

export function stoppableDraft(signals: AbortSignal[]): (request: DraftRequest, signal?: AbortSignal) => Promise<DraftAnswer> {
  return (_request, signal) => new Promise((_resolve, reject) => {
    if (signal !== undefined) signals.push(signal)
    signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
  })
}
