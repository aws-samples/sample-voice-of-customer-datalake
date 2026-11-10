/**
 * @fileoverview Decision record writes (`/projects/{id}/decisions*`, projects Lambda).
 * Reads need no route: a decision is a project document, listed by `GET /projects/{id}`.
 * @module api/decisionsApi
 */
import { post } from './requestKit'
import { z } from 'zod'
import { fetchApi } from './client'
import { normalizeProjectDocument } from './projectDetailSchema'
import { asRecord } from './wireRecord'
import type { Verdict } from './decisionSchema'
import type { ProjectDocument } from './types'

/** The request body of a create; an edit sends the same fields plus `expected_revision`. */
export interface DecisionInput {
  title: string
  verdict: Verdict
  rationale: string
  success_metric: string
  kill_criterion: string
  evidence: { feedback_ids: string[]; document_ids: string[] }
  review_by: string | null
  launched_at: string | null
}

const PursueResponseSchema = z.object({ job_id: z.string().min(1) })

const savedDocument = (raw: unknown): ProjectDocument | null => normalizeProjectDocument(asRecord(raw)?.document)

export const decisionsApi = {
  createDecision: async (projectId: string, input: DecisionInput) => savedDocument(
    await fetchApi<unknown>(`/projects/${projectId}/decisions`, post(input)),
  ),

  updateDecision: async (projectId: string, documentId: string, input: DecisionInput, expectedRevision: number) => {
    const body = JSON.stringify({ ...input, expected_revision: expectedRevision })
    return savedDocument(await fetchApi<unknown>(
      `/projects/${projectId}/decisions/${encodeURIComponent(documentId)}`, { method: 'PUT', body },
    ))
  },

  /** "Pursue" → the existing PR/FAQ generation, seeded with the decision. Answers the job id. */
  pursueDecision: async (projectId: string, documentId: string, responseLanguage: string): Promise<string> => {
    const body = JSON.stringify({ response_language: responseLanguage })
    const raw = await fetchApi<unknown>(
      `/projects/${projectId}/decisions/${encodeURIComponent(documentId)}/pursue`, { method: 'POST', body },
    )
    return PursueResponseSchema.parse(raw).job_id
  },
}
