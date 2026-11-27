/**
 * @fileoverview A question type's icon and the key of its name (UX §2.2's key): a text question reads "Short text"
 * or "Long text". Render an icon from here with `createElement` (or a member expression), not a local component
 * variable.
 *
 * @module pages/FeedbackForms/ui/typeIcons
 */
import {
  AlignLeft, CircleDot, Contact, FileCheck, Gauge, Grid3x3, ListChecks, Megaphone, SlidersHorizontal, Smile, Star, TextCursorInput,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Question, QuestionType } from '../model/formsV2'

export const TYPE_ICONS: Readonly<Record<QuestionType, LucideIcon>> = {
  single_select: CircleDot,
  multi_select: ListChecks,
  open_text: AlignLeft,
  rating: Star,
  nps: Gauge,
  csat: Smile,
  ces: SlidersHorizontal,
  statement: Megaphone,
  consent: FileCheck,
  contact_info: Contact,
  matrix: Grid3x3,
}

type Typed = Pick<Question, 'type'> & { readonly long?: boolean }

/** The icon of a question: a short text has its own. */
export function questionIcon(question: Typed): LucideIcon {
  return question.type === 'open_text' && question.long === false ? TextCursorInput : TYPE_ICONS[question.type]
}

/** The type's name as a key (`types.<type>.name`, or the short/long text names). */
export function typeNameKey(question: Typed): string {
  if (question.type !== 'open_text') return `types.${question.type}.name`
  return question.long === false ? 'types.open_text.short' : 'types.open_text.long'
}
