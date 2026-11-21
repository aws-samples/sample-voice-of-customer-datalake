/**
 * @fileoverview The pieces the thirteen templates are written with (UX §2.4): each template is a real v2 flow whose
 * questions carry no copy. Their texts live in `public/locales/<lng>/feedbackForms.json` under
 * `templates.<template>.…` (UX §2.3), and formTemplates.ts `templateForm` resolves them in the "Create in"
 * language when a form is made from the template. Option codes are English slugs in every locale.
 *
 * @module pages/FeedbackForms/templates/templateKit
 */
import type {
  Channel, ChoiceQuestion, ChoiceDisplay, ConsentQuestion, ContactField, ContactQuestion, MatrixQuestion,
  OpenTextQuestion, Question, RatingQuestion, Rule, RuleValue, ScoreQuestion, Shuffle,
} from '../model/formsV2'
import type { LucideIcon } from 'lucide-react'

export const TEMPLATE_GROUPS = ['loyalty', 'dropoffs', 'product', 'onboarding', 'events', 'blank'] as const
export type TemplateGroup = (typeof TEMPLATE_GROUPS)[number]

interface TemplateHiddenField {
  readonly id: string
  /** The field has a label in the catalogue (`templates.<id>.hidden.<field>`). */
  readonly labelled?: boolean
}

/** A template: its flow without copy, and where it is meant to run. */
export interface TemplateFlow {
  readonly id: string
  /** Its version (1 when unset), stored with a form made from it (`template: {id, version}`, 7.63.00): bump it when
   * a question id or code changes, so Compare can tell the forms of each version apart. */
  readonly version?: number
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

/** A matrix rating `rows` on one scale of `columns`, each `[code, score]` (7.61.00). */
export function matrix(id: string, rows: readonly string[], columns: readonly (readonly [string, number])[]): MatrixQuestion {
  return {
    id, type: 'matrix', headline: {}, required: false, rows: rows.map((code) => ({ code, label: {} })),
    columns: columns.map(([code, points]) => ({ code, label: {}, score: points })), shuffle_rows: false, display: 'auto',
  }
}

/**
 * A 1–5 rating followed by its "Ask why" follow-up (7.63.00, the builder's preset: model/askWhy.ts): an optional open
 * text that a score above 2 jumps past, to `next`.
 */
export function ratingWithWhy(id: string, next: string): [RatingQuestion, OpenTextQuestion] {
  return [rating(id, 'number', 5, [jumpWhen('gt', 2, next)]), openText(`${id}_why`, { required: false })]
}

function consent(id: string, logic?: readonly Rule[]): ConsentQuestion {
  return { id, type: 'consent', headline: {}, required: false, label: {}, logic }
}

/** A contact question with the given fields shown; `required` lists the shown ones that are required. */
function contact(id: string, shown: readonly ContactField[], required: readonly ContactField[], logic?: readonly Rule[]): ContactQuestion {
  const field = (name: ContactField) => ({ show: shown.includes(name), required: required.includes(name) })
  return {
    id, type: 'contact_info', headline: {}, required: true, logic,
    fields: { name: field('name'), email: field('email'), phone: field('phone'), company: field('company') },
  }
}

/** If the answer [op] [value] → `to`. */
export const jumpWhen = (op: Rule['when']['op'], value: RuleValue, to: string): Rule => ({ when: { op, value }, then: { jump_to: to } })

/** If the question is answered (`submitted`) or not (`skipped`) → `to`: the ops that take no value. */
const jumpIf = (op: 'submitted' | 'skipped', to: string): Rule => ({ when: { op }, then: { jump_to: to } })

/**
 * A flow's last two questions when it offers a follow-up: may we contact you (not accepted, the box left unticked:
 * on to `declined`, its plain ending), then the contact details (`shown`, the email required), which end at
 * `end_contact`. A consent compares no value: not accepted is `skipped` (schemas/form-logic-ops.json).
 */
export function followUp(shown: readonly ContactField[] = ['name', 'email'], declined = 'end_thanks'): [ConsentQuestion, ContactQuestion] {
  return [consent('q_follow_up_ok', [jumpIf('skipped', declined)]), contact('q_contact', shown, ['email'], otherwise('end_contact'))]
}

/** "Otherwise → `to`" as stored (UX §5.3): `submitted` for a required question, plus `skipped` for an optional one. */
export function otherwise(to: string, optional = false): Rule[] {
  const submitted = jumpIf('submitted', to)
  return optional ? [submitted, jumpIf('skipped', to)] : [submitted]
}
