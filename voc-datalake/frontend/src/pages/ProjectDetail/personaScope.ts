/**
 * @fileoverview Where a persona UI reads and writes: one project's personas, or the
 * company library (Knowledge → Company → Personas, 5.60).
 *
 * The persona list, detail, edit, import, generate, notes and avatar UI is shared by
 * both. Each takes a `PersonaScope` and reaches the API through `personaScopeApi`, so the
 * components are written once and the routes stay separate (company personas are never
 * reachable through `/projects/{id}/...`).
 *
 * @module pages/ProjectDetail/personaScope
 */
import { companyPersonaJobsKey, companyPersonasApi, companyPersonasKey } from '../../api/companyPersonasApi'
import type { JobStartAnswer, PersonaImportBody } from '../../api/companyPersonasApi'
import { projectsApi } from '../../api/projectsApi'
import { projectJobsKey, projectKey } from '../../api/projectQueryKeys'
import type { ProjectPersona } from '../../api/projectTypes'

export type PersonaScope = { readonly kind: 'project'; readonly projectId: string } | { readonly kind: 'company' }

export const COMPANY_PERSONA_SCOPE: PersonaScope = { kind: 'company' }

/** A project's personas; an unresolved route id reads as '' (its queries are disabled until it resolves). */
export const projectPersonaScope = (projectId: string | undefined): PersonaScope => ({ kind: 'project', projectId: projectId ?? '' })

/**
 * The persona writes a scope offers; project scope keeps calling `projectsApi` exactly as before.
 * Generation is not here: the project wizard keeps its add/replace choice, the library is always added to.
 */
export interface PersonaScopeApi {
  readonly updatePersona: (personaId: string, data: Partial<Omit<ProjectPersona, 'persona_id' | 'created_at'>>) => Promise<{ success: boolean }>
  readonly deletePersona: (personaId: string) => Promise<{ success: boolean }>
  readonly regeneratePersonaAvatar: (personaId: string) => Promise<{ avatar_url: string | null }>
  readonly importPersona: (body: PersonaImportBody) => Promise<JobStartAnswer>
}

export function personaScopeApi(scope: PersonaScope): PersonaScopeApi {
  if (scope.kind === 'company') {
    return {
      updatePersona: (personaId, data) => companyPersonasApi.updatePersona(personaId, data),
      deletePersona: (personaId) => companyPersonasApi.deletePersona(personaId),
      regeneratePersonaAvatar: (personaId) => companyPersonasApi.regeneratePersonaAvatar(personaId),
      importPersona: (body) => companyPersonasApi.importPersona(body),
    }
  }
  const { projectId } = scope
  return {
    updatePersona: (personaId, data) => projectsApi.updatePersona(projectId, personaId, data),
    deletePersona: (personaId) => projectsApi.deletePersona(projectId, personaId),
    regeneratePersonaAvatar: (personaId) => projectsApi.regeneratePersonaAvatar(projectId, personaId),
    importPersona: (body) => projectsApi.importPersona(projectId, body),
  }
}

/** The query that holds the scope's personas (the project detail, or the library list). */
export function personaScopeKey(scope: PersonaScope) {
  return scope.kind === 'company' ? companyPersonasKey() : projectKey(scope.projectId)
}

/** The query that holds the scope's jobs list. */
export function personaScopeJobsKey(scope: PersonaScope) {
  return scope.kind === 'company' ? companyPersonaJobsKey() : projectJobsKey(scope.projectId)
}
