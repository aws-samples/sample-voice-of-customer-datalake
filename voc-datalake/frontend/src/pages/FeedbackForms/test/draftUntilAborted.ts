/**
 * @fileoverview A stand-in for an AI draft request that never answers (the specs of Stop: Describe your form, Improve
 * with AI): it keeps the signal it was sent with in `signals` and fails as fetch does once that signal aborts.
 *
 * @module pages/FeedbackForms/test/draftUntilAborted
 */

export function draftUntilAborted<T>(signals: AbortSignal[]): (request: unknown, signal?: AbortSignal) => Promise<T> {
  return (_request, signal) => new Promise<T>((_resolve, reject) => {
    if (signal !== undefined) signals.push(signal)
    signal?.addEventListener('abort', () => { reject(new DOMException('Aborted', 'AbortError')) })
  })
}
