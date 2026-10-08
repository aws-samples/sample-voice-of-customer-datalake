/**
 * @fileoverview State of the workflow editor: the loaded revision, the draft,
 * local (instant) + server (debounced `POST /workflows/validate`) validation,
 * and the library writes — Save (new revision with `expected_revision`, 409 →
 * conflict), Save as, Import, Reset to template.
 *
 * @module components/WorkflowEditor/useWorkflowEditor
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiErrorStatus } from '../../api/apiErrorStatus'
import { DEFAULT_WORKFLOW_ID, normalizeDefinition, workflowsApi, workflowsKeys } from '../../api/workflowsApi'
import { diffDefinitions } from './diff'
import { validateLocally } from './graphRules'
import type { WorkflowDefinition, WorkflowIssue, WorkflowView } from '../../api/workflowsApi'

const SERVER_VALIDATE_DELAY_MS = 600

/** Parsed JSON, or undefined for text that is not JSON. */
function parseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch {
    return undefined
  }
}

export type SaveOutcome = 'saved' | 'conflict' | 'invalid' | 'failed'

/** Messages per step id, plus the ones that belong to the workflow as a whole. */
export function groupIssues(issues: readonly WorkflowIssue[]): { byNode: Map<string, string[]>; general: string[] } {
  const byNode = new Map<string, string[]>()
  const general: string[] = []
  const seen = new Set<string>()
  for (const { message, node_id: nodeId } of issues) {
    const key = `${nodeId ?? ''}\u0000${message}`
    if (seen.has(key)) continue
    seen.add(key)
    if (nodeId === undefined) general.push(message)
    else byNode.set(nodeId, [...(byNode.get(nodeId) ?? []), message])
  }
  return { byNode, general }
}

function useServerValidation(draft: WorkflowDefinition | null, workflowId: string, enabled: boolean) {
  const [serverIssues, setServerIssues] = useState<WorkflowIssue[]>([])
  useEffect(() => {
    if (draft === null || !enabled) return undefined
    const controller = new AbortController()
    const timer = setTimeout(() => {
      workflowsApi.validate(draft, workflowId === DEFAULT_WORKFLOW_ID ? undefined : workflowId)
        .then((result) => { if (!controller.signal.aborted) setServerIssues(result.errors) })
        .catch(() => { if (!controller.signal.aborted) setServerIssues([]) })
    }, SERVER_VALIDATE_DELAY_MS)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [draft, workflowId, enabled])
  return serverIssues
}

export function useWorkflowEditor(workflowId: string, canEdit: boolean) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: workflowsKeys.detail(workflowId),
    queryFn: () => workflowsApi.get(workflowId),
  })
  const workflow = query.data?.workflow
  const [draft, setDraft] = useState<WorkflowDefinition | null>(null)
  const [conflict, setConflict] = useState(false)
  // A fresh load (first fetch, reload after a conflict) resets the draft.
  const [loadedRevision, setLoadedRevision] = useState<number | null>(null)
  if (workflow !== undefined && workflow.revision !== loadedRevision && workflow.definition !== null) {
    setLoadedRevision(workflow.revision)
    setDraft(workflow.definition)
  }

  const localIssues = useMemo(() => (draft === null ? [] : validateLocally(draft)), [draft])
  const serverIssues = useServerValidation(draft, workflowId, localIssues.length === 0)
  const issues = localIssues.length > 0 ? localIssues : serverIssues
  const diff = useMemo(
    () => (draft === null || workflow === undefined ? null : diffDefinitions(workflow.definition, draft)),
    [draft, workflow],
  )
  const dirty = diff !== null && !diff.unchanged
  const builtin = workflow?.builtin === true

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: workflowsKeys.all() })
  }, [queryClient])

  const saveMutation = useMutation({
    mutationFn: ({ definition, revision }: { definition: WorkflowDefinition; revision: number }) =>
      workflowsApi.save(workflowId, definition, revision),
    onSuccess: async (view) => {
      queryClient.setQueryData(workflowsKeys.detail(workflowId), (old: { workflow: WorkflowView } | undefined) =>
        (old === undefined ? old : { ...old, workflow: view }))
      await refresh()
    },
  })

  const save = useCallback(async (): Promise<SaveOutcome> => {
    if (draft === null || workflow === undefined || !canEdit || builtin) return 'failed'
    if (validateLocally(draft).length > 0) return 'invalid'
    try {
      await saveMutation.mutateAsync({ definition: draft, revision: workflow.revision })
      setConflict(false)
      return 'saved'
    } catch (error) {
      if (apiErrorStatus(error) === 409) {
        setConflict(true)
        return 'conflict'
      }
      return apiErrorStatus(error) === 400 ? 'invalid' : 'failed'
    }
  }, [builtin, canEdit, draft, saveMutation, workflow])

  /** Save as: the DRAFT becomes a new workflow (unsaved edits included). */
  const saveAsMutation = useMutation({
    mutationFn: (name: string) => {
      if (draft === null) throw new Error('Nothing to save')
      return workflowsApi.create({ ...draft, name })
    },
    onSuccess: refresh,
  })

  /** Discard the draft and load the newest revision (after a conflict). */
  const reloadLatest = useCallback(async () => {
    setConflict(false)
    setLoadedRevision(null)
    await queryClient.invalidateQueries({ queryKey: workflowsKeys.detail(workflowId) })
  }, [queryClient, workflowId])

  /** Replace the draft with an imported file (validated, not saved). */
  const importJson = useCallback((text: string): boolean => {
    const definition = normalizeDefinition(parseJson(text))
    if (definition === null || definition.nodes.length === 0) return false
    setDraft(definition)
    return true
  }, [])

  const resetToTemplate = useCallback(async () => {
    const { workflow: template } = await queryClient.fetchQuery({
      queryKey: workflowsKeys.detail(DEFAULT_WORKFLOW_ID),
      queryFn: () => workflowsApi.get(DEFAULT_WORKFLOW_ID),
    })
    if (template.definition !== null) setDraft({ ...template.definition, name: draft?.name ?? template.definition.name })
  }, [draft?.name, queryClient])

  /** The file Export downloads: the server's (with lineage) when clean, else the draft. */
  const exportJson = useCallback(async (): Promise<unknown> => {
    if (!dirty && !builtin) return workflowsApi.exportDefinition(workflowId)
    return { ...draft, exported_from: { workflow_id: workflowId, revision: workflow?.revision ?? 1, unsaved_changes: dirty } }
  }, [builtin, dirty, draft, workflow?.revision, workflowId])

  return {
    query, workflow, draft, setDraft, issues, localIssues, diff, dirty, builtin, conflict,
    save, saving: saveMutation.isPending,
    saveAs: saveAsMutation.mutateAsync, savingAs: saveAsMutation.isPending,
    reloadLatest, importJson, resetToTemplate, exportJson,
  }
}
