/**
 * @fileoverview How one plan argument value reads on a card: a literal (capped,
 * full text in its tooltip) or a placeholder (a reference or `{{free}}`), marked
 * with an icon in the AI tone because the value is filled at run time.
 *
 * @module assistant/approvals/previews/PlanValues
 */
import { CornerDownLeft, PenLine } from 'lucide-react'
import { Tooltip } from '../../../components/Tooltip/Tooltip'

/** A string value is at most this long on the card (the full value is in its tooltip). */
const MAX_VALUE_CHARS = 400

export function PlaceholderValue({ icon, text }: Readonly<{ icon: 'ref' | 'free'; text: string }>) {
  const Icon = icon === 'ref' ? CornerDownLeft : PenLine
  return (
    <span className="inline-flex items-center gap-1 text-aim">
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {text}
    </span>
  )
}

export function LiteralValue({ text }: Readonly<{ text: string }>) {
  const shown = text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text
  return (
    <Tooltip kind="description" content={shown === text ? undefined : text}>
      <span className="whitespace-pre-wrap">{shown}</span>
    </Tooltip>
  )
}
