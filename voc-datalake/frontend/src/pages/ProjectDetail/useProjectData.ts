/**
 * useProjectData - Custom hook for project data fetching and mutations
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import type { ProjectPersona, ProjectDocument, ProjectJob } from '../../api/client'
import type { ContextConfig } from '../../components/DataSourceWizard/exports'
import type { PersonaToolConfig, ResearchToolConfig, DocToolConfig, MergeToolConfig, NoteItem } from './types'

interface UseProjectDataProps {
  id: string | undefined
  apiEndpoint: string
}

export function useProjectData({ id, apiEndpoint }: UseProjectDataProps) {
  const queryClient = useQueryClient()
  const isEnabled = !!apiEndpoint && !!id

  const { data, isLoading } = useQuery({ 
    queryKey: ['project', id], 
    queryFn: () => api.getProject(id ?? ''), 
    enabled: isEnabled 
  })
  
  const { data: jobsData } = useQuery({ 
    queryKey: ['project-jobs', id], 
    queryFn: () => api.getJobs(id ?? ''), 
    enabled: isEnabled,
    refetchInterval: (query) => {
      const jobs = query.state.data?.jobs ?? []
      const hasRunning = jobs.some((j: ProjectJob) => j.status === 'running' || j.status === 'pending')
      // Return consistent type - 0 means no refetch (same as false)
      return hasRunning ? 3000 : 0
    }
  })
  
  // When a job completes, refresh project data
  useEffect(() => {
    const jobs = jobsData?.jobs ?? []
    const TEN_SECONDS = 10000
    const completedRecently = jobs.some((j: ProjectJob) => 
      j.status === 'completed' && j.completed_at && 
      new Date(j.completed_at).getTime() > Date.now() - TEN_SECONDS
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
    mutationFn: () => api.generatePersonas(projectId, { 
      sources: contextConfig.sources, 
      categories: contextConfig.categories, 
      sentiments: contextConfig.sentiments, 
      persona_count: personaConfig.personaCount, 
      custom_instructions: personaConfig.customInstructions, 
      days: contextConfig.days,
      response_language: i18n.language,
    }),
    onSuccess: () => { 
      void queryClient.invalidateQueries({ queryKey: ['project-jobs', id] })
      onSuccess() 
    },
    onError,
  })
  
  const docMut = useMutation({ 
    mutationFn: () => api.generateDocument(projectId, {
      doc_type: docConfig.docType,
      title: docConfig.title,
      feature_idea: docConfig.featureIdea,
      data_sources: { 
        feedback: contextConfig.useFeedback, 
        personas: contextConfig.usePersonas, 
        documents: contextConfig.useDocuments, 
        research: contextConfig.useResearch 
      },
      selected_persona_ids: contextConfig.selectedPersonaIds,
      selected_document_ids: [...contextConfig.selectedDocumentIds, ...contextConfig.selectedResearchIds],
      feedback_sources: contextConfig.sources,
      feedback_categories: contextConfig.categories,
      days: contextConfig.days,
      customer_questions: docConfig.customerQuestions.filter(q => q.trim()),
      response_language: i18n.language,
    }), 
    onSuccess: () => { 
      void queryClient.invalidateQueries({ queryKey: ['project-jobs', id] })
      onSuccess()
    }, 
    onError 
  })
  
  const resMut = useMutation({ 
    mutationFn: () => api.runResearch(projectId, { 
      question: researchConfig.question,
      title: researchConfig.title || researchConfig.question.slice(0, 100),
      sources: contextConfig.sources, 
      categories: contextConfig.categories, 
      sentiments: contextConfig.sentiments, 
      days: contextConfig.days,
      selected_persona_ids: contextConfig.selectedPersonaIds,
      selected_document_ids: [...contextConfig.selectedDocumentIds, ...contextConfig.selectedResearchIds],
      response_language: i18n.language,
    }), 
    onSuccess: () => { 
      void queryClient.invalidateQueries({ queryKey: ['project-jobs', id] })
      onSuccess() 
    },
    onError 
  })
  
  const mergeMut = useMutation({
    mutationFn: () => api.mergeDocuments(projectId, {
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
      void queryClient.invalidateQueries({ queryKey: ['project-jobs', id] })
      onSuccess()
    },
    onError
  })

  const dismissJobMut = useMutation({ 
    mutationFn: (jobId: string) => api.dismissJob(projectId, jobId), 
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['project-jobs', id] }) 
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
    mutationFn: (data: { personaId: string; updates: Partial<ProjectPersona> }) => 
      api.updatePersona(projectId, data.personaId, data.updates),
    onSuccess: (_data, variables) => { 
      void queryClient.invalidateQueries({ queryKey: ['project', id] })
      if (editingPersona && editingPersona.persona_id === variables.personaId) {
        setEditingPersona(null)
        setSelectedPersona(null)
      }
    }
  })

  const deletePersonaMut = useMutation({
    mutationFn: (personaId: string) => api.deletePersona(projectId, personaId),
    onSuccess: () => { 
      void queryClient.invalidateQueries({ queryKey: ['project', id] })
      setSelectedPersona(null)
    }
  })

  const importPersonaMut = useMutation({
    mutationFn: (data: { input_type: 'pdf' | 'image' | 'text'; content: string; media_type?: string }) => 
      api.importPersona(projectId, data),
    onSuccess: () => { 
      void queryClient.invalidateQueries({ queryKey: ['project-jobs', id] })
    }
  })

  // Save research notes
  const saveNotes = (notes: NoteItem[]): void => {
    if (!selectedPersona) return
    updatePersonaMut.mutate({ 
      personaId: selectedPersona.persona_id, 
      updates: { research_notes: notes } 
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
    mutationFn: (data: { title: string; content: string }) => 
      api.createDocument(projectId, { ...data, document_type: 'custom' }),
    onSuccess: () => { 
      void queryClient.invalidateQueries({ queryKey: ['project', id] })
    }
  })

  const deleteDocMut = useMutation({
    mutationFn: (docId: string) => api.deleteDocument(projectId, docId),
    onSuccess: () => { 
      void queryClient.invalidateQueries({ queryKey: ['project', id] })
      setSelectedDoc(null)
    }
  })

  const updateDocMut = useMutation({
    mutationFn: (data: { docId: string; title: string; content: string }) => 
      api.updateDocument(projectId, data.docId, { title: data.title, content: data.content }),
    onSuccess: (_result, variables) => { 
      void queryClient.invalidateQueries({ queryKey: ['project', id] })
      if (selectedDoc && selectedDoc.document_id === variables.docId) {
        setSelectedDoc({ ...selectedDoc, title: variables.title, content: variables.content })
      }
    }
  })

  return {
    createDocMut,
    deleteDocMut,
    updateDocMut,
  }
}
