/**
 * @fileoverview The data behind "Copy from…" (5.60): where personas can come from
 * (`GET /projects/{id}/personas/copy-sources`), the chosen source's personas (the
 * library list comes with the sources; a project's from `GET /projects/{source_id}`),
 * the selection (1–20) and the copy itself.
 *
 * @module pages/ProjectDetail/useCopyPersonas
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { companyPersonasApi } from '../../api/companyPersonasApi'
import type { PersonaCopySource } from '../../api/companyPersonasApi'
import { MAX_PERSONAS_PER_COPY } from '../../api/companyPersonasSchema'
import type { PersonaSummary } from '../../api/companyPersonasSchema'
import { projectsApi } from '../../api/projectsApi'
import { projectKey } from '../../api/projectQueryKeys'
import type { ProjectPersona } from '../../api/projectTypes'

/** The source picker's value: the library, or a project id. */
export const COMPANY_SOURCE = 'company'

/** Every project's copy-sources read (a promote changes the library part of all of them). */
export const copySourcesRootKey = () => ['persona-copy-sources'] as const

const copySourcesKey = (projectId: string) => [...copySourcesRootKey(), projectId] as const

function toSummary(persona: ProjectPersona): PersonaSummary {
  return {
    persona_id: persona.persona_id,
    name: persona.name,
    tagline: persona.tagline,
    avatar_url: persona.avatar_url ?? null,
    copied_from: persona.copied_from,
  }
}

function sourceOf(value: string): PersonaCopySource {
  return value === COMPANY_SOURCE ? { scope: 'company' } : { scope: 'project', project_id: value }
}

/** The selection after ticking or unticking one persona; never more than the route accepts. */
export function toggledSelection(selected: readonly string[], personaId: string): readonly string[] {
  if (selected.includes(personaId)) return selected.filter((id) => id !== personaId)
  // At the limit the same array comes back, so React skips the re-render.
  return selected.length >= MAX_PERSONAS_PER_COPY ? selected : [...selected, personaId]
}

/** `onCopied` gets the copies written (the page selects the first). */
export function useCopyPersonas(projectId: string, onCopied: (copies: ProjectPersona[]) => void) {
  const queryClient = useQueryClient()
  const [source, setSourceValue] = useState(COMPANY_SOURCE)
  const [selected, setSelected] = useState<readonly string[]>([])

  const sources = useQuery({
    queryKey: copySourcesKey(projectId),
    queryFn: () => companyPersonasApi.getPersonaCopySources(projectId),
    retry: false,
  })
  const sourceProject = useQuery({
    queryKey: projectKey(source),
    queryFn: () => projectsApi.getProject(source),
    enabled: source !== COMPANY_SOURCE,
    retry: false,
  })
  const copy = useMutation({
    mutationFn: () => companyPersonasApi.copyPersonas(projectId, { source: sourceOf(source), persona_ids: [...selected] }),
    onSuccess: ({ personas: copies }) => {
      void queryClient.invalidateQueries({ queryKey: projectKey(projectId) })
      onCopied(copies)
    },
  })

  const isCompany = source === COMPANY_SOURCE
  const personas: PersonaSummary[] = isCompany
    ? sources.data?.company ?? []
    : (sourceProject.data?.personas ?? []).map(toSummary)

  return {
    source,
    /** A new source starts a new selection (ids belong to one source). */
    setSource: (value: string) => { setSourceValue(value); setSelected([]); copy.reset() },
    projects: sources.data?.projects ?? [],
    personas,
    isLoadingPersonas: isCompany ? sources.isLoading : sourceProject.isLoading,
    loadFailed: sources.isError || (!isCompany && sourceProject.isError),
    selected,
    toggle: (personaId: string) => setSelected((current) => toggledSelection(current, personaId)),
    copy,
  }
}
