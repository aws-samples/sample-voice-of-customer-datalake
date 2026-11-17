/**
 * @fileoverview A step's assertions as it stores them (7.52.00 C2: `params.assert`, `[{check, args?, on_fail?}]`), the
 * readable ones.
 *
 * @module components/WorkflowEditor/inspector/assertions
 */
import { isRecord } from '../../../lib/typeGuards'

/** One assertion as a step stores it. */
export interface StepAssertion {
  readonly check: string
  readonly args?: Readonly<Record<string, unknown>>
  readonly on_fail?: string
}

/** A step's stored assertions, the readable ones. */
export function assertionsOf(raw: unknown): StepAssertion[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item: unknown) => {
    if (!isRecord(item) || typeof item.check !== 'string') return []
    return [{
      check: item.check,
      ...(isRecord(item.args) ? { args: item.args } : {}),
      ...(typeof item.on_fail === 'string' ? { on_fail: item.on_fail } : {}),
    }]
  })
}

