/**
 * @fileoverview The company persona library (Knowledge → Company → Personas, 5.60) and
 * the project-side routes that move personas between it and projects.
 *
 * Company routes: `/company-personas` (any signed-in user reads; admins write).
 * Project routes: `POST /projects/{id}/personas/{pid}/promote` (edit + admin),
 * `GET /projects/{id}/personas/copy-sources` (view), `POST /projects/{id}/personas/copy`
 * (edit). Every copy is independent (a new id) and never carries research notes.
 *
 * Research notes are saved with the persona PUT (`research_notes`), as on the project page.
 *
 * @module api/companyPersonasApi
 */
import { del, post, put } from './requestKit'
import { fetchApi } from './client'
import { getDateBasisBodyParams } from './baseUrl'
import { isAssistJobType, runAssistJob } from './assistJobs'
import { parseRegeneratedAvatar } from './assistResults'
import {
  normalizeCompanyPersonas, normalizeCopyAnswer, normalizeCopySources,
} from './companyPersonasSchema'
import type { PersonaCopySources } from './companyPersonasSchema'
import type { ProjectJob, ProjectPersona } from './projectTypes'

/** The persona generator's request body (the project route's, minus the add/replace choice). */
export interface PersonaGenerateBody {
  sources?: string[]
  categories?: string[]
  sentiments?: string[]
  persona_count?: number
  custom_instructions?: string
  days?: number
  response_language?: string
  generate_avatars?: boolean
}

/** `POST …/personas/import` (no 'pdf': the API refuses it). */
export interface PersonaImportBody {
  input_type: 'image' | 'text'
  content: string
  media_type?: string
}

export interface JobStartAnswer {
  success: boolean
  job_id: string
  status: string
  message: string
}

/** Where a project copies personas from: the library, or another project the caller owns or belongs to. */
export type PersonaCopySource = { scope: 'company' } | { scope: 'project'; project_id: string }

const BASE = '/company-personas'

/** One library persona's path; ids are encoded once, here (the project-side paths encode the project id inline). */
const personaPath = (personaId: string) => `${BASE}/${encodeURIComponent(personaId)}`

export const companyPersonasKey = () => ['company-personas'] as const
export const companyPersonaJobsKey = () => ['company-persona-jobs'] as const

export const companyPersonasApi = {
  list: async (): Promise<{ personas: ProjectPersona[]; canEdit: boolean }> =>
    normalizeCompanyPersonas(await fetchApi<unknown>(BASE)),

  /** Always additive on the server (`keep_existing_personas` is forced true): replace would wipe the library. */
  generate: (body: PersonaGenerateBody) =>
    fetchApi<JobStartAnswer>(`${BASE}/generate`, post({ ...getDateBasisBodyParams(), ...body })),

  importPersona: (body: PersonaImportBody) =>
    fetchApi<JobStartAnswer>(`${BASE}/import`, post(body)),

  getJobs: async (): Promise<{ jobs: ProjectJob[] }> => {
    const answer = await fetchApi<{ jobs?: ProjectJob[] }>(`${BASE}/jobs`)
    const jobs = Array.isArray(answer.jobs) ? answer.jobs : []
    return { jobs: jobs.filter((job) => !isAssistJobType(job.job_type)) }
  },

  getJobStatus: (jobId: string) =>
    fetchApi<ProjectJob>(`${BASE}/jobs/${encodeURIComponent(jobId)}`),

  updatePersona: (personaId: string, data: Partial<Omit<ProjectPersona, 'persona_id' | 'created_at'>>) =>
    fetchApi<{ success: boolean }>(personaPath(personaId), put(data)),

  deletePersona: (personaId: string) =>
    fetchApi<{ success: boolean }>(personaPath(personaId), del()),

  /** An assist job, polled on `GET /company-personas/jobs/{job_id}`. */
  regeneratePersonaAvatar: (personaId: string): Promise<{ avatar_url: string | null }> =>
    runAssistJob(
      () => fetchApi<unknown>(`${personaPath(personaId)}/regenerate-avatar`, post()),
      (jobId) => companyPersonasApi.getJobStatus(jobId),
      parseRegeneratedAvatar,
    ),

  /**
   * Copy a project persona into the company library (admin). The answer's new company copy
   * is not read: the library list is refetched instead.
   */
  promotePersona: async (projectId: string, personaId: string): Promise<void> => {
    await fetchApi<unknown>(`/projects/${encodeURIComponent(projectId)}/personas/${encodeURIComponent(personaId)}/promote`, post())
  },

  getPersonaCopySources: async (projectId: string): Promise<PersonaCopySources> =>
    normalizeCopySources(await fetchApi<unknown>(`/projects/${encodeURIComponent(projectId)}/personas/copy-sources`)),

  copyPersonas: async (projectId: string, body: { source: PersonaCopySource; persona_ids: string[] }): Promise<{ personas: ProjectPersona[] }> =>
    normalizeCopyAnswer(await fetchApi<unknown>(`/projects/${encodeURIComponent(projectId)}/personas/copy`, post(body))),
}
