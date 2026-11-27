/**
 * @fileoverview Lenient boundaries of the Product tab's sources and proposals (7.104.00, docs/project-workspace.md →
 * Product tab): `GET …/product-docs`, every source route's `{doc}`, `GET …/product-proposals/latest` and the accept's
 * answer. A source without an id is dropped, a field the server drops or a later release adds never breaks the page:
 * a source from before 7.104.00 reads as a `file`, a proposal field the answer leaves out reads as a gap.
 *
 * @module api/productSourcesSchema
 */
import { z } from 'zod'
import { LIFECYCLE_STATES } from '@stream/assistant/tools/client/allowlists'
import { eachOf } from './lenientFields'
import { asRecord } from './wireRecord'
import type {
  AcceptProductProposalResult, ProductContext, ProductContextField, ProductDoc, ProductFieldMeta,
  ProductFieldProposal, ProductLifecycleState, ProductProposalLatest,
} from './projectTypes'

/** Every product-context field and its place in the form's reading order (ProductContextForm's sections). */
const FIELD_RANK: Readonly<Record<ProductContextField, number>> = {
  product_summary: 0, product_name: 1, one_liner: 2, current_state: 3, target_users: 4, problem_solved: 5,
  key_features: 6, differentiators: 7, success_metrics: 8, known_limitations: 9, non_goals: 10, free_form_notes: 11,
}

function isProductContextField(value: unknown): value is ProductContextField {
  return typeof value === 'string' && Object.hasOwn(FIELD_RANK, value)
}

/** The 12 fields in the form's order: the review's rows, the gaps panel's default questions. */
export const PRODUCT_CONTEXT_FIELDS: readonly ProductContextField[] = Object.keys(FIELD_RANK)
  .filter(isProductContextField)
  .sort((a, b) => FIELD_RANK[a] - FIELD_RANK[b])

/** A value for every field, made by `make` (the type makes leaving a field out a compile error). */
function byField<T>(make: (field: ProductContextField) => T): Record<ProductContextField, T> {
  return {
    product_summary: make('product_summary'), product_name: make('product_name'), one_liner: make('one_liner'),
    current_state: make('current_state'), target_users: make('target_users'), problem_solved: make('problem_solved'),
    key_features: make('key_features'), differentiators: make('differentiators'),
    success_metrics: make('success_metrics'), known_limitations: make('known_limitations'),
    non_goals: make('non_goals'), free_form_notes: make('free_form_notes'),
  }
}

const field = z.custom<ProductContextField>(isProductContextField)
const text = z.string().catch('')
const nullableText = z.string().nullable().catch(null)
const sourceKind = z.enum(['file', 'url', 'interview']).catch('file')
const lifecycle = z.custom<ProductLifecycleState>((value) => value === '' || LIFECYCLE_STATES.some((state) => state === value))

const docSchema = z.looseObject({
  doc_id: z.string().min(1),
  filename: text,
  content_type: text,
  size_bytes: z.number().catch(0),
  // A status this bundle does not know is not one it can poll to an end: it reads as failed, never as a spinner.
  status: z.enum(['pending', 'extracting', 'ready', 'failed']).catch('failed'),
  error: nullableText,
  extracted_chars: z.number().catch(0),
  created_at: text,
  source_kind: sourceKind,
  injection_flag: z.boolean().catch(false),
  method: z.enum(['text', 'model']).nullable().catch(null),
  pages: z.number().nullable().catch(null),
  truncated: z.boolean().catch(false),
  url: nullableText,
  final_url: nullableText,
  title: nullableText,
  interview_mode: z.enum(['typed', 'voice']).nullable().catch(null),
})

const docsEnvelope = z.looseObject({ docs: eachOf(docSchema) }).catch({ docs: [] })

/** `GET /projects/{id}/product-docs`: the sources a lenient read keeps. */
export function normalizeProductDocs(raw: unknown): { docs: ProductDoc[] } {
  return { docs: docsEnvelope.parse(raw).docs }
}

/**
 * A source route's `{doc}` (201 or 202). An answer that names no readable source throws: the request may have
 * worked, so the caller reads the list again either way.
 */
