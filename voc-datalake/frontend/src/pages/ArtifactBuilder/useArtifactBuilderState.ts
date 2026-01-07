/**
 * @fileoverview Custom hook for ArtifactBuilder state management.
 * @module pages/ArtifactBuilder/useArtifactBuilderState
 */

import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import type { ArtifactJob } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import { groupJobs, type GroupedJob } from './artifactBuilderHelpers'

interface SourceFile {
  path: string
  type: 'file' | 'folder'
}

interface CreateJobData {
  prompt: string
  project_type: string
  style: string
  include_mock_data?: boolean
  pages?: string[]
  parent_job_id?: string
}

// Use 0 to disable refetching (consistent number type)
const REFETCH_DISABLED = 0
const JOB_REFETCH_INTERVAL = 3000
const LOGS_REFETCH_INTERVAL = 5000

function isCompletedStatus(status: string | undefined): boolean {
  return status === 'done' || status === 'failed'
}

function getJobRefetchInterval(status: string | undefined): number {
  return isCompletedStatus(status) ? REFETCH_DISABLED : JOB_REFETCH_INTERVAL
}

function getLogsRefetchInterval(status: string | undefined): number {
  return isCompletedStatus(status) ? REFETCH_DISABLED : LOGS_REFETCH_INTERVAL
}

