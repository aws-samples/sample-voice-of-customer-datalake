/**
 * The prototype draft the open prototype's pane shows, and its Apply and Discard
 * (docs/prototype-builder.md, part 2). Editors only: a viewer reads no jobs here and no draft
 * (the draft GET is at EDIT).
 *
 * The jobs come from the list the Background Jobs panel reads (`projectJobsKey`, polled and
 * refreshed by useProjectData): the newest finished draft jobs, at most ten (`MAX_DRAFTS_READ` in
 * prototypeDraft.ts), each read through the draft GET (a 404 is a draft of another series, or one
 * that expired or was discarded, not an error).
 *
 * @module pages/ProjectDetail/usePrototypeDraft
 */
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { projectsApi } from '../../api/projectsApi'
import type { AppliedDraft } from '../../api/projectsApi'
import { projectJobsKey, projectKey } from '../../api/projectQueryKeys'
import { projectPrototypePinsKey } from '../../api/prototypePinsApi'
import type { ProjectDocument } from '../../api/types'
import { numberedSeries } from './documentEdit'
import { draftCandidates, shownDraft } from './prototypeDraft'
import type { ShownDraft } from './prototypeDraft'

/** A draft's signed preview URL lasts longer than this; a refetch only re-signs it (the frame keeps its page). */
const DRAFT_STALE_MS = 5 * 60_000

/** Under the project's key, so a project refresh (a job's end, an Apply) reads the drafts again. */
const prototypeDraftKey = (projectId: string, documentId: string, draftId: string) =>
  [...projectKey(projectId), 'prototype-draft', documentId, draftId] as const

export function usePrototypeDraft(
  projectId: string, document: ProjectDocument, documents: readonly ProjectDocument[], canEdit: boolean,
): ShownDraft | null {
  const { data: jobsData } = useQuery({
    queryKey: projectJobsKey(projectId),
    queryFn: () => projectsApi.getJobs(projectId),
    enabled: canEdit,
  })
  const candidates = canEdit ? draftCandidates(jobsData?.jobs ?? []) : []
  const drafts = useQueries({
    queries: candidates.map((draftId) => ({
      queryKey: prototypeDraftKey(projectId, document.document_id, draftId),
      queryFn: () => projectsApi.getPrototypeDraft(projectId, document.document_id, draftId),
      staleTime: DRAFT_STALE_MS,
    })),
  })
  return shownDraft(drafts.map((query) => query.data), numberedSeries(document, documents))
}

/** Apply (select the version it wrote) and Discard (the job delete), each refreshing the project and its jobs. */
export function usePrototypeDraftActions(
  projectId: string, documentId: string, draftId: string, onSelectDoc: (doc: ProjectDocument) => void,
  onApplied?: (applied: AppliedDraft) => void,
) {
  const queryClient = useQueryClient()
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: projectKey(projectId) }),
    queryClient.invalidateQueries({ queryKey: projectJobsKey(projectId) }),
  ])
  const apply = useMutation({
    mutationFn: () => projectsApi.applyPrototypeDraft(projectId, documentId, draftId),
    onSuccess: (applied) => {
      void refresh()
      // A feedback draft marked pins and replied to them: every pin read of the project is read again.
      if (applied.incorporation !== null) void queryClient.invalidateQueries({ queryKey: projectPrototypePinsKey(projectId) })
      onApplied?.(applied)
      if (applied.document !== null) onSelectDoc(applied.document)
    },
  })
  const discard = useMutation({
    mutationFn: () => projectsApi.dismissJob(projectId, draftId),
    onSuccess: () => {
      // Gone at once (the GET would now be a 404), before the refetches land.
      queryClient.setQueryData(prototypeDraftKey(projectId, documentId, draftId), null)
      return refresh()
    },
  })
  return { apply, discard }
}
