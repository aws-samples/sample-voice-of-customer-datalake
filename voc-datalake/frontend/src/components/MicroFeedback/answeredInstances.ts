/**
 * @fileoverview Which action instances this person already answered or dismissed (7.66.00): the control asks at most
 * once per instance (one generated persona set, one document, one run). Kept in this browser per person
 * (`voc-micro-feedback:<sub>`): the newest `MAX_REMEMBERED` instances, oldest dropped. Storage that is full or blocked
 * only means the control may ask again.
 *
 * @module components/MicroFeedback/answeredInstances
 */
import type { AppFeedbackAction } from '../../api/appFeedbackApi'
import { readStoredStrings } from '../../lib/storedStrings'

const PREFIX = 'voc-micro-feedback:'
export const MAX_REMEMBERED = 200

const storageKey = (sub: string | undefined) => `${PREFIX}${sub ?? 'anonymous'}`
const entryOf = (action: AppFeedbackAction, instance: string) => `${action}:${instance}`

const read = (sub: string | undefined): string[] => readStoredStrings(storageKey(sub))

export function wasAnswered(sub: string | undefined, action: AppFeedbackAction, instance: string): boolean {
  return read(sub).includes(entryOf(action, instance))
}

export function rememberAnswered(sub: string | undefined, action: AppFeedbackAction, instance: string): void {
  const entry = entryOf(action, instance)
  const kept = [...read(sub).filter((stored) => stored !== entry), entry].slice(-MAX_REMEMBERED)
  try {
    window.localStorage.setItem(storageKey(sub), JSON.stringify(kept))
  } catch {
    // Full or blocked: the control may ask again for this instance, nothing else.
  }
}
