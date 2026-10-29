/**
 * @fileoverview Pure helpers of a feedback board: money, sorting, filtering, the support-form
 * draft and its validation over the board's fields, and the reporter name remembered in this browser.
 *
 * @module pages/FeatureRequests/boardFormat
 */
import { MAX_AMOUNT_USD, TEMPLATE_DEFAULTS, enabledFields, isRequired } from '../../api/boardFields'
import { looksLikeEmail } from '../../utils/looksLikeEmail'
import type { BoardFields, FieldKey, FieldLevel, LevelFields, TotalKey } from '../../api/boardFields'
import type { FieldValues } from '../../api/featureBoardsSchema'
import type { FeatureRequest, FeatureSupport, SupportImpact } from '../../api/featureRequestsApi'
import { FORM_ERRORS } from './boardLabels'

/** Whole US dollars in the active locale's currency spelling ("$85,000", "85.000 $"). */
export function formatUsd(amount: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
    .format(Number.isFinite(amount) ? amount : 0)
}

export const REQUEST_SORTS = ['newest', 'committed', 'at_risk', 'supporters', 'affected', 'rating'] as const
export type RequestSort = typeof REQUEST_SORTS[number]

/** The people a service request affects: the API's figure, else its supporters. */
export function peopleAffected(request: FeatureRequest): number {
  return request.totals.affected ?? request.totals.supporters
}

/** A beta request's rating: the API's average, else the reporter's own rating; undefined when unrated. */
export function averageRating(request: FeatureRequest): number | undefined {
  const own = request.fields?.rating
  return request.totals.avg_rating ?? (typeof own === 'number' ? own : undefined)
}

const SORT_VALUE: Readonly<Record<Exclude<RequestSort, 'newest'>, (request: FeatureRequest) => number>> = {
  committed: (request) => request.totals.committed_usd,
  at_risk: (request) => request.totals.at_risk_usd,
  supporters: (request) => request.totals.supporters,
  affected: peopleAffected,
  rating: (request) => averageRating(request) ?? 0,
}

/** Which sort each total offers (a board offers newest plus the sorts of the totals it shows). */
const SORT_OF_TOTAL: Readonly<Record<TotalKey, RequestSort | undefined>> = {
  supporters: 'supporters', customers: undefined, committed_usd: 'committed', at_risk_usd: 'at_risk',
  affected: 'affected', avg_rating: 'rating',
}

export function sortsFor(totals: readonly TotalKey[]): RequestSort[] {
  return ['newest', ...totals.flatMap((total) => SORT_OF_TOTAL[total] ?? [])]
}

/** A sorted copy; ties (and `newest`) order by creation time, newest first. */
export function sortRequests(requests: readonly FeatureRequest[], sort: RequestSort): FeatureRequest[] {
  const byNewest = (a: FeatureRequest, b: FeatureRequest) => b.created_at.localeCompare(a.created_at)
  if (sort === 'newest') return [...requests].sort(byNewest)
  const value = SORT_VALUE[sort]
  return [...requests].sort((a, b) => value(b) - value(a) || byNewest(a, b))
}

export interface RequestFilter {
  /** A status key of the board, or `all`. */
  readonly status: string
  readonly query: string
}

/** `status` of the request as its board reads it (an unknown key = the initial status). */
type StatusOf = (request: FeatureRequest) => string

/** The requests in `status` whose title, description or reporter mention `query` (case-insensitive). */
export function filterRequests(requests: readonly FeatureRequest[], filter: RequestFilter, statusOf: StatusOf = (request) => request.status): FeatureRequest[] {
  const needle = filter.query.trim().toLowerCase()
  return requests.filter((request) => {
    if (filter.status !== 'all' && statusOf(request) !== filter.status) return false
    if (needle === '') return true
    return [request.title, request.description, request.reporter_name, request.reporter_email]
      .some((text) => text.toLowerCase().includes(needle))
  })
}

/** The support form as typed: every field text, the amount as its digits. */
export interface SupportDraft {
  readonly customer: string
  readonly deal: string
  readonly impact: SupportImpact
  readonly amount: string
  readonly contactEmail: string
  readonly note: string
  readonly name: string
}

export const REQUEST_LIMITS = { title: 160, description: 4000 } as const

/** A person's name, or their email when they gave none. */
export function displayName(name: string, email: string): string {
  return name === '' ? email : name
}

export const SUPPORT_LIMITS = { customer: 160, deal: 160, note: 1000, name: 160, contactEmail: 254 } as const

/**
 * The customer-and-revenue fields a form shows (SupportFields), and the board's switches for them at
 * that level: `request` = "New request" (the reporter's customer, without the +1 note), `support` = a +1.
 */
export interface SupportSpec {
  readonly keys: readonly FieldKey[]
  readonly fields: LevelFields
}

const REQUEST_SUPPORT_KEYS: readonly FieldKey[] = ['customer', 'deal', 'impact', 'amount_usd', 'contact_email']
const PLUS_ONE_KEYS: readonly FieldKey[] = [...REQUEST_SUPPORT_KEYS, 'note']

