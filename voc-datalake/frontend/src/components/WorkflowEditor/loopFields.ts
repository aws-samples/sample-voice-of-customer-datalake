/**
 * @fileoverview Pure helpers behind the loop settings form: the round budget
 * the server accepts, and the validation messages that belong to one loop.
 *
 * @module components/WorkflowEditor/loopFields
 */
import { API_WORKFLOW_LIMITS } from '../../api/workflowsApi'

/** A whole number of rounds clamped to the server's range (blank / junk → the minimum). */
export function clampRounds(raw: string): number {
  const rounds = Math.trunc(Number(raw))
  if (!Number.isFinite(rounds)) return API_WORKFLOW_LIMITS.minRounds
  return Math.max(API_WORKFLOW_LIMITS.minRounds, Math.min(API_WORKFLOW_LIMITS.maxRounds, rounds))
}

/** The validation messages about loop `index` (the server words them "loop <n> …"). */
export function loopIssues(general: readonly string[], index: number): string[] {
  const prefix = `loop ${index + 1} `
  return general.filter((message) => message.startsWith(prefix))
}
