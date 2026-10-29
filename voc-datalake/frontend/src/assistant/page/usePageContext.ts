/**
 * @fileoverview `usePageContext()` — the contract `PageContext` for the current
 * route, titled from the react-query cache when the entity is already loaded:
 * the project's name on a project page, the agent's name on an agent page.
 *
 * Reads the entity from the cache (`useCachedQueryData`, like Breadcrumbs): it
 * follows the entry ProjectDetail / AgentDetail fills, never fetches on its own and,
 * unlike a fetch-less (TanStack skip token) observer, never replaces that page's `queryFn`.
 *
 * @module assistant/page/usePageContext
 */
import { useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import type { QueryKey } from '@tanstack/react-query'
import { z } from 'zod'
import { agentsKeys } from '../../api/agentsApi'
import { useCachedQueryData } from '../../hooks/useCachedQueryData'
import { projectKey } from '../../api/projectQueryKeys'
import { pageContextFromLocation } from './pageContext'
import type { PageContext } from '../contract'

const MAX_TITLE = 120

const projectNameSchema = z.object({ project: z.object({ name: z.string().min(1) }) })
const agentNameSchema = z.object({ name: z.string().min(1) })

const projectTitleFrom = (data: unknown): string | undefined => projectNameSchema.safeParse(data).data?.project.name
const agentTitleFrom = (data: unknown): string | undefined => agentNameSchema.safeParse(data).data?.name

/** The cached entity's name under `queryKey`, or undefined (never fetches; disabled = no entity on this page). */
function useCachedTitle(queryKey: QueryKey, enabled: boolean, nameOf: (data: unknown) => string | undefined): string | undefined {
  const data = useCachedQueryData(queryKey, enabled)
  return enabled ? nameOf(data)?.slice(0, MAX_TITLE) : undefined
}

export function usePageContext(): PageContext {
  const location = useLocation()
  const base = useMemo(
    () => pageContextFromLocation({ pathname: location.pathname, search: location.search }),
    [location.pathname, location.search],
  )
  const projectTitle = useCachedTitle(projectKey(base.projectId), base.projectId !== undefined, projectTitleFrom)
  const agentTitle = useCachedTitle(agentsKeys.detail(base.agentId ?? ''), base.agentId !== undefined, agentTitleFrom)
  const title = projectTitle ?? agentTitle
  return useMemo(() => (title !== undefined ? { ...base, title } : base), [base, title])
}