export function useArtifactBuilderState() {
  const queryClient = useQueryClient()
  const { config } = useConfigStore()
  const isConfigured = !!config.artifactBuilderEndpoint
  const [searchParams] = useSearchParams()

  // Job selection state
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set())
  const [detailTab, setDetailTab] = useState<'preview' | 'prompt' | 'logs'>('preview')

  // Modal state
  const [showBuildModal, setShowBuildModal] = useState(false)
  const [showIterateModal, setShowIterateModal] = useState(false)
  const [iterateFromJobId, setIterateFromJobId] = useState<string | null>(null)

  // Source modal state
  const [showSourceModal, setShowSourceModal] = useState(false)
  const [sourceJobId, setSourceJobId] = useState<string | null>(null)
  const [copiedClone, setCopiedClone] = useState(false)
  const [sourceFiles, setSourceFiles] = useState<SourceFile[]>([])
  const [sourceFilesLoading, setSourceFilesLoading] = useState(false)
  const [selectedSourceFile, setSelectedSourceFile] = useState<string | null>(null)
  const [sourceFileContent, setSourceFileContent] = useState<string>('')
  const [sourceFileLoading, setSourceFileLoading] = useState(false)
  const [currentSourcePath, setCurrentSourcePath] = useState('')

  // Auto-select job from URL param
  useEffect(() => {
    const jobId = searchParams.get('job')
    if (jobId && !selectedJobId) {
      setSelectedJobId(jobId)
    }
  }, [searchParams, selectedJobId])

  // Fetch templates
  const { data: templatesData } = useQuery({
    queryKey: ['artifact-templates'],
    queryFn: () => import('../../api/artifactApi').then(m => m.artifactApi.getTemplates()),
    enabled: isConfigured,
  })

  // Fetch jobs
  const { data: jobsData, isLoading: jobsLoading } = useQuery({
    queryKey: ['artifact-jobs'],
    queryFn: () => import('../../api/artifactApi').then(m => m.artifactApi.getJobs()),
    refetchInterval: 5000,
    enabled: isConfigured,
  })

  // Fetch selected job details
  const { data: selectedJob } = useQuery({
    queryKey: ['artifact-job', selectedJobId],
    queryFn: () => {
      if (!selectedJobId) return Promise.reject(new Error('No job selected'))
      return import('../../api/artifactApi').then(m => m.artifactApi.getJob(selectedJobId))
    },
    enabled: isConfigured && !!selectedJobId,
    refetchInterval: (query) => getJobRefetchInterval(query.state.data?.status),
  })

  // Fetch logs for selected job
  const { data: logsData } = useQuery({
    queryKey: ['artifact-job-logs', selectedJobId],
    queryFn: () => {
      if (!selectedJobId) return Promise.reject(new Error('No job selected'))
      return import('../../api/artifactApi').then(m => m.artifactApi.getJobLogs(selectedJobId))
    },
    enabled: isConfigured && !!selectedJobId,
    refetchInterval: () => getLogsRefetchInterval(selectedJob?.status),
  })

  // Fetch download URL when complete
  const { data: downloadData } = useQuery({
    queryKey: ['artifact-download', selectedJobId],
    queryFn: () => {
      if (!selectedJobId) return Promise.reject(new Error('No job selected'))
      return import('../../api/artifactApi').then(m => m.artifactApi.getDownloadUrl(selectedJobId))
    },
    enabled: isConfigured && selectedJob?.status === 'done',
  })

  // Create job mutation
  const createJob = useMutation({
    mutationFn: (data: CreateJobData) =>
      import('../../api/artifactApi').then(m => m.artifactApi.createJob(data)),
    onSuccess: (data) => {
      setSelectedJobId(data.job_id)
      setShowBuildModal(false)
      queryClient.invalidateQueries({ queryKey: ['artifact-jobs'] })
    },
  })

  // Delete job mutation
  const deleteJob = useMutation({
    mutationFn: (jobId: string) => import('../../api/artifactApi').then(m => m.artifactApi.deleteJob(jobId)),
    onSuccess: () => {
      setSelectedJobId(null)
      queryClient.invalidateQueries({ queryKey: ['artifact-jobs'] })
    },
  })

  // Iterate job mutation
  const iterateJob = useMutation({
    mutationFn: (data: { prompt: string; parent_job_id: string }) => 
      import('../../api/artifactApi').then(m => m.artifactApi.createJob({
        prompt: data.prompt,
        project_type: 'react-vite',
        style: 'minimal',
        parent_job_id: data.parent_job_id,
      })),
    onSuccess: (data) => {
      setSelectedJobId(data.job_id)
      setShowIterateModal(false)
      setIterateFromJobId(null)
      queryClient.invalidateQueries({ queryKey: ['artifact-jobs'] })
    },
  })

  // Derived data
  const templates = templatesData?.templates ?? [{ id: 'react-vite', name: 'React + Vite' }]
  const styles = templatesData?.styles ?? [{ id: 'minimal', name: 'Minimal' }, { id: 'modern', name: 'Modern' }]
  const jobs: ArtifactJob[] = jobsData?.jobs ?? []
  const groupedJobs: GroupedJob[] = groupJobs(jobs)

  // Actions
  const toggleParentExpanded = (jobId: string) => {
    setExpandedParents(prev => {
      const next = new Set(prev)
      if (next.has(jobId)) {
        next.delete(jobId)
      } else {
        next.add(jobId)
      }
      return next
    })
  }

  const openSourceModal = async (jobId: string) => {
    setSourceJobId(jobId)
    setShowSourceModal(true)
    setSourceFiles([])
    setSelectedSourceFile(null)
    setSourceFileContent('')
    setCurrentSourcePath('')
    
    setSourceFilesLoading(true)
    try {
      const { artifactApi } = await import('../../api/artifactApi')
      const response = await artifactApi.getSourceFiles(jobId, '')
      const files = response.files ?? []
      setSourceFiles(files)
      setCurrentSourcePath('')
      
      const readme = files.find((f) => f.type === 'file' && f.path.toLowerCase() === 'readme.md')
      if (readme) {
        loadSourceFileContent(jobId, readme.path)
      }
    } catch (error) {
      console.error('Error loading source files:', error)
      setSourceFiles([])
    } finally {
      setSourceFilesLoading(false)
    }
  }

  const loadSourceFiles = async (path: string) => {
    if (!sourceJobId) return
    setSourceFilesLoading(true)
    try {
      const { artifactApi } = await import('../../api/artifactApi')
      const response = await artifactApi.getSourceFiles(sourceJobId, path)
      setSourceFiles(response.files ?? [])
      setCurrentSourcePath(path)
    } catch (error) {
      console.error('Error loading source files:', error)
      setSourceFiles([])
    } finally {
      setSourceFilesLoading(false)
    }
  }

  const loadSourceFileContent = async (jobId: string, filePath: string) => {
    setSourceFileLoading(true)
    setSelectedSourceFile(filePath)
    try {
      const { artifactApi } = await import('../../api/artifactApi')
      const response = await artifactApi.getSourceFileContent(jobId, filePath)
      setSourceFileContent(response.content ?? '')
    } catch (error) {
      console.error('Error loading file content:', error)
      setSourceFileContent('Error loading file content')
    } finally {
      setSourceFileLoading(false)
    }
  }

  const copyCloneCommand = () => {
    if (!sourceJobId) return
    const command = `git clone codecommit::us-west-2://artifact-${sourceJobId}`
    navigator.clipboard.writeText(command)
    setCopiedClone(true)
    setTimeout(() => setCopiedClone(false), 2000)
  }

  const openIterateModal = (jobId: string) => {
    setIterateFromJobId(jobId)
    setShowIterateModal(true)
  }

  const closeIterateModal = () => {
    setShowIterateModal(false)
    setIterateFromJobId(null)
  }

  const closeSourceModal = () => {
    setShowSourceModal(false)
    setSourceJobId(null)
    setSourceFiles([])
    setSelectedSourceFile(null)
  }

  const handleCreateJob = (data: {
    prompt: string
    projectType: string
    style: string
    includeMockData: boolean
    pages: string[]
  }) => {
    createJob.mutate({
      prompt: data.prompt,
      project_type: data.projectType,
      style: data.style,
      include_mock_data: data.includeMockData,
      pages: data.pages,
    })
  }

  const handleIterate = (prompt: string) => {
    if (!iterateFromJobId) return
    iterateJob.mutate({ prompt, parent_job_id: iterateFromJobId })
  }

  const handleLoadSourceFileContent = (filePath: string) => {
    if (!sourceJobId) return
    loadSourceFileContent(sourceJobId, filePath)
  }

  return {
    // Config
    isConfigured,
    
    // Data
    templates,
    styles,
    jobs,
    groupedJobs,
    jobsLoading,
    selectedJob,
    logsData,
    downloadData,
    
    // Job selection
    selectedJobId,
    setSelectedJobId,
    expandedParents,
    toggleParentExpanded,
    detailTab,
    setDetailTab,
    
    // Build modal
    showBuildModal,
    setShowBuildModal,
    createJob,
    handleCreateJob,
    
    // Iterate modal
    showIterateModal,
    iterateFromJobId,
    openIterateModal,
    closeIterateModal,
    iterateJob,
    handleIterate,
    
    // Source modal
    showSourceModal,
    sourceJobId,
    openSourceModal,
    closeSourceModal,
    sourceFiles,
    sourceFilesLoading,
    selectedSourceFile,
    sourceFileContent,
    sourceFileLoading,
    currentSourcePath,
    loadSourceFiles,
    handleLoadSourceFileContent,
    copyCloneCommand,
    copiedClone,
    
    // Delete
    deleteJob,
  }
}
