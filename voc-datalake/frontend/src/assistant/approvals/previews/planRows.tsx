/**
 * @fileoverview Deterministic field rows for a plan step (the PlanCard and the
 * plan progress view): every argument leaf of a write (or a wait) becomes one
 * row, in document order, with placeholders spelled out — a reference reads
 * "← output of step N", `{{free}}` reads "written when it runs". Nothing here
 * comes from model prose except the literal values themselves.
 *
 * @module assistant/approvals/previews/planRows
 */
import { isRecord } from '../../../lib/typeGuards'
import { FREE_PLACEHOLDER, REFERENCE_RE } from '../../plan/schema'
import { LiteralValue, PlaceholderValue } from './PlanValues'
import type { FieldRow } from './FieldDiff'

type Translate = (key: string, options?: Record<string, unknown>) => string

/** `[path, value]` for every leaf; objects flatten to dotted paths, arrays stay one leaf. */
function leaves(value: Record<string, unknown>, prefix = ''): [string, unknown][] {
  return Object.entries(value).flatMap(([key, member]): [string, unknown][] => {
    const path = prefix === '' ? key : `${prefix}.${key}`
    return isRecord(member) ? leaves(member, path) : [[path, member]]
  })
}

function literalText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((item) => typeof item !== 'object' || item === null)) return value.map(String).join(', ')
  return JSON.stringify(value)
}

/** The one-based number of a step, by its id, for "← output of step N". */
export type StepNumberOf = (stepId: string) => number | undefined

function placeholderText(value: string, numberOf: StepNumberOf, t: Translate): { icon: 'ref' | 'free'; text: string } | undefined {
  if (value === FREE_PLACEHOLDER) return { icon: 'free', text: t('assistantTools:preview.plan.free') }
  const match = REFERENCE_RE.exec(value)
  if (match?.[1] === undefined || match[2] === undefined) return undefined
  const n = numberOf(match[1])
  return { icon: 'ref', text: t('assistantTools:preview.plan.reference', { n: n ?? match[1], output: match[2] }) }
}

/** One row per argument leaf, placeholders spelled out. */
export function planArgRows(args: Record<string, unknown>, numberOf: StepNumberOf, t: Translate): FieldRow[] {
  return leaves(args).map(([path, value]) => {
    const placeholder = typeof value === 'string' ? placeholderText(value, numberOf, t) : undefined
    const text = placeholder?.text ?? literalText(value)
    return {
      key: path,
      label: path,
      value: placeholder === undefined ? <LiteralValue text={text} /> : <PlaceholderValue icon={placeholder.icon} text={text} />,
      compare: text,
    }
  })
}
