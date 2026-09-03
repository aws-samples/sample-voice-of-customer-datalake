/**
 * useProjectData - Custom hook for project data fetching and mutations
 */
import {
  useQuery, useMutation, useQueryClient,
} from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { projectsApi } from '../../api/projectsApi'
import { projectKey } from '../../api/projectQueryKeys'
import { usePrototypeLinkRefresh } from '../../components/usePrototypeLinkRefresh'
import type {
  PersonaToolConfig, ResearchToolConfig, DocToolConfig, MergeToolConfig, NoteItem,
} from './types'
import type {
  ProjectPersona, ProjectDocument, ProjectJob,
} from '../../api/types'
import type { ContextConfig } from '../../components/DataSourceWizard/exports'

/**
 * Query key for a project's job list.
 *
 * Exported because the key has to be identical in three places that can drift:
 * the query itself, the wizard mutations that invalidate it, and
 * ProjectDetail's onJobStarted (which is the only thing that makes the panel
 * notice a job started outside a wizard). A typo in any of them fails silently
 * — the panel simply never updates.
 */
export const projectJobsKey = (id: string | undefined) => ['project-jobs', id] as const

/**
 * Query key for a project's product context.
 *
 * Exported for the same reason as the jobs key: more than one place needs it.
 * The Product tab still fetches the context itself, because it edits the record
 * field by field and owns that local state; if it is ever moved onto React Query
 * this is the key it should share.
 */
export const productContextKey = (id: string | undefined) => ['product-context', id] as const

/**
 * Query key for a project's uploaded product docs.
 *
 * Exported for the same reason as the two keys above: more than one place will
 * need it. The Product tab still lists the docs itself, because it uploads,
 * deletes and polls them and owns that local state; if it ever moves onto React
 * Query this is the key it should share.
 */
export const productDocsKey = (id: string | undefined) => ['product-docs', id] as const

/**
 * How long to keep polling the jobs list after an action reports that it started
 * a job.
 *
 * A single invalidation is not enough: `api_list_jobs` queries DynamoDB without
 * `ConsistentRead`, and the handler returns `job_id` as soon as it has written
 * the row and invoked the worker — so the one refetch an invalidation triggers
 * can legitimately come back empty. If it does, `refetchInterval` drops to 0 and
 * the panel is blind again, which is the exact defect this file's polling exists
 * to prevent. Polling for a short window instead means the panel does not have
 * to win that race on the first try.
 */
export const JOB_START_POLL_WINDOW_MS = 30_000

const JOB_POLL_INTERVAL_MS = 3000

/**
 * How long a fetched product context counts as fresh.
 *
 * Generous because the only writer is the Product tab, and it pushes its result
 * into this cache directly. Five minutes bounds the staleness if the record is
 * ever changed elsewhere (the global chat's `create_project` tool can seed five of
 * its fields) without paying a request every time the window regains focus.
 */
const PRODUCT_CONTEXT_STALE_MS = 5 * 60_000

/**
 * How long until the jobs list should be read again: the poll cadence while
 * there is work to watch, 0 to stop.
 *
 * Pure and exported so the window above can be pinned without driving a
 * component through 30 seconds of timers — the interesting cases are all about
 * *when* polling stops, and that decision is entirely here.
 */
export function jobsPollInterval(
  jobs: ReadonlyArray<Pick<ProjectJob, 'status'>>,
  jobStartedAt: number | null,
  now: number,
): number {
  if (jobs.some((job) => job.status === 'running' || job.status === 'pending')) {
    return JOB_POLL_INTERVAL_MS
  }
  const withinStartWindow = jobStartedAt != null && now - jobStartedAt < JOB_START_POLL_WINDOW_MS
  return withinStartWindow ? JOB_POLL_INTERVAL_MS : 0
}

/** A job that will not change again: its artifacts and counts have settled. */
export function isTerminalJobStatus(status: ProjectJob['status']): boolean {
  return status === 'completed' || status === 'failed'
}

/**
 * The jobs that reached a terminal state since the last look.
 *
 * A TRANSITION, not a timestamp window. The previous rule refetched any job whose
 * `completed_at` was under ten seconds old, which made the refresh depend on two
 * clocks agreeing: the writer's `completed_at` and the browser's `Date.now()`. A
 * poll that landed a second late — or a browser whose clock runs behind the
 * Lambda's — skipped it, and the page then showed stale Overview counts and a
 * disabled prototype action until a manual reload. It also ignored `failed`
 * entirely, so a failed build left the "generating" affordances lit.
 *
 * Comparing against what this page has already SEEN needs no clock, fires once per
 * job, and reports each of several concurrent jobs as it lands.
 *
 * @param jobs The jobs list as last fetched.
 * @param seen Job ids already observed terminal. MUTATED with the new ones, so
 *   the caller's ref carries them into the next poll.
 * @returns The ids that are terminal now and were not before.
 */
