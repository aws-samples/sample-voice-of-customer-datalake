/**
 * @fileoverview Spec support for the Product tab's sources, extract and proposal review (7.104.00): a source row, a
 * proposal field, a latest-proposal answer and an extract stub, each with neutral sample values.
 */
import { vi } from 'vitest'
import { emptyProductContext } from './productContextFields'
import type {
  ProductContextField, ProductDoc, ProductFieldProposal, ProductProposal, ProductProposalLatest, ProjectJob,
} from '../../api/projectTypes'
import type { ProductExtract } from './useProductExtract'

export const PROJECT = 'proj-1'
export const DOCS_PATH = `/projects/${PROJECT}/product-docs`

/** A ready Markdown file unless told otherwise. */
export function sourceDoc(overrides: Partial<ProductDoc> = {}): ProductDoc {
  return {
    doc_id: 'doc-1', filename: 'brief.md', content_type: 'text/markdown', size_bytes: 2048, status: 'ready', error: null,
    extracted_chars: 900, created_at: '2026-11-20T10:00:00Z', source_kind: 'file', injection_flag: false, method: 'text',
    pages: null, truncated: false, url: null, final_url: null, title: null, interview_mode: null, ...overrides,
  }
}

/** One field of a proposal: a gap unless told otherwise. */
export function fieldProposal(overrides: Partial<ProductFieldProposal> = {}): ProductFieldProposal {
  return {
    status: 'gap', value: '', citations: [], confidence: 'low', note: '', seen: '', accepted: false, current: '',
    changed_since: false, ...overrides,
  }
}

/** Every field a gap. */
const gaps = (): Record<ProductContextField, ProductFieldProposal> => ({
  product_summary: fieldProposal(), product_name: fieldProposal(), one_liner: fieldProposal(), current_state: fieldProposal(),
  target_users: fieldProposal(), problem_solved: fieldProposal(), key_features: fieldProposal(),
  differentiators: fieldProposal(), success_metrics: fieldProposal(), known_limitations: fieldProposal(),
  non_goals: fieldProposal(), free_form_notes: fieldProposal(),
})

/** An open proposal from one source (S1, the Markdown brief above): every field a gap but those given. */
export function proposalOf(fields: Partial<Record<ProductContextField, ProductFieldProposal>>, overrides: Partial<ProductProposal> = {}): ProductProposal {
  const all = { ...gaps(), ...fields }
  return {
    proposal_id: 'pp-1', status: 'open', job_id: 'job-1', created_at: '2026-11-25T09:00:00Z', model_id: 'global.anthropic.claude-sonnet-5-5',
    effort: 'max', sources: [{ source_id: 'S1', doc_id: 'doc-1', name: 'brief.md', kind: 'file', chars_sent: 900, cut: false, deleted: false }],
    skipped_sources: [], fields: all, questions: [], ...overrides,
  }
}

/** The latest-proposal answer (`GET …/product-proposals/latest`) around a proposal. */
export function latestOf(proposal: ProductProposal | null, overrides: Partial<ProductProposalLatest> = {}): ProductProposalLatest {
  return { proposal, context: emptyProductContext(), field_meta: {}, sources: [sourceDoc()], ...overrides }
}

/** An extract job row as the jobs list answers it. */
export function extractJob(overrides: Partial<ProjectJob> = {}): ProjectJob {
  return {
    job_id: 'job-1', job_type: 'extract_product_description', status: 'running', progress: 40, current_step: 'thinking',
    created_at: '2026-11-25T09:00:00Z', ...overrides,
  }
}

/** The extract hook's answer, idle unless told otherwise. */
export function extractStub(overrides: Partial<ProductExtract> = {}): ProductExtract {
  return { job: null, running: false, stale: false, elapsed: 0, startError: null, pending: false, start: vi.fn(), ...overrides }
}
