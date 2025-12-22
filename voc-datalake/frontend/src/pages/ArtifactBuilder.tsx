/**
 * Artifact Builder - Generate web prototypes from prompts using Kiro CLI
 * Default view shows artifact history, with a modal for building new artifacts
 */

import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import {
  Sparkles,
  Loader2,
  ChevronDown,
  ChevronRight,
  Plus,
  X,
  Clock,
  CheckCircle,
  XCircle,
  ExternalLink,
  Settings,
  Trash2,
  RefreshCw,
  GitBranch,
  Code,
  Copy,
  Check,
  FileCode,
  Folder,
  ArrowLeft,
  Download,
  Eye,
  FileText,
  Terminal,
  File,
  Image,
  Package,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import { api } from '../api/client'
import type { ArtifactJob } from '../api/client'
import { useConfigStore } from '../store/configStore'
import clsx from 'clsx'

const STATUS_CONFIG: Record<string, { icon: typeof Clock; color: string; bg: string; label: string; animate?: boolean }> = {
  queued: { icon: Clock, color: 'text-gray-500', bg: 'bg-gray-100', label: 'Queued' },
  cloning: { icon: Loader2, color: 'text-blue-500', bg: 'bg-blue-100', label: 'Cloning', animate: true },
  generating: { icon: Loader2, color: 'text-blue-500', bg: 'bg-blue-100', label: 'Generating', animate: true },
  building: { icon: Loader2, color: 'text-yellow-500', bg: 'bg-yellow-100', label: 'Building', animate: true },
  publishing: { icon: Loader2, color: 'text-purple-500', bg: 'bg-purple-100', label: 'Publishing', animate: true },
  done: { icon: CheckCircle, color: 'text-green-500', bg: 'bg-green-100', label: 'Complete' },
  failed: { icon: XCircle, color: 'text-red-500', bg: 'bg-red-100', label: 'Failed' },
}

// Get file icon based on extension
function getFileIcon(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase()
  
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'ico'].includes(ext || '')) {
    return <Image className="w-4 h-4 text-purple-500" />
  }
  if (['js', 'jsx', 'ts', 'tsx'].includes(ext || '')) {
    return <FileCode className="w-4 h-4 text-yellow-500" />
  }
  if (['json', 'yaml', 'yml'].includes(ext || '')) {
    return <FileCode className="w-4 h-4 text-green-500" />
  }
  if (ext === 'md') {
    return <FileText className="w-4 h-4 text-blue-500" />
  }
  if (['css', 'scss'].includes(ext || '')) {
    return <FileCode className="w-4 h-4 text-pink-500" />
  }
  if (ext === 'html') {
    return <FileCode className="w-4 h-4 text-orange-500" />
  }
  if (filename === 'package.json') {
    return <Package className="w-4 h-4 text-red-500" />
  }
  return <File className="w-4 h-4 text-gray-400" />
}

