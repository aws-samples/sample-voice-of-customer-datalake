/**
 * @fileoverview The personas and documents the composer can mention: the project on screen,
 * read through the same query the project page uses (`GET /projects/{id}`, `projectKey`), so
 * on the project page it is already in the cache and no new route is called.
 *
 * @module assistant/mentions/useMentionSources
 */
import { useQuery } from '@tanstack/react-query'
import { projectsApi } from '../../api/projectsApi'
import { projectKey } from '../../api/projectQueryKeys'
import type { DocumentSource, PersonaSource } from './mentionModel'

export interface MentionSources {
  personas: readonly PersonaSource[]
  documents: readonly DocumentSource[]
  loading: boolean
}

const NONE: MentionSources = { personas: [], documents: [], loading: false }
/** The picker may show a list a minute old; the project page refreshes the same query itself. */
const STALE_MS = 60_000

/** Empty (and nothing fetched) when there is no project on screen. */
export function useMentionSources(projectId: string | undefined): MentionSources {
  const { data, isLoading } = useQuery({
    queryKey: projectKey(projectId),
    queryFn: () => (projectId === undefined ? Promise.reject(new Error('No project on screen')) : projectsApi.getProject(projectId)),
    enabled: projectId !== undefined,
    staleTime: STALE_MS,
  })
  if (projectId === undefined) return NONE
  return { personas: data?.personas ?? [], documents: data?.documents ?? [], loading: isLoading }
}
