/**
 * Artifact Builder - Generate web prototypes from prompts using Kiro CLI
 */

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Sparkles,
  Loader2,
  ChevronDown,
  Plus,
  X,
  Clock,
  CheckCircle,
  XCircle,
  ExternalLink,
  History,
  Settings,
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
              jobs.map((job: ArtifactJob) => (
                <button
                  key={job.job_id}
                  onClick={() => setSelectedJobId(job.job_id)}
                  className={clsx(
                    'w-full text-left p-4 rounded-xl border transition-all',
                    selectedJobId === job.job_id
                      ? 'border-purple-300 bg-purple-50'
                      : 'border-gray-200 bg-white hover:border-purple-200'
                  )}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="font-mono text-xs text-gray-500">#{job.job_id.slice(0, 8)}</span>
                    <StatusBadge status={job.status} />
                  </div>
                  <p className="text-sm text-gray-900 line-clamp-2">{job.prompt}</p>
                  <p className="text-xs text-gray-500 mt-2">{formatDate(job.created_at)}</p>
                </button>
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
                    {downloadData?.download_url && (
                      <a
                        href={downloadData.download_url}
                        className="inline-flex items-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium rounded-lg"
                      >
                        Download Source
                      </a>
                    )}
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
    </div>
  )
}
