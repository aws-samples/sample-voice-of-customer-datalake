/**
 * @fileoverview The projects a run touched, read once for the run view: each project's
 * name and each produced document's title (with its version).
 *
 * 5.35.02 live: "What it produced" listed "PR/FAQ ready" three times (v1, v2, v3 could not
 * be told apart), and while the run was paused every line said "in a project": the agent
 * created the project after the cached project list was read, and names came only from
 * that list. One `GET /projects?ids=…` (the run's project ids) answers both; it is keyed
 * on the produced document ids too, so a new artifact reads the titles again.
 *
 * @module pages/Agents/useRunProjects
 */
import { createContext, useContext, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { projectsApi } from '../../api/projectsApi'
import { projectDetailsBatchKey } from '../../api/projectQueryKeys'
import { useProjectName } from '../../hooks/useLabelKnownIds'
import type { AgentRun, RunEvent } from '../../api/agentsApi'
import type { ProjectDetail } from '../../api/projectTypes'
import type { ProjectDocument } from '../../api/types'

export interface RunProjects {
  /** The project's name: from the run's own read, else the project list, else "a project". */
  readonly projectName: (projectId: string) => string
  /** The document's title with its version, or null while unknown (not read yet, not visible). */
  readonly documentTitle: (projectId: string, documentId: string) => string | null
}

/** The project ids the run and its journal name, sorted and unique (a stable query key). */
function runProjectIds(run: Pick<AgentRun, 'project_id'> | undefined, events: readonly RunEvent[]): string[] {
  const ids = new Set<string>()
  if (run !== undefined && run.project_id !== null) ids.add(run.project_id)
  for (const event of events) if (event.ref?.project_id !== undefined) ids.add(event.ref.project_id)
  return [...ids].sort((a, b) => a.localeCompare(b))
}

function artifactDocumentIds(events: readonly RunEvent[]): string[] {
  const ids = new Set<string>()
  for (const event of events) if (event.kind === 'artifact' && event.ref?.document_id !== undefined) ids.add(event.ref.document_id)
  return [...ids].sort((a, b) => a.localeCompare(b))
}

/** "Title (v2)": the stored title, with the version added when the title does not already carry it. */
export function versionedTitle(document: Pick<ProjectDocument, 'title' | 'version'>): string {
  const title = document.title.trim()
  if (title === '' || document.version === undefined) return title
  const suffix = `(v${String(document.version)})`
  return title.endsWith(suffix) ? title : `${title} ${suffix}`
}

function lookup(details: readonly ProjectDetail[] | undefined, listName: (projectId: string) => string): RunProjects {
  const byId = new Map((details ?? []).map((detail) => [detail.project.project_id, detail]))
  return {
    projectName: (projectId) => {
      const name = byId.get(projectId)?.project.name.trim() ?? ''
      return name === '' ? listName(projectId) : name
    },
    documentTitle: (projectId, documentId) => {
      const document = byId.get(projectId)?.documents.find((d) => d.document_id === documentId)
      const title = document === undefined ? '' : versionedTitle(document)
      return title === '' ? null : title
    },
  }
}

export function useRunProjects(run: AgentRun | undefined, events: readonly RunEvent[]): RunProjects {
  const listName = useProjectName()
  const projectIds = useMemo(() => runProjectIds(run, events), [run, events])
  const documentIds = useMemo(() => artifactDocumentIds(events).join(','), [events])
  const { data } = useQuery({
    // Under the project-details root, so a project write's prefix invalidation reaches it too.
    queryKey: [...projectDetailsBatchKey(projectIds), 'run-artifacts', documentIds],
    queryFn: () => projectsApi.getProjectDetails(projectIds),
    enabled: projectIds.length > 0,
  })
  return useMemo(() => lookup(data, listName), [data, listName])
}

/** The run view's `RunProjects`, for the components inside it (null outside a run view). */
export const RunProjectsContext = createContext<RunProjects | null>(null)

export function useRunProjectsContext(): RunProjects | null {
  return useContext(RunProjectsContext)
}

/** A project id as its name inside a run view (the run's own read first), else from the project list. */
export function useRunProjectName(): (projectId: string) => string {
  const listName = useProjectName()
  return useRunProjectsContext()?.projectName ?? listName
}
