/**
 * @fileoverview The pieces the twelve templates are written with (UX §2.4): each template is a real v2 flow whose
 * questions carry no copy. Their texts live in `public/locales/<lng>/feedbackForms.json` under
 * `templates.<template>.…` (UX §2.3), and formTemplates.ts `templateForm` resolves them in the "Create in"
 * language when a form is made from the template. Option codes are English slugs in every locale.
 *
 * @module pages/FeedbackForms/templates/templateKit
 */
import type {
  Channel, ChoiceQuestion, ChoiceDisplay, ConsentQuestion, ContactField, ContactQuestion, OpenTextQuestion,
  Question, RatingQuestion, Rule, RuleValue, ScoreQuestion, Shuffle,
} from '../model/formsV2'
import type { LucideIcon } from 'lucide-react'

export const TEMPLATE_GROUPS = ['loyalty', 'dropoffs', 'product', 'onboarding', 'blank'] as const
export type TemplateGroup = (typeof TEMPLATE_GROUPS)[number]

interface TemplateHiddenField {
  readonly id: string
  /** The field has a label in the catalogue (`templates.<id>.hidden.<field>`). */
  readonly labelled?: boolean
}

/** A template: its flow without copy, and where it is meant to run. */
export interface TemplateFlow {
  readonly id: string
  readonly group: TemplateGroup
  readonly icon: LucideIcon
  readonly runs: readonly Channel[]
  readonly welcome: boolean
  readonly hidden: readonly TemplateHiddenField[]
  readonly questions: readonly Question[]
  readonly endings: readonly string[]
}

const options = (codes: readonly string[]) => codes.map((code) => ({ code, label: {} }))

interface ChoiceSettings {
  readonly required?: boolean
  readonly display?: ChoiceDisplay
  readonly shuffle?: Shuffle
  readonly other?: boolean
  readonly none?: boolean
  readonly min?: number
  readonly max?: number
  readonly logic?: readonly Rule[]
}

function choice(type: ChoiceQuestion['type'], id: string, codes: readonly string[], s: ChoiceSettings): ChoiceQuestion {
  return {
    id, type, headline: {}, required: s.required ?? true, options: options(codes),
    other: { enabled: s.other ?? false }, none: { enabled: s.none ?? false },
    shuffle: s.shuffle ?? 'none', display: s.display ?? 'auto', min: s.min, max: s.max, logic: s.logic,
  }
}

export const single = (id: string, codes: readonly string[], s: ChoiceSettings = {}) => choice('single_select', id, codes, s)
export const multi = (id: string, codes: readonly string[], s: ChoiceSettings = {}) => choice('multi_select', id, codes, s)

interface TextSettings {
  readonly required?: boolean
  readonly long?: boolean
  readonly max?: number
  readonly logic?: readonly Rule[]
}

export function openText(id: string, s: TextSettings = {}): OpenTextQuestion {
  return { id, type: 'open_text', headline: {}, required: s.required ?? true, long: s.long ?? true, input_type: 'text', max_chars: s.max, logic: s.logic }
}

export function score(type: ScoreQuestion['type'], id: string, logic?: readonly Rule[]): ScoreQuestion {
  return { id, type, headline: {}, required: true, logic }
}

export function rating(id: string, scale: RatingQuestion['scale'], range: RatingQuestion['range'], logic?: readonly Rule[]): RatingQuestion {
  return { id, type: 'rating', headline: {}, required: true, scale, range, logic }
}

export function consent(id: string, logic?: readonly Rule[]): ConsentQuestion {
  return { id, type: 'consent', headline: {}, required: false, label: {}, logic }
}

/** A contact question with the given fields shown; `required` lists the shown ones that are required. */
export function contact(id: string, shown: readonly ContactField[], required: readonly ContactField[], logic?: readonly Rule[]): ContactQuestion {
  const field = (name: ContactField) => ({ show: shown.includes(name), required: required.includes(name) })
  return {
    id, type: 'contact_info', headline: {}, required: true, logic,
    fields: { name: field('name'), email: field('email'), phone: field('phone'), company: field('company') },
  }
}

/** If the answer [op] [value] → `to`. */
export const jumpWhen = (op: Rule['when']['op'], value: RuleValue, to: string): Rule => ({ when: { op, value }, then: { jump_to: to } })

/** "Otherwise → `to`" as stored (UX §5.3): `submitted` for a required question, plus `skipped` for an optional one. */
export function otherwise(to: string, optional = false): Rule[] {
  const submitted: Rule = { when: { op: 'submitted' }, then: { jump_to: to } }
  return optional ? [submitted, { when: { op: 'skipped' }, then: { jump_to: to } }] : [submitted]
}