/** The keys SupportFields renders (the other request fields are TemplateFields'). */
export const SUPPORT_FORM_KEYS: Readonly<Record<FieldLevel, readonly FieldKey[]>> = { request: REQUEST_SUPPORT_KEYS, support: PLUS_ONE_KEYS }

export function supportSpecOf(fields: BoardFields, level: FieldLevel): SupportSpec {
  return { keys: enabledFields(fields[level], SUPPORT_FORM_KEYS[level]), fields: fields[level] }
}

/** The Sales board's +1, the only support form there was before boards. */
const SALES_SUPPORT = supportSpecOf(TEMPLATE_DEFAULTS.sales.fields, 'support')

/** Impact starts at "committed" where the board requires one (as before boards), else at none. */
export function emptySupportDraft(name: string, spec: SupportSpec = SALES_SUPPORT): SupportDraft {
  const impact: SupportImpact = isRequired(spec.fields, 'impact') ? 'committed' : 'none'
  return { customer: '', deal: '', impact, amount: '', contactEmail: '', note: '', name }
}

/** Only the digits of what was typed (grouping marks and currency signs dropped). */
export function amountDigits(typed: string): string {
  return typed.replaceAll(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 11)
}

/** The draft's field errors, as namespaced message keys by field. Empty = valid. */
export type SupportErrors = Partial<Record<'customer' | 'amount' | 'contactEmail' | 'name', string>>

/** Whether the form asks for an amount: with a revenue impact (or, without impact, when required). */
export function asksAmount(draft: SupportDraft, spec: SupportSpec): boolean {
  if (!spec.keys.includes('amount_usd')) return false
  return spec.keys.includes('impact') ? draft.impact !== 'none' : true
}

function amountError(draft: SupportDraft, spec: SupportSpec): string | undefined {
  if (!asksAmount(draft, spec)) return undefined
  const needed = spec.keys.includes('impact') || isRequired(spec.fields, 'amount_usd')
  if (draft.amount === '' && !needed) return undefined
  const amount = Number(draft.amount)
  if (draft.amount === '' || amount <= 0) return FORM_ERRORS.amountRequired.messageKey
  return amount > MAX_AMOUNT_USD ? FORM_ERRORS.amountTooLarge.messageKey : undefined
}

function customerError(draft: SupportDraft, spec: SupportSpec): string | undefined {
  const asked = spec.keys.includes('customer') && isRequired(spec.fields, 'customer')
  return asked && draft.customer.trim() === '' ? FORM_ERRORS.customer.messageKey : undefined
}

export function validateSupport(draft: SupportDraft, spec: SupportSpec = SALES_SUPPORT): SupportErrors {
  const contact = draft.contactEmail.trim()
  const amount = amountError(draft, spec)
  const customer = customerError(draft, spec)
  return {
    ...(customer === undefined ? {} : { customer }),
    ...(draft.name.trim() === '' ? { name: FORM_ERRORS.name.messageKey } : {}),
    ...(spec.keys.includes('contact_email') && contact !== '' && !looksLikeEmail(contact) ? { contactEmail: FORM_ERRORS.contactEmail.messageKey } : {}),
    ...(amount === undefined ? {} : { amount }),
  }
}

const optional = (value: string): string | undefined => (value.trim() === '' ? undefined : value.trim())

function amountOf(draft: SupportDraft, spec: SupportSpec): number | undefined {
  if (!spec.keys.includes('amount_usd')) return undefined
  if (!asksAmount(draft, spec)) return 0
  return draft.amount === '' ? undefined : Number(draft.amount)
}

/** The `fields` of a valid draft: only the fields the form showed, none left empty. */
export function supportValuesOf(draft: SupportDraft, spec: SupportSpec = SALES_SUPPORT): FieldValues {
  const typed: ReadonlyArray<readonly [FieldKey, string | number | undefined]> = [
    ['customer', optional(draft.customer)],
    ['deal', optional(draft.deal)],
    ['impact', draft.impact],
    ['amount_usd', amountOf(draft, spec)],
    ['contact_email', optional(draft.contactEmail)?.toLowerCase()],
    ['note', optional(draft.note)],
  ]
  const values: Partial<Record<FieldKey, string | number>> = {}
  for (const [key, value] of typed) {
    if (value !== undefined && spec.keys.includes(key)) values[key] = value
  }
  return values
}

/** A draft holding a stored support, for editing it. */
export function draftOfSupport(support: FeatureSupport): SupportDraft {
  return {
    customer: support.customer,
    deal: support.deal ?? '',
    impact: support.impact,
    amount: support.impact === 'none' ? '' : String(support.amount_usd),
    contactEmail: support.contact_email ?? '',
    note: support.note ?? '',
    name: support.name,
  }
}

const NAME_KEY = 'voc-board-name'

/** The name this browser last signed a request or +1 with ('' when none). */
export function rememberedName(): string {
  try {
    return window.localStorage.getItem(NAME_KEY) ?? ''
  } catch {
    return ''
  }
}

export function rememberName(name: string): void {
  try {
    window.localStorage.setItem(NAME_KEY, name.trim())
  } catch {
    // Storage refused (private mode): the name is simply not remembered.
  }
}
