/**
 * @fileoverview Feedback boards' field catalogue, template defaults and client-side validation —
 * the SPA mirror of `lambda/shared/feature_board_fields.py` (docs/feature-requests.md). The
 * lockstep test (`boardFields.lockstep.test.ts`) reads that Python file as text, so a key, limit,
 * choice, template, status or total added on one side only fails the suite.
 *
 * A board has no free-form schema: its `fields` switch catalogue fields on (`enabled`) and make them
 * `required`, per level — `request` (filled once, on "New request") and `support` (a +1). Title and
 * description are always on. Every value travels in a body's `fields` object.
 *
 * @module api/boardFields
 */
import { looksLikeEmail } from '../utils/looksLikeEmail'
import { isHttpsUrl } from '../utils/httpsUrl'

export const BOARD_TEMPLATES = ['sales', 'service', 'beta', 'blank'] as const
export type BoardTemplate = typeof BOARD_TEMPLATES[number]

/** Templates whose requests need a description; elsewhere it is optional (feature_board_fields.py). */
export const DESCRIPTION_REQUIRED_TEMPLATES = ['sales', 'service'] as const satisfies readonly BoardTemplate[]
export type DescriptionRequiredTemplate = typeof DESCRIPTION_REQUIRED_TEMPLATES[number]

export const isDescriptionRequired = (template: BoardTemplate): template is DescriptionRequiredTemplate =>
  DESCRIPTION_REQUIRED_TEMPLATES.some((required) => required === template)

export const FIELD_LEVELS = ['request', 'support'] as const
export type FieldLevel = typeof FIELD_LEVELS[number]

export const IMPACT_CHOICES = ['committed', 'at_risk', 'none'] as const
const KIND_CHOICES = ['bug', 'complaint', 'missing_feature', 'question'] as const
const SEVERITY_CHOICES = ['low', 'medium', 'high', 'critical'] as const
const OUTCOME_CHOICES = ['works', 'broken', 'confusing'] as const

/** The largest amount the API accepts (`amount_usd`, whole dollars). */
export const MAX_AMOUNT_USD = 10_000_000_000
export const MAX_LINK_CHARS = 500
export const MAX_STATUSES = 8
export const MAX_STATUS_LABEL = 40
export const STATUS_KEY = /^[a-z_]{1,30}$/

/**
 * A board's own bounds (lambda/shared/feature_boards_store.py and feature_boards_audience.py, pinned
 * by boardLimits.lockstep.test.ts), so the admin editor refuses before the API does.
 */
export const BOARD_LIMITS = {
  name: 80, description: 1000, slug: 60, statuses: MAX_STATUSES, statusLabel: MAX_STATUS_LABEL, statusKey: 30,
  domains: 50, emails: 500,
} as const

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** A well-formed board slug (`^[a-z0-9]+(-[a-z0-9]+)*$`, at most 60 characters). */
export const isValidSlug = (slug: string): boolean => slug.length <= BOARD_LIMITS.slug && SLUG_PATTERN.test(slug)

export type FieldSpec =
  | { readonly type: 'text' | 'longtext'; readonly max: number }
  | { readonly type: 'email' }
  | { readonly type: 'url'; readonly max: number }
  | { readonly type: 'choice'; readonly choices: readonly string[] }
  | { readonly type: 'int'; readonly min: number; readonly max: number }

/** Every catalogue field and how its value is checked. */
export const FIELD_SPECS = {
  customer: { type: 'text', max: 160 },
  deal: { type: 'text', max: 160 },
  impact: { type: 'choice', choices: IMPACT_CHOICES },
  amount_usd: { type: 'int', min: 0, max: MAX_AMOUNT_USD },
  contact_email: { type: 'email' },
  kind: { type: 'choice', choices: KIND_CHOICES },
  severity: { type: 'choice', choices: SEVERITY_CHOICES },
  reference: { type: 'text', max: 80 },
  steps: { type: 'longtext', max: 2000 },
  affected_count: { type: 'int', min: 1, max: 1_000_000 },
  area: { type: 'text', max: 80 },
  outcome: { type: 'choice', choices: OUTCOME_CHOICES },
  rating: { type: 'int', min: 1, max: 5 },
  link: { type: 'url', max: MAX_LINK_CHARS },
  note: { type: 'longtext', max: 1000 },
} as const satisfies Readonly<Record<string, FieldSpec>>

export type FieldKey = keyof typeof FIELD_SPECS
export const FIELD_KEYS: readonly FieldKey[] = [
  'customer', 'deal', 'impact', 'amount_usd', 'contact_email', 'kind', 'severity', 'reference', 'steps',
  'affected_count', 'area', 'outcome', 'rating', 'link', 'note',
]

export function isFieldKey(value: string): value is FieldKey {
  return FIELD_KEYS.some((key) => key === value)
}

/** Each level's catalogue, in form order. */
export const LEVEL_FIELD_KEYS: Readonly<Record<FieldLevel, readonly FieldKey[]>> = {
  request: [
    'customer', 'deal', 'impact', 'amount_usd', 'contact_email', 'kind', 'severity', 'reference', 'steps',
    'affected_count', 'area', 'outcome', 'rating', 'link',
  ],
  support: ['customer', 'deal', 'impact', 'amount_usd', 'contact_email', 'note'],
}