export function newlyTerminalJobIds(
  jobs: ReadonlyArray<Pick<ProjectJob, 'job_id' | 'status'>>,
  seen: Set<string>,
): string[] {
  const settled: string[] = []
  for (const job of jobs) {
    if (typeof job.job_id !== 'string' || job.job_id === '') continue
    if (!isTerminalJobStatus(job.status)) {
      // A job id can be re-run (`claim_job_execution` moves a failed row back to
      // running), so forget it rather than suppressing its next terminal edge.
      seen.delete(job.job_id)
      continue
    }
    if (seen.has(job.job_id)) continue
    seen.add(job.job_id)
    settled.push(job.job_id)
  }
  return settled
}

/**
 * Whether the FIRST jobs payload reports an artifact the project read missed.
 *
 * `projectKey` and `projectJobsKey` are two independent queries issued at roughly
 * the same time, so a job can settle BETWEEN the project read committing
 * server-side and the jobs read committing. The first jobs payload then reports a
 * terminal job the mount project fetch did not see — and seeding on that payload
 * (which is right for the common case, where its terminal jobs are history the
 * mount fetch already reflects) would suppress the only invalidation that job will
 * ever get: the next poll finds its id already settled, and if nothing else is live
 * the poll stops. The page then holds stale Overview counts and a disabled
 * prototype action until a manual action.
 *
 * Answered from the DATA rather than by widening the window back to a clock: a
 * completed job names the artifact it produced, so "did the project read see it"
 * is a set membership test. Callers must only ask once the project read has
 * RESOLVED: `undefined` here is indistinguishable from "nothing was missed", so the
 * effect below defers consuming the first payload until `data` is present rather
 * than asking early and getting a false negative.
 *
 * `false` for a job whose result names nothing, which is the honest answer rather
 * than a refetch on every open.
 *
 * @param jobs The first jobs payload.
 * @param project The project detail already in cache, or undefined if still loading.
 * @returns Whether the project query should be invalidated despite being seeded.
 */
export function firstPayloadMissesAnArtifact(
  jobs: ReadonlyArray<Pick<ProjectJob, 'job_id' | 'status' | 'result'>>,
  project: { documents: ReadonlyArray<Pick<ProjectDocument, 'document_id'>>
    personas: ReadonlyArray<Pick<ProjectPersona, 'persona_id'>> } | undefined,
): boolean {
  if (project === undefined) return false
  const documentIds = new Set(project.documents.map((document) => document.document_id))
  const personaIds = new Set(project.personas.map((persona) => persona.persona_id))
  return jobs.some((job) => {
    // Only `completed`: a `failed` job produced no artifact to compare against, and
    // its own effect on the page (turning the "generating" affordances off) is
    // driven by the jobs payload this function is reading, not by the project.
    if (job.status !== 'completed') return false
    const documentId = job.result?.document_id
    if (typeof documentId === 'string' && documentId !== '') {
      return !documentIds.has(documentId)
    }
    const personaId = job.result?.persona_id
    if (typeof personaId === 'string' && personaId !== '') {
      return !personaIds.has(personaId)
    }
    // `generate_personas` reports a LIST rather than one id, and it is among the
    // jobs a user is most likely to have the page open for — so the interleave case
    // has to cover it too. Any one persona the project read missed is enough: the
    // refetch replaces the whole payload.
    const personas = job.result?.personas
    if (Array.isArray(personas)) {
      return personas.some((persona) => {
        const id: unknown = persona?.persona_id
        return typeof id === 'string' && id !== '' && !personaIds.has(id)
      })
    }
    return false
  })
}

interface UseProjectDataProps {
  id: string | undefined
  apiEndpoint: string
  /**
   * `Date.now()` of the last long-running action kicked off from this page, or
   * null if none. Only used to keep the jobs poll alive across the window above.
   */
  jobStartedAt?: number | null
}

