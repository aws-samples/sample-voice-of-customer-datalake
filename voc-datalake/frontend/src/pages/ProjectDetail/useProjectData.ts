/**
 * useProjectData - Custom hook for project data fetching and mutations
 */
import {
  useQuery, useMutation, useQueryClient,
} from '@tanstack/react-query'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { projectsApi } from '../../api/projectsApi'
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

  const {
    data, isLoading,
  } = useQuery({
    queryKey: ['project', id],
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

  // When a job completes, refresh project data
  useEffect(() => {
    const jobs = jobsData?.jobs ?? []
    const TEN_SECONDS = 10000
    const completedRecently = jobs.some((j: ProjectJob) =>
      j.status === 'completed' && j.completed_at != null && j.completed_at !== '' &&
      new Date(j.completed_at).getTime() > Date.now() - TEN_SECONDS,
    )
    if (completedRecently) {
      void queryClient.invalidateQueries({ queryKey: ['project', id] })
    }
  }, [jobsData, id, queryClient])

  return {
    data,
    isLoading,
    jobsData,
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
      void queryClient.invalidateQueries({ queryKey: ['project', id] })
      if (editingPersona?.persona_id === variables.personaId) {
        setEditingPersona(null)
        setSelectedPersona(null)
      }
    },
  })

  const deletePersonaMut = useMutation({
    mutationFn: (personaId: string) => projectsApi.deletePersona(projectId, personaId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project', id] })
      setSelectedPersona(null)
    },
  })

  const importPersonaMut = useMutation({
    mutationFn: (data: {
      input_type: 'pdf' | 'image' | 'text';
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
      void queryClient.invalidateQueries({ queryKey: ['project', id] })
    },
  })

  const deleteDocMut = useMutation({
    mutationFn: (docId: string) => projectsApi.deleteDocument(projectId, docId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project', id] })
      setSelectedDoc(null)
    },
  })

  const updateDocMut = useMutation({
    mutationFn: (data: {
      docId: string;
      title: string;
      content: string
    }) =>
      projectsApi.updateDocument(projectId, data.docId, {
        title: data.title,
        content: data.content,
      }),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['project', id] })
      if (selectedDoc?.document_id === variables.docId) {
        setSelectedDoc({
          ...selectedDoc,
          title: variables.title,
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
