/**
 * @fileoverview `usePageContext()` — the contract `PageContext` for the current
 * route, titled from the react-query cache when the entity is already loaded:
 * the project's name on a project page, the agent's name on an agent page, and,
 * with a prototype open on a project's Documents tab, that prototype (its id as
 * `documentId`, its title as the title: see `prototypeFrom`).
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
import { pageContextFromLocation, selectedDocumentId } from './pageContext'
import type { PageContext } from '@stream/assistant/contract'

const MAX_TITLE = 120

const projectNameSchema = z.object({ project: z.object({ name: z.string().min(1) }) })
const agentNameSchema = z.object({ name: z.string().min(1) })
const documentSchema = z.object({ document_id: z.string(), document_type: z.string(), title: z.string() })
const projectDocumentsSchema = z.object({ documents: z.array(z.unknown()) })

const projectTitleFrom = (data: unknown): string | undefined => projectNameSchema.safeParse(data).data?.project.name
const agentTitleFrom = (data: unknown): string | undefined => agentNameSchema.safeParse(data).data?.name

/**
 * The open PROTOTYPE (docs/prototype-builder.md, part 2) among the cached project's documents: its id and its
 * title ("Checkout (v3)": the entity on screen; the chip reads "Editing: …"), or undefined for any other
 * document or one the record does not list. A hint only: every route a tool calls with it checks access itself.
 */
function prototypeFrom(data: unknown, documentId: string | undefined): { documentId: string; title: string } | undefined {
  if (documentId === undefined) return undefined
  const rows = projectDocumentsSchema.safeParse(data).data?.documents ?? []
  const open = rows.map((row) => documentSchema.safeParse(row).data).find((d) => d?.document_id === documentId)
  return open?.document_type === 'prototype' ? { documentId: open.document_id, title: open.title.slice(0, MAX_TITLE) } : undefined
}

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
  const projectData = useCachedQueryData(projectKey(base.projectId), base.projectId !== undefined)
  const prototype = prototypeFrom(projectData, selectedDocumentId(base, location.search))
  // Primitives as dependencies: a re-read of the cache must not hand the assistant a new context object.
  const [prototypeId, prototypeTitle] = [prototype?.documentId, prototype?.title]
  return useMemo(() => {
    if (prototypeId !== undefined && prototypeTitle !== undefined) return { ...base, documentId: prototypeId, title: prototypeTitle }
    return title !== undefined ? { ...base, title } : base
  }, [base, title, prototypeId, prototypeTitle])
}