export function useProjectData({
  id, apiEndpoint, jobStartedAt = null,
}: UseProjectDataProps) {
  const queryClient = useQueryClient()
  const isEnabled = apiEndpoint !== '' && id != null && id !== ''

  // `projectKey` is shared rather than spelled here because the header reads this
  // same entry — see api/projectQueryKeys.ts.
  const {
    data, isLoading,
  } = useQuery({
    queryKey: projectKey(id),
    queryFn: () => projectsApi.getProject(id ?? ''),
    enabled: isEnabled,
  })

  const { data: jobsData } = useQuery({
    queryKey: projectJobsKey(id),
    queryFn: () => projectsApi.getJobs(id ?? ''),
    enabled: isEnabled,
    // Re-evaluated after every fetch, so the start window closes itself without
    // needing a re-render. 0 means no refetch (same as false).
    refetchInterval: (query) =>
      jobsPollInterval(query.state.data?.jobs ?? [], jobStartedAt, Date.now()),
  })

  /**
   * The product context, fetched here rather than only in the Product tab so the
   * Overview card can report how complete the description is.
   *
   * This is the one Overview card whose state is not derivable from data the page
   * already loads, and it is card #1 in the numbered sequence — a first step that
   * cannot say whether it is done would undercut the numbering. The cost is one
   * small extra request per project open.
   *
   * Failing is not fatal: `undefined` reaches the card as "unknown", which renders
   * no state rather than a wrong one — hence `retry: false`, since the card is
   * built to tolerate not knowing and a retry storm buys nothing.
   *
   * `staleTime` is what keeps the cost honest. Without it the default refetch on
   * window focus makes "one request per project open" untrue for anyone who tabs
   * away and back. The record only changes from the Product tab, which hands the
   * new value straight into this cache (see ProjectDetail's onContextSaved), so
   * there is nothing a background refetch would discover.
   */
  const { data: productContextData } = useQuery({
    queryKey: productContextKey(id),
    queryFn: () => projectsApi.getProductContext(id ?? ''),
    enabled: isEnabled,
    staleTime: PRODUCT_CONTEXT_STALE_MS,
    retry: false,
  })

  /**
   * The project's uploaded product docs, for the prototype card's visual picker.
   *
   * Fetched here rather than in the card so the Overview tab stays a pure function
   * of its props, exactly as the product context above is — and so a project with
   * no uploads pays one small request instead of the card holding its own loading
   * state.
   *
   * `retry: false` and nothing else: a failure reaches the card as `undefined`,
   * which offers no visuals — the build then reads none, which is what it did
   * before this feature. No `staleTime`, unlike the context: uploads happen in the
   * Product tab, which does NOT hand its list back to this cache, so the default
   * refetch on mount and focus is the only thing that lets a screenshot uploaded a
   * minute ago appear in the picker.
   */
  const { data: productDocsData } = useQuery({
    queryKey: productDocsKey(id),
    queryFn: () => projectsApi.listProductDocs(id ?? ''),
    enabled: isEnabled,
    retry: false,
  })

  /**
   * Every job id this page has already seen reach `completed` or `failed`.
   *
   * A ref rather than state: it must not itself trigger a render, and it has to
   * survive the re-render the invalidation below causes. Reset when the project
   * changes so one project's history cannot suppress another's first refresh.
   */
  const settledJobIds = useRef<Set<string>>(new Set())
  const sawFirstJobsPayload = useRef(false)
  useEffect(() => {
    settledJobIds.current = new Set()
    sawFirstJobsPayload.current = false
  }, [id])

  /**
   * A job reaching a terminal state is the moment Overview counts, prototype
   * enablement, Documents and the completed artifact all become readable — so the
   * project detail query is invalidated too, not just the jobs list. Failed counts:
   * it is what turns the "generating" affordances back off.
   *
   * The FIRST payload after mount only seeds the set — with one exception. Its
   * terminal jobs are usually history that the project fetch on the same mount
   * already reflects, so refetching for them would cost every project open a second
   * read and prove nothing. But the two queries are independent, so a job can settle
   * between the project read committing and the jobs read committing; when the
   * payload names an artifact the project does NOT contain, that job's only
   * invalidation is this one. `firstPayloadMissesAnArtifact` decides from the data,
   * so the exception costs nothing on the common path.
   *
   * Nothing is consumed while `data` is still undefined, and that ordering is the
   * whole exception. The jobs response is the smaller of the two, so it usually
   * resolves FIRST; seeding then — before there is a project to compare against —
   * would burn both the flag and the transition on a payload the predicate cannot
   * answer for, and the re-run once `data` landed would find nothing left to report.
   * Returning early leaves both intact, so the seeding happens on the first payload
   * where BOTH are present, which is the only moment "did the project read see it"
   * has an answer. `data` is in the dependency array, so its arrival re-runs this.
   *
   * The bound: a project read that never resolves at all (it exhausted its retries)
   * gets no job-driven refetch. That page is already rendering its error state, and
   * invalidating a query that just failed would only repeat the failure.
   */
  useEffect(() => {
    const jobs = jobsData?.jobs
    if (jobs === undefined || data === undefined) return
    const settled = newlyTerminalJobIds(jobs, settledJobIds.current)
    const isFirstPayload = !sawFirstJobsPayload.current
    sawFirstJobsPayload.current = true
    const shouldInvalidate = isFirstPayload
      ? firstPayloadMissesAnArtifact(jobs, data)
      : settled.length > 0
    if (shouldInvalidate) {
      void queryClient.invalidateQueries({ queryKey: projectKey(id) })
    }
  }, [jobsData, data, id, queryClient])

  /**
   * Replace the prototype links before their signatures lapse.
   *
   * Refetching the project IS the re-sign mechanism: the API mints a fresh
   * signature on every read and never trusts a stored one, so all this page has to
   * do is ask again in time. The when — the lead, the floor, and re-arming off the
   * replacement so the cycle continues — lives in `usePrototypeLinkRefresh`, which
   * the Prioritization page shares.
   */
  usePrototypeLinkRefresh(
    data?.documents,
    () => {
      void queryClient.invalidateQueries({ queryKey: projectKey(id) })
    },
    // `id` is what this refresh is scoped to, and passing it keeps the guarantee the
    // inlined version had: a timer cannot outlive the project it was armed for, not
    // even when the next project's deadline happens to match to the second.
    id,
  )

  return {
    data,
    isLoading,
    jobsData,
    productContext: productContextData?.context,
    productDocs: productDocsData?.docs,
    queryClient,
  }
}