/** One catalogue field's switches on a board. */
export interface FieldSwitch {
  readonly enabled: boolean
  readonly required: boolean
}
/** One level's switches over its catalogue (an absent key is off; read them with isEnabled / isRequired). */
export type LevelFields = Readonly<Partial<Record<FieldKey, FieldSwitch>>>
export type BoardFields = Readonly<Record<FieldLevel, LevelFields>>

export interface BoardStatus {
  readonly key: string
  readonly label: string
}

/** The figures a template totals (shared/feature_board_fields.py TEMPLATE_TOTALS). */
export type TotalKey = 'supporters' | 'customers' | 'committed_usd' | 'at_risk_usd' | 'affected' | 'avg_rating'

export interface TemplateDefaults {
  readonly fields: BoardFields
  readonly statuses: readonly BoardStatus[]
  readonly totals: readonly TotalKey[]
}

const OFF: FieldSwitch = { enabled: false, required: false }
const ON: FieldSwitch = { enabled: true, required: false }
const REQUIRED: FieldSwitch = { enabled: true, required: true }

/** `level`'s catalogue, each key off unless `on` switches it (the API's shape: the level's keys only). */
function levelWith(level: FieldLevel, on: LevelFields = {}): LevelFields {
  return Object.fromEntries(LEVEL_FIELD_KEYS[level].map((key) => [key, on[key] ?? OFF]))
}

export function isEnabled(fields: LevelFields, key: FieldKey): boolean {
  return fields[key]?.enabled === true
}

export function isRequired(fields: LevelFields, key: FieldKey): boolean {
  return isEnabled(fields, key) && fields[key]?.required === true
}

const NOTE_ONLY = levelWith('support', { note: ON })

/** Each template's starting fields, statuses (first = initial) and the totals its board shows. */
export const TEMPLATE_DEFAULTS: Readonly<Record<BoardTemplate, TemplateDefaults>> = {
  sales: {
    fields: {
      request: levelWith('request', { customer: REQUIRED, deal: ON, impact: REQUIRED, amount_usd: ON, contact_email: ON }),
      support: levelWith('support', { customer: REQUIRED, deal: ON, impact: REQUIRED, amount_usd: ON, contact_email: ON, note: ON }),
    },
    statuses: [
      { key: 'new', label: 'New' }, { key: 'under_review', label: 'Under review' }, { key: 'planned', label: 'Planned' },
      { key: 'shipped', label: 'Shipped' }, { key: 'declined', label: 'Declined' },
    ],
    totals: ['supporters', 'customers', 'committed_usd', 'at_risk_usd'],
  },
  service: {
    fields: {
      request: levelWith('request', { kind: REQUIRED, severity: REQUIRED, reference: ON, steps: ON, affected_count: ON }),
      support: NOTE_ONLY,
    },
    statuses: [
      { key: 'new', label: 'New' }, { key: 'confirmed', label: 'Confirmed' }, { key: 'fixed', label: 'Fixed' },
      { key: 'wont_fix', label: "Won't fix" },
    ],
    totals: ['supporters', 'affected'],
  },
  beta: {
    fields: {
      request: levelWith('request', { area: REQUIRED, outcome: REQUIRED, rating: ON, link: ON }),
      support: NOTE_ONLY,
    },
    statuses: [{ key: 'new', label: 'New' }, { key: 'seen', label: 'Seen' }, { key: 'fixed', label: 'Fixed' }],
    totals: ['supporters', 'avg_rating'],
  },
  blank: {
    fields: { request: levelWith('request'), support: levelWith('support') },
    statuses: [{ key: 'new', label: 'New' }, { key: 'done', label: 'Done' }],
    totals: ['supporters'],
  },
}

/** The enabled fields among `keys`, in their order. */
export function enabledFields(fields: LevelFields, keys: readonly FieldKey[]): FieldKey[] {
  return keys.filter((key) => isEnabled(fields, key))
}

export type FieldErrorCode = 'required' | 'too_long' | 'invalid_choice' | 'invalid_number' | 'out_of_range' | 'invalid_email' | 'invalid_url'

function textError(spec: FieldSpec, value: string): FieldErrorCode | undefined {
  if (spec.type === 'email') return looksLikeEmail(value) ? undefined : 'invalid_email'
  if ((spec.type === 'text' || spec.type === 'longtext' || spec.type === 'url') && value.length > spec.max) return 'too_long'
  return spec.type === 'url' && !isHttpsUrl(value) ? 'invalid_url' : undefined
}

/**
 * Why `typed` (as the visitor typed it, trimmed here) is not a valid value of `key`, or undefined.
 * An empty value is an error only when `required`.
 */
export function fieldError(key: FieldKey, typed: string, required: boolean): FieldErrorCode | undefined {
  const value = typed.trim()
  if (value === '') return required ? 'required' : undefined
  const spec: FieldSpec = FIELD_SPECS[key]
  if (spec.type === 'choice') return spec.choices.includes(value) ? undefined : 'invalid_choice'
  if (spec.type === 'int') {
    if (!/^\d+$/.test(value)) return 'invalid_number'
    const n = Number(value)
    return n < spec.min || n > spec.max ? 'out_of_range' : undefined
  }
  return textError(spec, value)
}

/** Whether `key` travels as a whole number rather than as text. */
export function isNumericField(key: FieldKey): boolean {
  return FIELD_SPECS[key].type === 'int'
}
