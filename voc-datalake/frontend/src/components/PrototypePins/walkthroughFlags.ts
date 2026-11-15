/**
 * @fileoverview A viewer's walkthrough preferences (docs/prototype-builder.md Part 1), in the browser's storage
 * for the signed-in person: "don't show again" per prototype SERIES (every version of `Title (vN)`), and "seen"
 * per VERSION. Nothing on the server. "Don't show again" is the only thing stored because of a frame message;
 * "seen" is set by the page itself when it starts the walkthrough. Storage that is unavailable (private mode, a
 * full quota) reads as "nothing stored": the walkthrough then starts, as it would standalone.
 * @module components/PrototypePins/walkthroughFlags
 */

const PREFIX = 'voc-walkthrough'

export interface WalkthroughFlagScope {
  /** The signed-in person (their sub); '' when unknown. */
  readonly person: string
  readonly projectId: string
  /** The prototype series (documentEdit.seriesKeyOf). */
  readonly seriesKey: string
  readonly documentId: string
}

const dontKey = (s: WalkthroughFlagScope) => `${PREFIX}:${s.person}:dont:${s.projectId}:${s.seriesKey}`
const seenKey = (s: WalkthroughFlagScope) => `${PREFIX}:${s.person}:seen:${s.projectId}:${s.documentId}`

function read(key: string): boolean {
  try { return window.localStorage.getItem(key) === '1' } catch { return false }
}

function write(key: string): void {
  try { window.localStorage.setItem(key, '1') } catch { /* no storage: the preference lasts this page */ }
}

/** Whether the walkthrough should start by itself: the series is not "don't show again" and the version not seen. */
export function shouldAutostart(scope: WalkthroughFlagScope): boolean {
  return !read(dontKey(scope)) && !read(seenKey(scope))
}

export const markSeen = (scope: WalkthroughFlagScope): void => { write(seenKey(scope)) }
export const markDontShowAgain = (scope: WalkthroughFlagScope): void => { write(dontKey(scope)) }
