/**
 * Artifact Builder - Generate web prototypes from prompts using Kiro CLI
 */

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
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
  History,
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
} from 'lucide-react'
import { Link } from 'react-router-dom'
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
  const [activeTab, setActiveTab] = useState<'build' | 'history'>('build')
  const [prompt, setPrompt] = useState('')
  const [projectType, setProjectType] = useState('react-vite')
  const [style, setStyle] = useState('minimal')
  const [includeMockData, setIncludeMockData] = useState(false)
  const [pages, setPages] = useState<string[]>([])
  const [newPage, setNewPage] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [showIterateModal, setShowIterateModal] = useState(false)
  const [iteratePrompt, setIteratePrompt] = useState('')
  const [iterateFromJobId, setIterateFromJobId] = useState<string | null>(null)
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set())
  const [showSourceModal, setShowSourceModal] = useState(false)
  const [sourceJobId, setSourceJobId] = useState<string | null>(null)
  const [copiedClone, setCopiedClone] = useState(false)
  const [sourceFiles, setSourceFiles] = useState<{ path: string; type: 'file' | 'folder' }[]>([])
  const [sourceFilesLoading, setSourceFilesLoading] = useState(false)
  const [selectedSourceFile, setSelectedSourceFile] = useState<string | null>(null)
  const [sourceFileContent, setSourceFileContent] = useState<string>('')
  const [sourceFileLoading, setSourceFileLoading] = useState(false)
  const [currentSourcePath, setCurrentSourcePath] = useState('')

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

  // Group jobs: parent jobs with their iterations as children
  const groupedJobs = (() => {
    const parentJobs: (ArtifactJob & { iterations?: ArtifactJob[] })[] = []
    const iterationMap = new Map<string, ArtifactJob[]>()
    
    // First pass: separate parent jobs and iterations
    jobs.forEach((job: ArtifactJob) => {
      if (job.parent_job_id) {
        const iterations = iterationMap.get(job.parent_job_id) || []
        iterations.push(job)
        iterationMap.set(job.parent_job_id, iterations)
      } else {
        parentJobs.push({ ...job, iterations: [] })
      }
    })
    
    // Second pass: attach iterations to their parents
    parentJobs.forEach(parent => {
      const iterations = iterationMap.get(parent.job_id) || []
      // Sort iterations by created_at descending
      iterations.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      parent.iterations = iterations
    })
    
    // Handle orphan iterations (parent was deleted)
    iterationMap.forEach((iterations, parentId) => {
      const parentExists = parentJobs.some(p => p.job_id === parentId)
      if (!parentExists) {
        // Add iterations as standalone jobs
        iterations.forEach(iter => parentJobs.push({ ...iter, iterations: [] }))
      }
    })
    
    return parentJobs
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
    
    // Load root directory files
    await loadSourceFiles(jobId, '')
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
      setActiveTab('history')
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
      {/* Header with tabs */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-purple-500" />
            Artifact Builder
          </h1>
          <p className="text-gray-500 mt-1">Generate working web prototypes from prompts</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setActiveTab('build')}
            className={clsx(
              'px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2',
              activeTab === 'build' ? 'bg-purple-100 text-purple-700' : 'text-gray-600 hover:bg-gray-100'
            )}
          >
            <Sparkles className="w-4 h-4" />
            Build
          </button>
          <button
            onClick={() => setActiveTab('history')}
            className={clsx(
              'px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2',
              activeTab === 'history' ? 'bg-purple-100 text-purple-700' : 'text-gray-600 hover:bg-gray-100'
            )}
          >
            <History className="w-4 h-4" />
            History
          </button>
        </div>
      </div>

      {activeTab === 'build' ? (
        /* Build Form */
        <div className="max-w-3xl">
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Main Prompt */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                What do you want to build?
              </label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="A landing page for a SaaS product with pricing table, feature highlights, and a contact form..."
                className="w-full h-40 px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-purple-500 focus:border-purple-500 resize-none"
                required
              />
              <p className="mt-1 text-sm text-gray-500">
                Be specific about pages, features, and design preferences
              </p>
            </div>

            {/* Quick Options */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Project Type
                </label>
                <select
                  value={projectType}
                  onChange={(e) => setProjectType(e.target.value)}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-xl focus:ring-2 focus:ring-purple-500 focus:border-purple-500 bg-white"
                >
                  {templates.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Style
                </label>
                <select
                  value={style}
                  onChange={(e) => setStyle(e.target.value)}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-xl focus:ring-2 focus:ring-purple-500 focus:border-purple-500 bg-white"
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

            {/* Submit Button */}
            <button
              type="submit"
              disabled={!prompt.trim() || createJob.isPending}
              className="w-full py-4 bg-gradient-to-r from-purple-600 to-purple-700 hover:from-purple-700 hover:to-purple-800 text-white font-semibold rounded-xl shadow-lg shadow-purple-500/25 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
            >
              {createJob.isPending ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Sparkles className="w-5 h-5" />
                  Generate Artifact
                </>
              )}
            </button>

            {createJob.isError && (
              <p className="text-red-600 text-sm text-center">
                {(createJob.error as Error).message}
              </p>
            )}
          </form>
        </div>
      ) : (
        /* History View */
        <div className="grid lg:grid-cols-3 gap-6">
          {/* Jobs List */}
          <div className="lg:col-span-1 space-y-3">
            <h2 className="font-semibold text-gray-900">Build History</h2>
            {jobsLoading ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="w-6 h-6 animate-spin text-purple-500" />
              </div>
            ) : jobs.length === 0 ? (
              <div className="text-center py-10 text-gray-500">
                <p>No artifacts yet</p>
                <button
                  onClick={() => setActiveTab('build')}
                  className="mt-2 text-purple-600 hover:underline"
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
                        'flex-1 text-left p-4 rounded-xl border transition-all',
                        selectedJobId === job.job_id
                          ? 'border-purple-300 bg-purple-50'
                          : 'border-gray-200 bg-white hover:border-purple-200'
                      )}
                    >
                      <div className="flex items-center gap-2 mb-2">
                        <span className="font-mono text-xs text-gray-500">#{job.job_id.slice(0, 8)}</span>
                        <StatusBadge status={job.status} />
                        {job.iterations && job.iterations.length > 0 && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-purple-100 text-purple-600 rounded text-xs">
                            <GitBranch className="w-3 h-3" />
                            {job.iterations.length} iteration{job.iterations.length > 1 ? 's' : ''}
                          </span>
                        )}
                        {job.parent_job_id && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-blue-100 text-blue-600 rounded text-xs">
                            <GitBranch className="w-3 h-3" />
                            iteration
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-gray-900 line-clamp-2">{job.prompt}</p>
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
              <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-6">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-semibold text-gray-900">Job #{selectedJob.job_id.slice(0, 8)}</h3>
                    <p className="text-sm text-gray-500">{formatDate(selectedJob.created_at)}</p>
                  </div>
                  <StatusBadge status={selectedJob.status} />
                </div>

                {/* Error Message */}
                {selectedJob.status === 'failed' && selectedJob.error && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                    <p className="text-sm text-red-700">{selectedJob.error}</p>
                  </div>
                )}

                {/* Parent Job Info (for iterations) */}
                {selectedJob.parent_job_id && (
                  <div className="flex items-center gap-2 text-sm text-purple-600 bg-purple-50 px-3 py-2 rounded-lg">
                    <GitBranch className="w-4 h-4" />
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
                {selectedJob.status === 'done' && (
                  <div className="flex flex-wrap gap-3">
                    {selectedJob.preview_url && (
                      <a
                        href={selectedJob.preview_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white font-medium rounded-lg"
                      >
                        <ExternalLink className="w-4 h-4" />
                        Open Preview
                      </a>
                    )}
                    <button
                      onClick={() => openSourceModal(selectedJob.job_id)}
                      className="inline-flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-800 text-white font-medium rounded-lg"
                    >
                      <Code className="w-4 h-4" />
                      View Source
                    </button>
                    <button
                      onClick={() => openIterateModal(selectedJob.job_id)}
                      className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg"
                    >
                      <RefreshCw className="w-4 h-4" />
                      Iterate
                    </button>
                    {downloadData?.download_url && (
                      <a
                        href={downloadData.download_url}
                        className="inline-flex items-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium rounded-lg"
                      >
                        Download Source
                      </a>
                    )}
                    <button
                      onClick={() => deleteJob.mutate(selectedJob.job_id)}
                      disabled={deleteJob.isPending}
                      className="inline-flex items-center gap-2 px-4 py-2 bg-red-100 hover:bg-red-200 text-red-700 font-medium rounded-lg disabled:opacity-50"
                    >
                      {deleteJob.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                      Delete
                    </button>
                  </div>
                )}

                {/* Delete button for non-done jobs */}
                {selectedJob.status !== 'done' && (
                  <div className="flex gap-3">
                    <button
                      onClick={() => deleteJob.mutate(selectedJob.job_id)}
                      disabled={deleteJob.isPending}
                      className="inline-flex items-center gap-2 px-4 py-2 bg-red-100 hover:bg-red-200 text-red-700 font-medium rounded-lg disabled:opacity-50"
                    >
                      {deleteJob.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                      Delete Job
                    </button>
                  </div>
                )}

                {/* Prompt */}
                <div>
                  <h4 className="text-sm font-medium text-gray-700 mb-2">Prompt</h4>
                  <p className="text-gray-900 whitespace-pre-wrap bg-gray-50 p-3 rounded-lg text-sm">
                    {selectedJob.prompt}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs">
                    <span className="px-2 py-1 bg-gray-100 rounded">{selectedJob.project_type}</span>
                    <span className="px-2 py-1 bg-gray-100 rounded">{selectedJob.style}</span>
                    {selectedJob.include_mock_data && (
                      <span className="px-2 py-1 bg-gray-100 rounded">Mock Data</span>
                    )}
                  </div>
                </div>

                {/* Logs */}
                <div>
                  <h4 className="text-sm font-medium text-gray-700 mb-2">Build Logs</h4>
                  <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto text-xs font-mono max-h-64 overflow-y-auto">
                    {logsData?.logs || 'Waiting for logs...'}
                  </pre>
                </div>
              </div>
            ) : (
              <div className="bg-gray-50 rounded-xl border border-gray-200 p-10 text-center text-gray-500">
                Select a job to view details
              </div>
            )}
          </div>
        </div>
      )}

      {/* Iterate Modal */}
      {showIterateModal && iterateFromJobId && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl w-full max-w-2xl max-h-[90vh] overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                  <RefreshCw className="w-5 h-5 text-blue-600" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold">Iterate on Artifact</h2>
                  <p className="text-sm text-gray-500">Continue building from job #{iterateFromJobId.slice(0, 8)}</p>
                </div>
              </div>
              <button 
                onClick={() => { setShowIterateModal(false); setIteratePrompt(''); setIterateFromJobId(null) }} 
                className="p-2 hover:bg-gray-100 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  What changes do you want to make?
                </label>
                <textarea
                  value={iteratePrompt}
                  onChange={(e) => setIteratePrompt(e.target.value)}
                  placeholder="e.g., Add a dark mode toggle, Change the hero section colors to blue, Add a contact form page..."
                  className="w-full h-32 px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
                  autoFocus
                />
                <p className="mt-2 text-sm text-gray-500">
                  Kiro will modify the existing codebase based on your request, preserving what's already built.
                </p>
              </div>
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <h4 className="font-medium text-blue-800 mb-2">💡 Iteration Tips</h4>
                <ul className="text-sm text-blue-700 space-y-1">
                  <li>• Be specific about what you want to change</li>
                  <li>• Reference existing components or pages by name</li>
                  <li>• You can iterate multiple times on the same artifact</li>
                </ul>
              </div>
            </div>
            <div className="flex justify-end gap-3 p-4 border-t bg-gray-50">
              <button 
                onClick={() => { setShowIterateModal(false); setIteratePrompt(''); setIterateFromJobId(null) }} 
                className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={handleIterate}
                disabled={!iteratePrompt.trim() || iterateJob.isPending}
                className="flex items-center gap-2 px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl w-full max-w-5xl h-[85vh] flex flex-col overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center">
                  <Code className="w-5 h-5 text-gray-600" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold">Source Code</h2>
                  <p className="text-sm text-gray-500">Job #{sourceJobId.slice(0, 8)}</p>
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
            <div className="p-4 bg-gray-50 border-b shrink-0">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-700">Clone this repository</p>
                  <p className="text-xs text-gray-500 mt-1">Requires AWS CLI with CodeCommit credentials configured</p>
                </div>
                <button
                  onClick={() => copyCloneCommand(sourceJobId)}
                  className="flex items-center gap-2 px-3 py-2 bg-gray-900 hover:bg-gray-800 text-white text-sm font-mono rounded-lg"
                >
                  {copiedClone ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  git clone codecommit::us-west-2://artifact-{sourceJobId}
                </button>
              </div>
            </div>

            {/* File Browser */}
            <div className="flex-1 flex overflow-hidden">
              {/* File Tree */}
              <div className="w-64 border-r bg-gray-50 overflow-y-auto shrink-0">
                <div className="p-3 border-b bg-white sticky top-0">
                  {currentSourcePath ? (
                    <button
                      onClick={() => {
                        const parentPath = currentSourcePath.split('/').slice(0, -1).join('/')
                        loadSourceFiles(sourceJobId, parentPath)
                      }}
                      className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900"
                    >
                      <ArrowLeft className="w-4 h-4" />
                      Back
                    </button>
                  ) : (
                    <span className="text-sm font-medium text-gray-700">Files</span>
                  )}
                  {currentSourcePath && (
                    <p className="text-xs text-gray-500 mt-1 truncate">/{currentSourcePath}</p>
                  )}
                </div>
                {sourceFilesLoading ? (
                  <div className="flex items-center justify-center py-10">
                    <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
                  </div>
                ) : sourceFiles.length === 0 ? (
                  <div className="p-4 text-sm text-gray-500 text-center">
                    No files found
                  </div>
                ) : (
                  <div className="p-2 space-y-1">
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
                          'w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-sm transition-colors',
                          selectedSourceFile === file.path
                            ? 'bg-purple-100 text-purple-700'
                            : 'hover:bg-gray-100 text-gray-700'
                        )}
                      >
                        {file.type === 'folder' ? (
                          <Folder className="w-4 h-4 text-yellow-500 shrink-0" />
                        ) : (
                          <FileCode className="w-4 h-4 text-gray-400 shrink-0" />
                        )}
                        <span className="truncate">{file.path.split('/').pop()}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* File Content */}
              <div className="flex-1 flex flex-col overflow-hidden">
                {selectedSourceFile ? (
                  <>
                    <div className="p-3 border-b bg-gray-50 shrink-0">
                      <p className="text-sm font-mono text-gray-700 truncate">{selectedSourceFile}</p>
                    </div>
                    <div className="flex-1 overflow-auto">
                      {sourceFileLoading ? (
                        <div className="flex items-center justify-center h-full">
                          <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                        </div>
                      ) : (
                        <pre className="p-4 text-sm font-mono text-gray-800 whitespace-pre-wrap break-words">
                          {sourceFileContent}
                        </pre>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-gray-500">
                    <div className="text-center">
                      <FileCode className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                      <p>Select a file to view its contents</p>
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