interface UseProjectMutationsProps {
  id: string | undefined
  contextConfig: ContextConfig
  personaConfig: PersonaToolConfig
  researchConfig: ResearchToolConfig
  docConfig: DocToolConfig
  mergeConfig: MergeToolConfig
  onSuccess: () => void
  onError: () => void
}

export function useProjectMutations({
  id,
  contextConfig,
  personaConfig,
  researchConfig,
  docConfig,
  mergeConfig,
  onSuccess,
  onError,
}: UseProjectMutationsProps) {
  const queryClient = useQueryClient()
  const projectId = id ?? ''
  const { i18n } = useTranslation()

  const personaMut = useMutation({
    mutationFn: () => projectsApi.generatePersonas(projectId, {
      sources: contextConfig.sources,
      categories: contextConfig.categories,
      sentiments: contextConfig.sentiments,
      persona_count: personaConfig.personaCount,
      custom_instructions: personaConfig.customInstructions,
      days: contextConfig.days,
      response_language: i18n.language,
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectJobsKey(id) })
      onSuccess()
    },
    onError,
  })

  const docMut = useMutation({
    // One or both of PRD / PR-FAQ may be selected. Each fires as its own async
    // job (they run in parallel server-side), so the user can request both at once.
    mutationFn: async () => {
      const types = docConfig.docTypes.length > 0 ? docConfig.docTypes : ['prfaq' as const]
      const base = {
        title: docConfig.title,
        feature_idea: docConfig.featureIdea,
        data_sources: {
          feedback: contextConfig.useFeedback,
          personas: contextConfig.usePersonas,
          documents: contextConfig.useDocuments,
          research: contextConfig.useResearch,
        },
        selected_persona_ids: contextConfig.selectedPersonaIds,
        selected_document_ids: [...contextConfig.selectedDocumentIds, ...contextConfig.selectedResearchIds],
        feedback_sources: contextConfig.sources,
        feedback_categories: contextConfig.categories,
        days: contextConfig.days,
        customer_questions: docConfig.customerQuestions.filter((q) => q.trim() !== ''),
        response_language: i18n.language,
      }
      return Promise.all(types.map((docType) => projectsApi.generateDocument(projectId, { doc_type: docType, ...base })))
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectJobsKey(id) })
      onSuccess()
    },
    onError,
  })

  const resMut = useMutation({
    mutationFn: () => projectsApi.runResearch(projectId, {
      question: researchConfig.question,
      title: researchConfig.title === '' ? researchConfig.question.slice(0, 100) : researchConfig.title,
      sources: contextConfig.sources,
      categories: contextConfig.categories,
      sentiments: contextConfig.sentiments,
      days: contextConfig.days,
      selected_persona_ids: contextConfig.selectedPersonaIds,
      selected_document_ids: [...contextConfig.selectedDocumentIds, ...contextConfig.selectedResearchIds],
      response_language: i18n.language,
      use_web_search: researchConfig.useWebSearch,
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectJobsKey(id) })
      onSuccess()
    },
    onError,
  })

  const mergeMut = useMutation({
    mutationFn: () => projectsApi.mergeDocuments(projectId, {
      output_type: mergeConfig.outputType,
      title: mergeConfig.title,
      instructions: mergeConfig.instructions,
      selected_document_ids: [...contextConfig.selectedDocumentIds, ...contextConfig.selectedResearchIds],
      selected_persona_ids: contextConfig.selectedPersonaIds,
      use_feedback: contextConfig.useFeedback,
      feedback_sources: contextConfig.sources,
      feedback_categories: contextConfig.categories,
      days: contextConfig.days,
      response_language: i18n.language,
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectJobsKey(id) })
      onSuccess()
    },
    onError,
  })

  const dismissJobMut = useMutation({
    mutationFn: (jobId: string) => projectsApi.dismissJob(projectId, jobId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: projectJobsKey(id) }),
  })

  return {
    personaMut,
    docMut,
    resMut,
    mergeMut,
    dismissJobMut,
  }
}

