/**
 * @fileoverview Human-in-the-loop resume: turn resolved approval cards into the
 * `tool` messages and `resume` entries of the next run (COMMON "Resume protocol").
 *
 * - executed / failed → `status: 'resolved'`, `payload.approved: true`
 *   (a human approved; the write's own outcome is in the tool message)
 * - declined by the user → `status: 'resolved'`, `payload.approved: false`
 * - expired (auto-declined) → `status: 'cancelled'`, `payload.approved: false`
 *
 * @module assistant/thread/resume
 */
import { newId } from '../agui/client'
import { ownEntry } from '../ownEntry'
import type { Message, ResumeEntry } from '@ag-ui/core'
import type { ApprovalInterrupt, ApprovalResolution } from '../types'

/** `reason` the SPA writes on an approval that expired before anyone answered. */
export const EXPIRED_REASON = 'expired'

export function isExpired(interrupt: ApprovalInterrupt, now: number = Date.now()): boolean {
  if (interrupt.expiresAt === undefined) return false
  const at = Date.parse(interrupt.expiresAt)
  return Number.isFinite(at) && at <= now
}

export function expiredResolution(interrupt: ApprovalInterrupt): ApprovalResolution {
  return {
    interruptId: interrupt.id,
    toolCallId: interrupt.toolCallId,
    outcome: { status: 'declined', reason: EXPIRED_REASON },
  }
}

function isExpiredResolution(resolution: ApprovalResolution): boolean {
  return resolution.outcome.status === 'declined' && resolution.outcome.reason === EXPIRED_REASON
}

export function resumeEntryFor(resolution: ApprovalResolution): ResumeEntry {
  if (isExpiredResolution(resolution)) {
    return { interruptId: resolution.interruptId, status: 'cancelled', payload: { approved: false } }
  }
  return {
    interruptId: resolution.interruptId,
    status: 'resolved',
    payload: { approved: resolution.outcome.status !== 'declined' },
  }
}

function toolMessageFor(resolution: ApprovalResolution): Message {
  return {
    id: newId(),
    role: 'tool',
    toolCallId: resolution.toolCallId,
    content: JSON.stringify(resolution.outcome),
  }
}

/** Tool messages + resume entries, in the order the interrupts were raised. */
export function buildResume(
  interrupts: readonly ApprovalInterrupt[],
  resolutions: Readonly<Record<string, ApprovalResolution>>,
): { toolMessages: Message[]; resume: ResumeEntry[] } {
  const ordered = interrupts.flatMap((i) => {
    const resolution = ownEntry(resolutions, i.id)
    return resolution === undefined ? [] : [resolution]
  })
  return {
    toolMessages: ordered.map(toolMessageFor),
    resume: ordered.map(resumeEntryFor),
  }
}