export function normalizeProductDocAnswer(raw: unknown): { doc: ProductDoc } {
  const parsed = docSchema.safeParse(asRecord(raw)?.doc)
  if (!parsed.success) throw new Error('The answer named no readable source')
  return { doc: parsed.data }
}

const citationSchema = z.looseObject({
  source_id: z.string().min(1),
  quote: text,
  page: z.number().nullable().catch(null),
  verified: z.boolean().catch(false),
})

const fieldProposalSchema = z.looseObject({
  status: z.enum(['proposed', 'unchanged', 'gap', 'conflict']).catch('gap'),
  value: text,
  citations: eachOf(citationSchema),
  confidence: z.enum(['high', 'medium', 'low']).catch('low'),
  note: text,
  seen: text,
  accepted: z.boolean().catch(false),
  current: text,
  changed_since: z.boolean().catch(false),
})

const sourceSchema = z.looseObject({
  source_id: z.string().min(1),
  doc_id: text,
  name: text,
  kind: sourceKind,
  chars_sent: z.number().catch(0),
  cut: z.boolean().catch(false),
  deleted: z.boolean().catch(false),
})

const proposalSchema = z.looseObject({
  proposal_id: z.string().min(1),
  // A status this bundle does not know is offered nothing (no accept), as a superseded one.
  status: z.enum(['open', 'partly_applied', 'applied', 'dismissed', 'superseded']).catch('superseded'),
  job_id: text,
  created_at: text,
  model_id: text,
  effort: z.enum(['max', 'xhigh']).nullable().catch(null),
  sources: eachOf(sourceSchema),
  skipped_sources: eachOf(z.looseObject({ doc_id: text, name: text, kind: sourceKind })),
  fields: z.unknown().optional().transform((value): Record<ProductContextField, ProductFieldProposal> => {
    const raw = asRecord(value) ?? {}
    return byField((name) => fieldProposalSchema.parse(raw[name] ?? {}))
  }),
  questions: eachOf(z.looseObject({ field, question: z.string().min(1) })),
})

const metaSchema = z.looseObject({
  by: z.enum(['person', 'extract', 'assistant']),
  sub: text,
  at: text,
  proposal_id: z.string().optional().catch(undefined),
  source_ids: z.array(z.string()).optional().catch(undefined),
})

function fieldMetaOf(value: unknown): Partial<Record<ProductContextField, ProductFieldMeta>> {
  const raw = asRecord(value) ?? {}
  const meta: Partial<Record<ProductContextField, ProductFieldMeta>> = {}
  for (const name of PRODUCT_CONTEXT_FIELDS) {
    const parsed = metaSchema.safeParse(raw[name])
    if (parsed.success) meta[name] = parsed.data
  }
  return meta
}

function contextOf(value: unknown): ProductContext {
  const raw = asRecord(value) ?? {}
  const strings = byField((name) => text.parse(raw[name]))
  const state = lifecycle.safeParse(raw.current_state)
  const updatedAt = typeof raw.updated_at === 'string' ? { updated_at: raw.updated_at } : {}
  return { ...strings, current_state: state.success ? state.data : '', ...updatedAt }
}

/** `GET /projects/{id}/product-proposals/latest`: an unreadable proposal reads as none (nothing to accept). */
export function normalizeProductProposalLatest(raw: unknown): ProductProposalLatest {
  const record = asRecord(raw) ?? {}
  const proposal = proposalSchema.safeParse(record.proposal)
  return {
    proposal: proposal.success ? proposal.data : null,
    context: contextOf(record.context),
    field_meta: fieldMetaOf(record.field_meta),
    sources: normalizeProductDocs({ docs: record.sources }).docs,
  }
}

const acceptSchema = z.looseObject({
  applied: eachOf(field),
  conflicts: eachOf(z.looseObject({ field, reason: z.enum(['changed', 'person_value']) })),
  status: z.enum(['open', 'partly_applied', 'applied', 'dismissed', 'superseded']).catch('open'),
}).catch({ applied: [], conflicts: [], status: 'open' })

/** `POST …/accept`'s answer: what was written, and what was not and why. */
export function normalizeAcceptResult(raw: unknown): AcceptProductProposalResult {
  return acceptSchema.parse(raw)
}