interface UsePersonaMutationsProps {
  id: string | undefined
  selectedPersona: ProjectPersona | null
  editingPersona: ProjectPersona | null
  setEditingPersona: (p: ProjectPersona | null) => void
  setSelectedPersona: (p: ProjectPersona | null) => void
}

export function usePersonaMutations({
  id,
  selectedPersona,
  editingPersona,
  setEditingPersona,
  setSelectedPersona,
}: UsePersonaMutationsProps) {
  const queryClient = useQueryClient()
  const projectId = id ?? ''

  const updatePersonaMut = useMutation({
    mutationFn: (data: {
      personaId: string;
      updates: Partial<ProjectPersona>
    }) =>
      projectsApi.updatePersona(projectId, data.personaId, data.updates),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: projectKey(id) })
      if (editingPersona?.persona_id === variables.personaId) {
        setEditingPersona(null)
        setSelectedPersona(null)
      }
    },
  })

  const deletePersonaMut = useMutation({
    mutationFn: (personaId: string) => projectsApi.deletePersona(projectId, personaId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectKey(id) })
      setSelectedPersona(null)
    },
  })

  const importPersonaMut = useMutation({
    mutationFn: (data: {
      input_type: 'image' | 'text';
      content: string;
      media_type?: string
    }) =>
      projectsApi.importPersona(projectId, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectJobsKey(id) })
    },
  })

  // Save research notes
  const saveNotes = (notes: NoteItem[]): void => {
    if (!selectedPersona) return
    updatePersonaMut.mutate({
      personaId: selectedPersona.persona_id,
      updates: { research_notes: notes },
    })
  }

  return {
    updatePersonaMut,
    deletePersonaMut,
    importPersonaMut,
    saveNotes,
  }
}

interface UseDocumentMutationsProps {
  id: string | undefined
  selectedDoc: ProjectDocument | null
  setSelectedDoc: (d: ProjectDocument | null) => void
}

export function useDocumentMutations({
  id,
  selectedDoc,
  setSelectedDoc,
}: UseDocumentMutationsProps) {
  const queryClient = useQueryClient()
  const projectId = id ?? ''

  const createDocMut = useMutation({
    mutationFn: (data: {
      title: string;
      content: string
    }) =>
      projectsApi.createDocument(projectId, {
        ...data,
        document_type: 'custom',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectKey(id) })
    },
  })

  const deleteDocMut = useMutation({
    mutationFn: (docId: string) => projectsApi.deleteDocument(projectId, docId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectKey(id) })
      setSelectedDoc(null)
    },
  })

  const updateDocMut = useMutation({
    mutationFn: (data: {
      docId: string;
      title?: string;
      content: string
    }) =>
      projectsApi.updateDocument(projectId, data.docId, {
        ...(data.title === undefined ? {} : { title: data.title }),
        content: data.content,
      }),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: projectKey(id) })
      if (selectedDoc?.document_id === variables.docId) {
        setSelectedDoc({
          ...selectedDoc,
          ...(variables.title === undefined ? {} : { title: variables.title }),
          content: variables.content,
        })
      }
    },
  })

  return {
    createDocMut,
    deleteDocMut,
    updateDocMut,
  }
}
