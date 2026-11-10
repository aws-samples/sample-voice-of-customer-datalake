/**
 * @fileoverview The pure decisions behind the approval card: are the args
 * valid, is the tool destructive, may Approve be pressed right now.
 *
 * @module assistant/approvals/approvalGate
 */
import type { ApprovalInterrupt, WriteToolDefinition } from '../types'
import type { Expiry } from './useExpiry'

/** Validation problems listed on the card (the rest are summarised by the first few). */
const MAX_LISTED_PROBLEMS = 5

export type ArgsCheck =
  | { ok: true; args: unknown }
  | { ok: false; problems: string[] }

export function checkArgs(definition: WriteToolDefinition | undefined, args: unknown): ArgsCheck {
  if (definition === undefined) return { ok: false, problems: [] }
  const parsed = definition.argsSchema.safeParse(args)
  if (parsed.success) return { ok: true, args: parsed.data }
  return {
    ok: false,
    problems: parsed.error.issues.slice(0, MAX_LISTED_PROBLEMS).map((issue) => {
      const path = issue.path.map(String).join('.')
      return path === '' ? issue.message : `${path}: ${issue.message}`
    }),
  }
}

/** Destructive if EITHER side says so — the stricter reading wins. */
export function isDestructive(interrupt: ApprovalInterrupt, definition: WriteToolDefinition | undefined): boolean {
  return interrupt.metadata?.risk === 'destructive' || definition?.risk === 'destructive'
}

export interface GateInput {
  definition: WriteToolDefinition | undefined
  check: ArgsCheck
  expiry: Expiry
  adminBlocked: boolean
  destructive: boolean
  confirmed: boolean
  disabled: boolean
  phase: 'pending' | 'declining' | 'executing'
}

export function isApprovable(input: GateInput): boolean {
  const { definition, check, expiry, adminBlocked, destructive, confirmed, disabled, phase } = input
  if (definition === undefined || !check.ok) return false
  if (expiry.expired || adminBlocked || disabled || phase !== 'pending') return false
  return !destructive || confirmed
}
