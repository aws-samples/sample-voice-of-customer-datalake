/**
 * @fileoverview The personas and documents the composer can mention: the project on screen,
 * read through the same query the project page uses (`GET /projects/{id}`, `projectKey`), so
 * on the project page it is already in the cache and no new route is called. And the Documents
 * Library's ready items for the `#` being typed (`GET /projects/library/suggest?q=`, at most 8), on
 * any page.
 *
 * @module assistant/mentions/useMentionSources
 */
import { useQuery } from '@tanstack/react-query'
import { projectsApi } from '../../api/projectsApi'
import { projectKey } from '../../api/projectQueryKeys'
import { libraryApi, libraryKeys } from '../../api/libraryApi'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import type { DocumentSource, LibrarySource, PersonaSource } from './mentionModel'

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

export interface LibrarySuggestions {
  items: readonly LibrarySource[]
  loading: boolean
}

const NO_LIBRARY: LibrarySuggestions = { items: [], loading: false }
/** A `#` query's suggestions stay fresh this long (the list moves when someone uploads). */
const LIBRARY_STALE_MS = 30_000

/** How long the typed `#` query settles before it is sent (one request per query, not per key). */
const SUGGEST_DEBOUNCE_MS = 150

/** The library's ready items for `query` (null: no `#` is being typed, nothing fetched). */
export function useLibrarySuggestions(query: string | null): LibrarySuggestions {
  const settled = useDebouncedValue(query, SUGGEST_DEBOUNCE_MS)
  const asked = query === null ? null : settled
  const { data, isLoading } = useQuery({
    queryKey: libraryKeys.suggest(asked ?? ''),
    queryFn: () => libraryApi.suggest(asked ?? ''),
    enabled: asked !== null,
    staleTime: LIBRARY_STALE_MS,
    placeholderData: (previous) => previous,
  })
  if (query === null) return NO_LIBRARY
  return { items: data ?? [], loading: isLoading }
}
