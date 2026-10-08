/**
 * @fileoverview `usePageContext()` — the contract `PageContext` for the current
 * route, titled from the react-query cache when the entity is already loaded.
 *
 * Reads the project with `queryFn: skipToken` (the Breadcrumbs precedent): it
 * observes the cache entry ProjectDetail fills and never fetches on its own.
 *
 * @module assistant/page/usePageContext
 */
import { useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { skipToken, useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { projectKey } from '../../api/projectQueryKeys'
import { pageContextFromLocation } from './pageContext'
import type { PageContext } from '../contract'

const MAX_TITLE = 120

const projectNameSchema = z.object({ project: z.object({ name: z.string().min(1) }) })

function projectTitleFrom(data: unknown): string | undefined {
  const parsed = projectNameSchema.safeParse(data)
  return parsed.success ? parsed.data.project.name.slice(0, MAX_TITLE) : undefined
}

export function usePageContext(): PageContext {
  const location = useLocation()
  const base = useMemo(
    () => pageContextFromLocation({ pathname: location.pathname, search: location.search }),
    [location.pathname, location.search],
  )
  const { data } = useQuery({
    queryKey: projectKey(base.projectId),
    queryFn: skipToken,
    enabled: base.projectId !== undefined,
  })
  const title = base.projectId !== undefined ? projectTitleFrom(data) : undefined
  return useMemo(() => (title !== undefined ? { ...base, title } : base), [base, title])
}