// Code viewer with line numbers
function CodeViewer({ content }: { content: string }) {
  const lines = content.split('\n')
  
  return (
    <div className="bg-gray-900 rounded-lg overflow-hidden">
      <div className="flex text-sm font-mono">
        {/* Line numbers */}
        <div className="select-none bg-gray-800 text-gray-500 text-right py-4 px-3 border-r border-gray-700">
          {lines.map((_, i) => (
            <div key={i} className="leading-6">{i + 1}</div>
          ))}
        </div>
        {/* Code content */}
        <pre className="flex-1 overflow-x-auto py-4 px-4 text-gray-100">
          <code>
            {lines.map((line, i) => (
              <div key={i} className="leading-6 whitespace-pre">{line || ' '}</div>
            ))}
          </code>
        </pre>
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.queued
  const Icon = config.icon
  return (
    <span className={clsx('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-sm font-medium', config.bg, config.color)}>
      <Icon className={clsx('w-4 h-4', config.animate && 'animate-spin')} />
      {config.label}
    </span>
  )
}

function formatDate(dateString: string) {
  const date = new Date(dateString)
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function ArtifactBuilder() {
  const queryClient = useQueryClient()
  const { config } = useConfigStore()
  const isConfigured = !!config.artifactBuilderEndpoint
  const [searchParams] = useSearchParams()
  
  // Build modal state
  const [showBuildModal, setShowBuildModal] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [projectType, setProjectType] = useState('react-vite')
  const [style, setStyle] = useState('minimal')
  const [includeMockData, setIncludeMockData] = useState(false)
  const [pages, setPages] = useState<string[]>([])
  const [newPage, setNewPage] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)

  // Job detail state
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [showIterateModal, setShowIterateModal] = useState(false)
  const [iteratePrompt, setIteratePrompt] = useState('')
  const [iterateFromJobId, setIterateFromJobId] = useState<string | null>(null)
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set())
  
  // Auto-select job from URL param (e.g., /artifact-builder?job=abc123)
  useEffect(() => {
    const jobId = searchParams.get('job')
    if (jobId && !selectedJobId) {
      setSelectedJobId(jobId)
    }
  }, [searchParams, selectedJobId])
  const [showSourceModal, setShowSourceModal] = useState(false)
  const [sourceJobId, setSourceJobId] = useState<string | null>(null)
  const [copiedClone, setCopiedClone] = useState(false)
  const [sourceFiles, setSourceFiles] = useState<{ path: string; type: 'file' | 'folder' }[]>([])
  const [sourceFilesLoading, setSourceFilesLoading] = useState(false)
  const [selectedSourceFile, setSelectedSourceFile] = useState<string | null>(null)
  const [sourceFileContent, setSourceFileContent] = useState<string>('')
  const [sourceFileLoading, setSourceFileLoading] = useState(false)
  const [currentSourcePath, setCurrentSourcePath] = useState('')
  const [detailTab, setDetailTab] = useState<'preview' | 'prompt' | 'logs'>('preview')

  // Fetch templates
  const { data: templatesData } = useQuery({
    queryKey: ['artifact-templates'],
    queryFn: api.getArtifactTemplates,
    enabled: isConfigured,
  })

  const templates = templatesData?.templates || [{ id: 'react-vite', name: 'React + Vite' }]
  const styles = templatesData?.styles || [{ id: 'minimal', name: 'Minimal' }, { id: 'modern', name: 'Modern' }]

  // Fetch jobs
  const { data: jobsData, isLoading: jobsLoading } = useQuery({
    queryKey: ['artifact-jobs'],
    queryFn: () => api.getArtifactJobs(),
    refetchInterval: 5000,
    enabled: isConfigured,
  })

  // Show configuration message if not configured
  if (!isConfigured) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="w-20 h-20 bg-purple-100 rounded-full flex items-center justify-center mb-6">
          <Sparkles size={40} className="text-purple-500" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Artifact Builder</h1>
        <p className="text-gray-500 max-w-md mb-6">
          Generate working web prototypes from prompts using Kiro CLI. Configure the Artifact Builder endpoint to get started.
        </p>
        <Link
          to="/settings"
          className="flex items-center gap-2 px-6 py-3 bg-purple-600 text-white rounded-xl font-medium hover:bg-purple-700"
        >
          <Settings size={20} />
          Configure in Settings
        </Link>
      </div>
    )
  }

  const jobs = jobsData?.jobs || []

  // Group jobs: find root parents and nest ALL iterations (including nested) under them
  const groupedJobs = (() => {
    const jobMap = new Map<string, ArtifactJob>()
    
    // Build a map of all jobs by ID
    jobs.forEach((job: ArtifactJob) => {
      jobMap.set(job.job_id, job)
    })
    
    // Find the root parent for any job (trace back through parent_job_id chain)
    const findRootParentId = (job: ArtifactJob): string => {
      if (!job.parent_job_id) return job.job_id
      const parent = jobMap.get(job.parent_job_id)
      if (!parent) return job.job_id // Parent was deleted, treat as root
      return findRootParentId(parent)
    }
    
    const rootJobs: (ArtifactJob & { iterations?: ArtifactJob[] })[] = []
    const iterationsByRoot = new Map<string, ArtifactJob[]>()
    
    // Categorize each job as either a root or an iteration
    jobs.forEach((job: ArtifactJob) => {
      if (!job.parent_job_id) {
        // This is a root job
        rootJobs.push({ ...job, iterations: [] })
      } else {
        // This is an iteration - find its root parent
        const rootId = findRootParentId(job)
        const iterations = iterationsByRoot.get(rootId) || []
        iterations.push(job)
        iterationsByRoot.set(rootId, iterations)
      }
    })
    
    // Attach all iterations to their root parents
    rootJobs.forEach(root => {
      const iterations = iterationsByRoot.get(root.job_id) || []
      // Sort iterations by created_at descending (newest first)
      iterations.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      root.iterations = iterations
    })
    
    // Handle orphan iterations (root parent was deleted)
    iterationsByRoot.forEach((iterations, rootId) => {
      const rootExists = rootJobs.some(r => r.job_id === rootId)
      if (!rootExists) {
        // Find the oldest iteration to be the new "root"
        iterations.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
        const newRoot = iterations.shift()!
        rootJobs.push({ 
          ...newRoot, 
          iterations: iterations.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        })
      }
    })
    
    // Sort root jobs by created_at descending (newest first)
    rootJobs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    
    return rootJobs
  })()

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
    
    // Load root directory files and auto-select README.md
    setSourceFilesLoading(true)
    try {
      const response = await api.getArtifactSourceFiles(jobId, '')
      const files = response.files || []
      setSourceFiles(files)
      setCurrentSourcePath('')
      
      // Auto-select README.md if it exists
      const readme = files.find((f: { path: string; type: string }) => 
        f.type === 'file' && f.path.toLowerCase() === 'readme.md'
      )
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

  const loadSourceFiles = async (jobId: string, path: string) => {
    setSourceFilesLoading(true)
    try {
      const response = await api.getArtifactSourceFiles(jobId, path)
      setSourceFiles(response.files || [])
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
      const response = await api.getArtifactSourceFileContent(jobId, filePath)
      setSourceFileContent(response.content || '')
    } catch (error) {
      console.error('Error loading file content:', error)
      setSourceFileContent('Error loading file content')
    } finally {
      setSourceFileLoading(false)
    }
  }

  const copyCloneCommand = (jobId: string) => {
    const command = `git clone codecommit::us-west-2://artifact-${jobId}`
    navigator.clipboard.writeText(command)
    setCopiedClone(true)
    setTimeout(() => setCopiedClone(false), 2000)
  }

  // Fetch selected job details
  const { data: selectedJob } = useQuery({
    queryKey: ['artifact-job', selectedJobId],
    queryFn: () => api.getArtifactJob(selectedJobId!),
    enabled: !!selectedJobId,
    refetchInterval: (query) => {
      if (query.state.data?.status === 'done' || query.state.data?.status === 'failed') return false
      return 3000
    },
  })

  // Fetch logs for selected job
  const { data: logsData } = useQuery({
    queryKey: ['artifact-job-logs', selectedJobId],
    queryFn: () => api.getArtifactJobLogs(selectedJobId!),
    enabled: !!selectedJobId,
    refetchInterval: () => {
      if (selectedJob?.status === 'done' || selectedJob?.status === 'failed') return false
      return 5000
    },
  })

  // Fetch download URL when complete
  const { data: downloadData } = useQuery({
    queryKey: ['artifact-download', selectedJobId],
    queryFn: () => api.getArtifactDownloadUrl(selectedJobId!),
    enabled: selectedJob?.status === 'done',
  })

  // Create job mutation
  const createJob = useMutation({
    mutationFn: api.createArtifactJob,
    onSuccess: (data) => {
      setSelectedJobId(data.job_id)
      setShowBuildModal(false)
      resetBuildForm()
      queryClient.invalidateQueries({ queryKey: ['artifact-jobs'] })
    },
  })

  // Delete job mutation
  const deleteJob = useMutation({
    mutationFn: api.deleteArtifactJob,
    onSuccess: () => {
      setSelectedJobId(null)
      queryClient.invalidateQueries({ queryKey: ['artifact-jobs'] })
    },
  })

  // Iterate job mutation
  const iterateJob = useMutation({
    mutationFn: (data: { prompt: string; parent_job_id: string }) => 
      api.createArtifactJob({
        prompt: data.prompt,
        project_type: 'react-vite',
        style: 'minimal',
        parent_job_id: data.parent_job_id,
      }),
    onSuccess: (data) => {
      setSelectedJobId(data.job_id)
      setShowIterateModal(false)
      setIteratePrompt('')
      setIterateFromJobId(null)
      queryClient.invalidateQueries({ queryKey: ['artifact-jobs'] })
    },
  })

  const resetBuildForm = () => {
    setPrompt('')
    setProjectType('react-vite')
    setStyle('minimal')
    setIncludeMockData(false)
    setPages([])
    setNewPage('')
    setShowAdvanced(false)
  }

  const handleIterate = () => {
    if (!iteratePrompt.trim() || !iterateFromJobId) return
    iterateJob.mutate({ prompt: iteratePrompt.trim(), parent_job_id: iterateFromJobId })
  }

  const openIterateModal = (jobId: string) => {
    setIterateFromJobId(jobId)
    setIteratePrompt('')
    setShowIterateModal(true)
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!prompt.trim()) return
    createJob.mutate({
      prompt: prompt.trim(),
      project_type: projectType,
      style,
      include_mock_data: includeMockData,
      pages,
    })
  }

  const addPage = () => {
    if (newPage.trim() && !pages.includes(newPage.trim())) {
      setPages([...pages, newPage.trim()])
      setNewPage('')
    }
  }

  const removePage = (page: string) => {
    setPages(pages.filter(p => p !== page))
  }

  return (
    <div className="space-y-6">
      {/* Header with Build button */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Sparkles className="w-5 h-5 sm:w-6 sm:h-6 text-purple-500" />
            Artifacts
          </h1>
          <p className="text-sm sm:text-base text-gray-500 mt-1">Generated web prototypes from prompts</p>
        </div>
        <button
          onClick={() => setShowBuildModal(true)}
          className="flex items-center justify-center gap-2 px-4 sm:px-5 py-2 sm:py-2.5 bg-gradient-to-r from-purple-600 to-purple-700 hover:from-purple-700 hover:to-purple-800 text-white font-medium rounded-xl shadow-lg shadow-purple-500/25 transition-all text-sm sm:text-base"
        >
          <Plus className="w-4 h-4 sm:w-5 sm:h-5" />
          Build New Artifact
        </button>
      </div>

      {/* Artifacts List (default view) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
        {/* Jobs List */}
        <div className="lg:col-span-1 space-y-3">
          <h2 className="font-semibold text-gray-900">All Artifacts</h2>
          {jobsLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="w-6 h-6 animate-spin text-purple-500" />
            </div>
          ) : jobs.length === 0 ? (
            <div className="text-center py-10 text-gray-500">
              <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <Sparkles className="w-8 h-8 text-gray-300" />
              </div>
              <p className="mb-2">No artifacts yet</p>
              <button
                onClick={() => setShowBuildModal(true)}
                className="text-purple-600 hover:underline font-medium"
              >
                Build your first artifact
              </button>
            </div>
          ) : (
            groupedJobs.map((job) => (
              <div key={job.job_id}>
                {/* Parent Job */}
                <div className="flex items-start gap-2">
                  {/* Expand/Collapse button for jobs with iterations */}
                  {job.iterations && job.iterations.length > 0 ? (
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleParentExpanded(job.job_id) }}
                      className="mt-4 p-1 hover:bg-gray-100 rounded"
                    >
                      {expandedParents.has(job.job_id) ? (
                        <ChevronDown className="w-4 h-4 text-gray-500" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-gray-500" />
                      )}
                    </button>
                  ) : (
                    <div className="w-6" /> // Spacer for alignment
                  )}
                  <button
                    onClick={() => setSelectedJobId(job.job_id)}
                    className={clsx(
                      'flex-1 min-w-0 text-left p-4 rounded-xl border transition-all',
                      selectedJobId === job.job_id
                        ? 'border-purple-300 bg-purple-50'
                        : 'border-gray-200 bg-white hover:border-purple-200'
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-1.5 mb-2">
                      <span className="font-mono text-xs text-gray-500">#{job.job_id.slice(0, 8)}</span>
                      <StatusBadge status={job.status} />
                      {job.iterations && job.iterations.length > 0 && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-purple-100 text-purple-600 rounded text-xs whitespace-nowrap">
                          <GitBranch className="w-3 h-3" />
                          {job.iterations.length}
                        </span>
                      )}
                      {job.parent_job_id && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-blue-100 text-blue-600 rounded text-xs whitespace-nowrap">
                          <GitBranch className="w-3 h-3" />
                          iter
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-gray-900 line-clamp-2 break-words">{job.prompt}</p>
                    <p className="text-xs text-gray-500 mt-2">{formatDate(job.created_at)}</p>
                  </button>
                </div>

                {/* Iteration Jobs (children) */}
                {job.iterations && job.iterations.length > 0 && expandedParents.has(job.job_id) && (
                  <div className="ml-8 mt-2 space-y-2 border-l-2 border-purple-200 pl-4">
                    {job.iterations.map((iteration: ArtifactJob) => (
                      <button
                        key={iteration.job_id}
                        onClick={() => setSelectedJobId(iteration.job_id)}
                        className={clsx(
                          'w-full text-left p-3 rounded-lg border transition-all',
                          selectedJobId === iteration.job_id
                            ? 'border-blue-300 bg-blue-50'
                            : 'border-gray-200 bg-white hover:border-blue-200'
                        )}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <GitBranch className="w-3 h-3 text-blue-500" />
                          <span className="font-mono text-xs text-gray-500">#{iteration.job_id.slice(0, 8)}</span>
                          <StatusBadge status={iteration.status} />
                        </div>
                        <p className="text-sm text-gray-900 line-clamp-1">{iteration.prompt}</p>
                        <p className="text-xs text-gray-500 mt-1">{formatDate(iteration.created_at)}</p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Job Details */}
        <div className="lg:col-span-2">
          {selectedJob ? (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden flex flex-col h-[60vh] sm:h-[70vh] lg:h-[calc(100vh-180px)]">
              {/* Header */}
              <div className="p-3 sm:p-4 border-b shrink-0">
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2 sm:gap-0 mb-3">
                  <div>
                    <h3 className="font-semibold text-gray-900 text-sm sm:text-base">Job #{selectedJob.job_id.slice(0, 8)}</h3>
                    <p className="text-xs sm:text-sm text-gray-500">{formatDate(selectedJob.created_at)}</p>
                  </div>
                  <StatusBadge status={selectedJob.status} />
                </div>

                {/* Error Message */}
                {selectedJob.status === 'failed' && selectedJob.error && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-2 sm:p-3 mb-3">
                    <p className="text-xs sm:text-sm text-red-700">{selectedJob.error}</p>
                  </div>
                )}

                {/* Parent Job Info (for iterations) */}
                {selectedJob.parent_job_id && (
                  <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm text-purple-600 bg-purple-50 px-2 sm:px-3 py-2 rounded-lg mb-3">
                    <GitBranch className="w-3 h-3 sm:w-4 sm:h-4" />
                    <span>Iterated from job #{selectedJob.parent_job_id.slice(0, 8)}</span>
                    <button
                      onClick={() => setSelectedJobId(selectedJob.parent_job_id!)}
                      className="underline hover:text-purple-800"
                    >
                      View parent
                    </button>
                  </div>
                )}

                {/* Actions */}
                <div className="flex flex-wrap gap-2">
                  {selectedJob.status === 'done' && selectedJob.preview_url && (
                    <a
                      href={selectedJob.preview_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 bg-purple-600 hover:bg-purple-700 text-white text-xs sm:text-sm font-medium rounded-lg"
                    >
                      <ExternalLink className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                      <span className="hidden xs:inline">Open in New Tab</span>
                      <span className="xs:hidden">Open</span>
                    </a>
                  )}
                  {selectedJob.status === 'done' && (
                    <>
                      <button
                        onClick={() => openSourceModal(selectedJob.job_id)}
                        className="inline-flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 bg-gray-700 hover:bg-gray-800 text-white text-xs sm:text-sm font-medium rounded-lg"
                      >
                        <Code className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                        <span className="hidden sm:inline">View Source</span>
                        <span className="sm:hidden">Source</span>
                      </button>
                      <button
                        onClick={() => openIterateModal(selectedJob.job_id)}
                        className="inline-flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs sm:text-sm font-medium rounded-lg"
                      >
                        <RefreshCw className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                        Iterate
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => deleteJob.mutate(selectedJob.job_id)}
                    disabled={deleteJob.isPending}
                    className="inline-flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 bg-red-100 hover:bg-red-200 text-red-700 text-xs sm:text-sm font-medium rounded-lg disabled:opacity-50"
                  >
                    {deleteJob.isPending ? <Loader2 className="w-3 h-3 sm:w-3.5 sm:h-3.5 animate-spin" /> : <Trash2 className="w-3 h-3 sm:w-3.5 sm:h-3.5" />}
                    Delete
                  </button>
                </div>
              </div>

              {/* Tabs */}
              <div className="flex border-b shrink-0">
                <button
                  onClick={() => setDetailTab('preview')}
                  className={clsx(
                    'flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors',
                    detailTab === 'preview'
                      ? 'border-purple-600 text-purple-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  )}
                >
                  <Eye className="w-4 h-4" />
                  Preview
                </button>
                <button
                  onClick={() => setDetailTab('prompt')}
                  className={clsx(
                    'flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors',
                    detailTab === 'prompt'
                      ? 'border-purple-600 text-purple-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  )}
                >
                  <FileText className="w-4 h-4" />
                  Prompt
                </button>
                <button
                  onClick={() => setDetailTab('logs')}
                  className={clsx(
                    'flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors',
                    detailTab === 'logs'
                      ? 'border-purple-600 text-purple-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  )}
                >
                  <Terminal className="w-4 h-4" />
                  Logs
                </button>
              </div>

              {/* Tab Content */}
              <div className="flex-1 overflow-hidden">
                {detailTab === 'preview' && (
                  <div className="h-full">
                    {selectedJob.status === 'done' && selectedJob.preview_url ? (
                      <iframe
                        src={selectedJob.preview_url}
                        className="w-full h-full border-0"
                        title={`Preview for job ${selectedJob.job_id}`}
                      />
                    ) : selectedJob.status === 'done' ? (
                      <div className="flex items-center justify-center h-full text-gray-500">
                        <p>Preview not available</p>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center justify-center h-full text-gray-500">
                        <Loader2 className="w-8 h-8 animate-spin mb-3 text-purple-500" />
                        <p className="font-medium">Building artifact...</p>
                        <p className="text-sm mt-1">Status: {selectedJob.status}</p>
                      </div>
                    )}
                  </div>
                )}

                {detailTab === 'prompt' && (
                  <div className="p-4 overflow-y-auto h-full">
                    <div className="mb-4 flex flex-wrap gap-2">
                      <span className="px-2 py-1 bg-gray-100 rounded text-xs">{selectedJob.project_type}</span>
                      <span className="px-2 py-1 bg-gray-100 rounded text-xs">{selectedJob.style}</span>
                      {selectedJob.include_mock_data && (
                        <span className="px-2 py-1 bg-gray-100 rounded text-xs">Mock Data</span>
                      )}
                    </div>
                    <p className="text-gray-900 whitespace-pre-wrap bg-gray-50 p-4 rounded-lg text-sm">
                      {selectedJob.prompt}
                    </p>
                  </div>
                )}

                {detailTab === 'logs' && (
                  <div className="h-full p-4">
                    <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-auto text-xs font-mono h-full whitespace-pre-wrap">
                      {logsData?.logs || 'Waiting for logs...'}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-gray-50 rounded-xl border border-gray-200 p-6 sm:p-10 text-center text-gray-500 h-[40vh] sm:h-[50vh] lg:h-[calc(100vh-180px)]">
              <div className="flex flex-col items-center justify-center h-full">
                <Sparkles className="w-10 h-10 sm:w-12 sm:h-12 text-gray-300 mb-3" />
                <p className="text-sm sm:text-base">Select an artifact to view details</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Build New Artifact Modal */}
      {showBuildModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 sm:p-4">
          <div className="bg-white rounded-xl w-full max-w-2xl max-h-[95vh] sm:max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-3 sm:p-4 border-b shrink-0">
              <div className="flex items-center gap-2 sm:gap-3">
                <div className="w-8 h-8 sm:w-10 sm:h-10 bg-purple-100 rounded-lg flex items-center justify-center">
                  <Sparkles className="w-4 h-4 sm:w-5 sm:h-5 text-purple-600" />
                </div>
                <div>
                  <h2 className="text-base sm:text-lg font-semibold">Build New Artifact</h2>
                  <p className="text-xs sm:text-sm text-gray-500">Generate a web prototype from your prompt</p>
                </div>
              </div>
              <button 
                onClick={() => { setShowBuildModal(false); resetBuildForm() }} 
                className="p-2 hover:bg-gray-100 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 sm:space-y-6">
              {/* Main Prompt */}
              <div>
                <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-2">
                  What do you want to build?
                </label>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="A landing page for a SaaS product with pricing table, feature highlights, and a contact form..."
                  className="w-full h-28 sm:h-32 px-3 sm:px-4 py-2 sm:py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-purple-500 focus:border-purple-500 resize-none text-sm sm:text-base"
                  required
                  autoFocus
                />
                <p className="mt-1 text-xs sm:text-sm text-gray-500">
                  Be specific about pages, features, and design preferences
                </p>
              </div>

              {/* Quick Options */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-2">
                    Project Type
                  </label>
                  <select
                    value={projectType}
                    onChange={(e) => setProjectType(e.target.value)}
                    className="w-full px-3 sm:px-4 py-2 sm:py-2.5 border border-gray-300 rounded-xl focus:ring-2 focus:ring-purple-500 focus:border-purple-500 bg-white text-sm sm:text-base"
                  >
                    {templates.map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-2">
                    Style
                  </label>
                  <select
                    value={style}
                    onChange={(e) => setStyle(e.target.value)}
                    className="w-full px-3 sm:px-4 py-2 sm:py-2.5 border border-gray-300 rounded-xl focus:ring-2 focus:ring-purple-500 focus:border-purple-500 bg-white text-sm sm:text-base"
                  >
                    {styles.map(s => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Mock Data Toggle */}
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeMockData}
                  onChange={(e) => setIncludeMockData(e.target.checked)}
                  className="w-5 h-5 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                />
                <span className="text-sm text-gray-700">Include realistic mock data</span>
              </label>

              {/* Advanced Options */}
              <div>
                <button
                  type="button"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900"
                >
                  <ChevronDown className={clsx('w-4 h-4 transition-transform', showAdvanced && 'rotate-180')} />
                  Advanced Options
                </button>

                {showAdvanced && (
                  <div className="mt-4 p-4 bg-gray-50 rounded-xl space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Specific Pages (optional)
                      </label>
                      <div className="flex gap-2 mb-2">
                        <input
                          type="text"
                          value={newPage}
                          onChange={(e) => setNewPage(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addPage())}
                          placeholder="e.g., About, Pricing, Contact"
                          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                        />
                        <button
                          type="button"
                          onClick={addPage}
                          className="px-3 py-2 bg-gray-200 hover:bg-gray-300 rounded-lg"
                        >
                          <Plus className="w-5 h-5" />
                        </button>
                      </div>
                      {pages.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {pages.map(page => (
                            <span
                              key={page}
                              className="inline-flex items-center gap-1 px-3 py-1 bg-purple-100 text-purple-700 rounded-full text-sm"
                            >
                              {page}
                              <button type="button" onClick={() => removePage(page)} className="hover:text-purple-900">
                                <X className="w-4 h-4" />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </form>

            {/* Footer */}
            <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 sm:gap-3 p-3 sm:p-4 border-t bg-gray-50 shrink-0">
              <button 
                type="button"
                onClick={() => { setShowBuildModal(false); resetBuildForm() }} 
                className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm sm:text-base"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={!prompt.trim() || createJob.isPending}
                className="flex items-center justify-center gap-2 px-4 sm:px-6 py-2 bg-gradient-to-r from-purple-600 to-purple-700 hover:from-purple-700 hover:to-purple-800 text-white font-medium rounded-lg shadow-lg shadow-purple-500/25 disabled:opacity-50 disabled:cursor-not-allowed text-sm sm:text-base"
              >
                {createJob.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    Generate Artifact
                  </>
                )}
              </button>
            </div>

            {createJob.isError && (
              <p className="px-6 pb-4 text-red-600 text-sm text-center">
                {(createJob.error as Error).message}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Iterate Modal */}
      {showIterateModal && iterateFromJobId && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 sm:p-4">
          <div className="bg-white rounded-xl w-full max-w-2xl max-h-[95vh] sm:max-h-[90vh] overflow-hidden">
            <div className="flex items-center justify-between p-3 sm:p-4 border-b">
              <div className="flex items-center gap-2 sm:gap-3">
                <div className="w-8 h-8 sm:w-10 sm:h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                  <RefreshCw className="w-4 h-4 sm:w-5 sm:h-5 text-blue-600" />
                </div>
                <div>
                  <h2 className="text-base sm:text-lg font-semibold">Iterate on Artifact</h2>
                  <p className="text-xs sm:text-sm text-gray-500">Continue building from job #{iterateFromJobId.slice(0, 8)}</p>
                </div>
              </div>
              <button 
                onClick={() => { setShowIterateModal(false); setIteratePrompt(''); setIterateFromJobId(null) }} 
                className="p-2 hover:bg-gray-100 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 sm:p-6 space-y-4">
              <div>
                <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-2">
                  What changes do you want to make?
                </label>
                <textarea
                  value={iteratePrompt}
                  onChange={(e) => setIteratePrompt(e.target.value)}
                  placeholder="e.g., Add a dark mode toggle, Change the hero section colors to blue, Add a contact form page..."
                  className="w-full h-28 sm:h-32 px-3 sm:px-4 py-2 sm:py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none text-sm sm:text-base"
                  autoFocus
                />
                <p className="mt-2 text-xs sm:text-sm text-gray-500">
                  Kiro will modify the existing codebase based on your request, preserving what's already built.
                </p>
              </div>
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 sm:p-4">
                <h4 className="font-medium text-blue-800 mb-2 text-sm sm:text-base">💡 Iteration Tips</h4>
                <ul className="text-xs sm:text-sm text-blue-700 space-y-1">
                  <li>• Be specific about what you want to change</li>
                  <li>• Reference existing components or pages by name</li>
                  <li>• You can iterate multiple times on the same artifact</li>
                </ul>
              </div>
            </div>
            <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 sm:gap-3 p-3 sm:p-4 border-t bg-gray-50">
              <button 
                onClick={() => { setShowIterateModal(false); setIteratePrompt(''); setIterateFromJobId(null) }} 
                className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm sm:text-base"
              >
                Cancel
              </button>
              <button
                onClick={handleIterate}
                disabled={!iteratePrompt.trim() || iterateJob.isPending}
                className="flex items-center justify-center gap-2 px-4 sm:px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm sm:text-base"
              >
                {iterateJob.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4" />
                    Start Iteration
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Source Code Modal */}
      {showSourceModal && sourceJobId && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 sm:p-4">
          <div className="bg-white rounded-xl w-full max-w-5xl h-[95vh] sm:h-[85vh] flex flex-col overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between p-3 sm:p-4 border-b shrink-0">
              <div className="flex items-center gap-2 sm:gap-3">
                <div className="w-8 h-8 sm:w-10 sm:h-10 bg-gray-100 rounded-lg flex items-center justify-center">
                  <Code className="w-4 h-4 sm:w-5 sm:h-5 text-gray-600" />
                </div>
                <div>
                  <h2 className="text-base sm:text-lg font-semibold">Source Code</h2>
                  <p className="text-xs sm:text-sm text-gray-500">Job #{sourceJobId.slice(0, 8)}</p>
                </div>
              </div>
              <button 
                onClick={() => { setShowSourceModal(false); setSourceJobId(null); setSourceFiles([]); setSelectedSourceFile(null) }} 
                className="p-2 hover:bg-gray-100 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Clone Instructions */}
            <div className="p-3 sm:p-4 bg-gray-50 border-b shrink-0">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-xs sm:text-sm font-medium text-gray-700">Clone this repository</p>
                  <p className="text-xs text-gray-500 mt-0.5 sm:mt-1 hidden sm:block">Requires AWS CLI with CodeCommit credentials configured</p>
                </div>
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                  <button
                    onClick={() => copyCloneCommand(sourceJobId)}
                    className="flex items-center justify-center gap-2 px-3 py-2 bg-gray-900 hover:bg-gray-800 text-white text-xs sm:text-sm font-mono rounded-lg overflow-hidden"
                  >
                    {copiedClone ? <Check className="w-4 h-4 shrink-0" /> : <Copy className="w-4 h-4 shrink-0" />}
                    <span className="truncate">git clone ...artifact-{sourceJobId.slice(0, 8)}</span>
                  </button>
                  {downloadData?.download_url && (
                    <a
                      href={downloadData.download_url}
                      className="flex items-center justify-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white text-xs sm:text-sm font-medium rounded-lg"
                    >
                      <Download className="w-4 h-4" />
                      Download ZIP
                    </a>
                  )}
                </div>
              </div>
            </div>

            {/* File Browser */}
            <div className="flex-1 flex flex-col sm:flex-row overflow-hidden">
              {/* File Tree */}
              <div className="w-full sm:w-56 md:w-64 border-b sm:border-b-0 sm:border-r bg-gray-50 overflow-hidden flex flex-col shrink-0 h-40 sm:h-auto">
                <div className="h-10 sm:h-11 px-3 border-b bg-white flex items-center shrink-0">
                  {currentSourcePath ? (
                    <button
                      onClick={() => {
                        const parentPath = currentSourcePath.split('/').slice(0, -1).join('/')
                        loadSourceFiles(sourceJobId, parentPath)
                      }}
                      className="flex items-center gap-2 text-xs sm:text-sm text-gray-600 hover:text-gray-900"
                    >
                      <ArrowLeft className="w-4 h-4" />
                      <span className="truncate max-w-[140px] sm:max-w-[180px]">/{currentSourcePath || 'Back'}</span>
                    </button>
                  ) : (
                    <span className="text-xs sm:text-sm font-medium text-gray-700">Files</span>
                  )}
                </div>
                {sourceFilesLoading ? (
                  <div className="flex-1 flex items-center justify-center">
                    <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
                  </div>
                ) : sourceFiles.length === 0 ? (
                  <div className="flex-1 flex items-center justify-center p-4 text-xs sm:text-sm text-gray-500 text-center">
                    No files found
                  </div>
                ) : (
                  <div className="flex-1 overflow-y-auto p-2 space-y-1">
                    {sourceFiles.map((file) => (
                      <button
                        key={file.path}
                        onClick={() => {
                          if (file.type === 'folder') {
                            loadSourceFiles(sourceJobId, file.path)
                          } else {
                            loadSourceFileContent(sourceJobId, file.path)
                          }
                        }}
                        className={clsx(
                          'w-full flex items-center gap-2 px-2 sm:px-3 py-1.5 sm:py-2 rounded-lg text-left text-xs sm:text-sm transition-colors',
                          selectedSourceFile === file.path
                            ? 'bg-purple-100 text-purple-700'
                            : 'hover:bg-gray-100 text-gray-700'
                        )}
                      >
                        {file.type === 'folder' ? (
                          <Folder className="w-4 h-4 text-yellow-500 shrink-0" />
                        ) : (
                          getFileIcon(file.path.split('/').pop() || '')
                        )}
                        <span className="truncate">{file.path.split('/').pop()}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* File Content */}
              <div className="flex-1 flex flex-col overflow-hidden min-h-0">
                <div className="h-10 sm:h-11 px-3 border-b bg-white flex items-center gap-2 shrink-0">
                  {selectedSourceFile ? (
                    <>
                      {getFileIcon(selectedSourceFile.split('/').pop() || '')}
                      <p className="text-xs sm:text-sm font-mono text-gray-700 truncate">{selectedSourceFile}</p>
                    </>
                  ) : (
                    <span className="text-xs sm:text-sm text-gray-400">No file selected</span>
                  )}
                </div>
                {selectedSourceFile ? (
                  <div className="flex-1 overflow-auto">
                    {sourceFileLoading ? (
                      <div className="flex items-center justify-center h-full">
                        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                      </div>
                    ) : selectedSourceFile.toLowerCase().endsWith('.md') ? (
                      // Markdown rendering
                      <div className="p-4 sm:p-6 prose prose-sm max-w-none">
                        <ReactMarkdown
                          components={{
                            h1: ({ children }) => <h1 className="text-2xl font-bold text-gray-900 mt-6 mb-3">{children}</h1>,
                            h2: ({ children }) => <h2 className="text-xl font-semibold text-gray-900 mt-5 mb-2">{children}</h2>,
                            h3: ({ children }) => <h3 className="text-lg font-medium text-gray-900 mt-4 mb-2">{children}</h3>,
                            p: ({ children }) => <p className="text-gray-700 my-2">{children}</p>,
                            ul: ({ children }) => <ul className="list-disc list-inside my-2 space-y-1">{children}</ul>,
                            ol: ({ children }) => <ol className="list-decimal list-inside my-2 space-y-1">{children}</ol>,
                            li: ({ children }) => <li className="text-gray-700">{children}</li>,
                            code: ({ className, children }) => {
                              const isInline = !className
                              return isInline ? (
                                <code className="bg-gray-100 px-1.5 py-0.5 rounded text-sm font-mono text-pink-600">{children}</code>
                              ) : (
                                <code className="block bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto my-3 text-sm font-mono">{children}</code>
                              )
                            },
                            pre: ({ children }) => <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto my-3 text-sm">{children}</pre>,
                            a: ({ href, children }) => <a href={href} className="text-blue-600 hover:underline" target="_blank" rel="noopener noreferrer">{children}</a>,
                            strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                            em: ({ children }) => <em className="italic">{children}</em>,
                          }}
                        >
                          {sourceFileContent}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      // Code with line numbers
                      <div className="p-3 sm:p-4">
                        <CodeViewer content={sourceFileContent} />
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-gray-500">
                    <div className="text-center p-4">
                      <FileCode className="w-10 h-10 sm:w-12 sm:h-12 mx-auto mb-3 text-gray-300" />
                      <p className="text-xs sm:text-sm">Select a file to view its contents</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
