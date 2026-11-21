/**
 * @fileoverview A persona's evidence and a saved focus group (docs/project-workspace.md → Persona focus groups).
 *
 * - `GET /projects/{id}/personas/{pid}/evidence-freshness` → how many matching reviews arrived since the persona was
 *   generated or its evidence last refreshed, of those the person may see (the persona header's badge);
 * - `POST /projects/{id}/personas/{pid}/evidence/refresh` → append them to the persona's `evidence_updates` (edit
 *   access; the persona's text is never rewritten);
 * - `POST /projects/{id}/documents` with `document_type: 'focus_group'` → the transcript, synthesis and citations as a
 *   document of the Documents section, always synthetic.
 *
 * Every answer is parsed leniently: a field the server drops or a later release adds never breaks the page.
 *
 * @module api/personaGroundingApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { post } from './requestKit'
import { normalizeProjectDocument } from './projectDetailSchema'
import { asRecord } from './wireRecord'
import type { ProjectDocument } from './types'

const freshnessSchema = z.object({
  since: z.string().catch(''),
  count: z.number().int().nonnegative().catch(0),
  count_is_lower_bound: z.boolean().catch(false),
  refreshed_at: z.string().nullish().catch(null).transform((value) => value ?? null),
  updates: z.number().int().nonnegative().catch(0),
})

type EvidenceFreshness = z.infer<typeof freshnessSchema>

const refreshSchema = z.object({
  added: z.number().int().nonnegative().catch(0),
  evidence_refreshed_at: z.string().nullish().catch(null).transform((value) => value ?? null),
})

type EvidenceRefresh = z.infer<typeof refreshSchema>

/** What a saved focus group records besides its text (the server validates and bounds every list). */
interface FocusGroupDerivation {
  persona_ids: string[]
  feedback_ids: string[]
  document_ids: string[]
  library_item_ids: string[]
  rounds: number
}

interface FocusGroupDocumentBody {
  title: string
  content: string
  derivation: FocusGroupDerivation
}

function projectPersonaPath(projectId: string, personaId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/personas/${encodeURIComponent(personaId)}`
}

export const personaGroundingApi = {
  getEvidenceFreshness: async (projectId: string, personaId: string): Promise<EvidenceFreshness> =>
    freshnessSchema.parse(asRecord(await fetchApi<unknown>(`${projectPersonaPath(projectId, personaId)}/evidence-freshness`)) ?? {}),

  refreshEvidence: async (projectId: string, personaId: string): Promise<EvidenceRefresh> =>
    refreshSchema.parse(asRecord(await fetchApi<unknown>(`${projectPersonaPath(projectId, personaId)}/evidence/refresh`, post())) ?? {}),

  saveFocusGroup: async (projectId: string, body: FocusGroupDocumentBody): Promise<{ document: ProjectDocument | null }> => {
    const raw = await fetchApi<unknown>(`/projects/${encodeURIComponent(projectId)}/documents`,
      post({ ...body, document_type: 'focus_group' }))
    return { document: normalizeProjectDocument(asRecord(raw)?.document) }
  },
}
