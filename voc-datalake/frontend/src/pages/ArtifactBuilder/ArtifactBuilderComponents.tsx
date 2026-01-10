/**
 * @fileoverview Sub-components for ArtifactBuilder.
 * @module pages/ArtifactBuilder/ArtifactBuilderComponents
 */

import {
  Sparkles,
  Loader2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Settings,
  Trash2,
  RefreshCw,
  GitBranch,
  Code,
  Eye,
  FileText,
  Terminal,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { STATUS_CONFIG, formatDate } from './artifactBuilderHelpers'

// StatusBadge Component
interface StatusBadgeProps {
  readonly status: string
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.queued
  const Icon = config.icon
  return (
    <span className={clsx('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-sm font-medium', config.bg, config.color)}>
      <Icon className={clsx('w-4 h-4', config.animate && 'animate-spin')} />
      {config.label}
    </span>
  )
}

// CodeViewer Component
interface CodeViewerProps {
  readonly content: string
}

export function CodeViewer({ content }: CodeViewerProps) {
  const lines = content.split('\n')
  
  return (
    <div className="bg-gray-900 rounded-lg overflow-hidden">
      <div className="flex text-sm font-mono">
        <div className="select-none bg-gray-800 text-gray-500 text-right py-4 px-3 border-r border-gray-700">
          {lines.map((_, i) => (
            <div key={i} className="leading-6">{i + 1}</div>
          ))}
        </div>
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

// NotConfigured Component
export function NotConfiguredView() {
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

// EmptyJobsList Component
interface EmptyJobsListProps {
  readonly onBuildClick: () => void
}

export function EmptyJobsList({ onBuildClick }: EmptyJobsListProps) {
  return (
    <div className="text-center py-10 text-gray-500">
      <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
        <Sparkles className="w-8 h-8 text-gray-300" />
      </div>
      <p className="mb-2">No artifacts yet</p>
      <button
        onClick={onBuildClick}
        className="text-purple-600 hover:underline font-medium"
      >
        Build your first artifact
      </button>
    </div>
  )
}

// JobCard Component
interface JobCardJob {
  readonly job_id: string
  readonly status: string
  readonly prompt: string
  readonly created_at: string
  readonly parent_job_id?: string
  readonly iterations?: ReadonlyArray<{
    job_id: string
    status: string
    prompt: string
    created_at: string
  }>
}

interface JobCardProps {
  readonly job: JobCardJob
  readonly isSelected: boolean
  readonly isExpanded: boolean
  readonly selectedJobId: string | null
  readonly onSelect: (jobId: string) => void
  readonly onToggleExpand: (jobId: string) => void
}

export function JobCard({ job, isSelected, isExpanded, selectedJobId, onSelect, onToggleExpand }: JobCardProps) {
  const hasIterations = job.iterations && job.iterations.length > 0
  
  return (
    <div>
      <div className="flex items-start gap-2">
        {hasIterations ? (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleExpand(job.job_id) }}
            className="mt-4 p-1 hover:bg-gray-100 rounded"
          >
            {isExpanded ? (
              <ChevronDown className="w-4 h-4 text-gray-500" />
            ) : (
              <ChevronRight className="w-4 h-4 text-gray-500" />
            )}
          </button>
        ) : (
          <div className="w-6" />
        )}
        <button
          onClick={() => onSelect(job.job_id)}
          className={clsx(
            'flex-1 min-w-0 text-left p-4 rounded-xl border transition-all',
            isSelected
              ? 'border-purple-300 bg-purple-50'
              : 'border-gray-200 bg-white hover:border-purple-200'
          )}
        >
          <div className="flex flex-wrap items-center gap-1.5 mb-2">
            <span className="font-mono text-xs text-gray-500">#{job.job_id.slice(0, 8)}</span>
            <StatusBadge status={job.status} />
            {hasIterations && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-purple-100 text-purple-600 rounded text-xs whitespace-nowrap">
                <GitBranch className="w-3 h-3" />
                {job.iterations?.length}
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

      {hasIterations && isExpanded && (
        <div className="ml-8 mt-2 space-y-2 border-l-2 border-purple-200 pl-4">
          {job.iterations?.map((iteration) => (
            <button
              key={iteration.job_id}
              onClick={() => onSelect(iteration.job_id)}
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
  )
}

// DetailTabs Component
interface DetailTabsProps {
  readonly activeTab: 'preview' | 'prompt' | 'logs'
  readonly onTabChange: (tab: 'preview' | 'prompt' | 'logs') => void
}

export function DetailTabs({ activeTab, onTabChange }: DetailTabsProps) {
  return (
    <div className="flex border-b shrink-0">
      <button
        onClick={() => onTabChange('preview')}
        className={clsx(
          'flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors',
          activeTab === 'preview'
            ? 'border-purple-600 text-purple-600'
            : 'border-transparent text-gray-500 hover:text-gray-700'
        )}
      >
        <Eye className="w-4 h-4" />
        Preview
      </button>
      <button
        onClick={() => onTabChange('prompt')}
        className={clsx(
          'flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors',
          activeTab === 'prompt'
            ? 'border-purple-600 text-purple-600'
            : 'border-transparent text-gray-500 hover:text-gray-700'
        )}
      >
        <FileText className="w-4 h-4" />
        Prompt
      </button>
      <button
        onClick={() => onTabChange('logs')}
        className={clsx(
          'flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors',
          activeTab === 'logs'
            ? 'border-purple-600 text-purple-600'
            : 'border-transparent text-gray-500 hover:text-gray-700'
        )}
      >
        <Terminal className="w-4 h-4" />
        Logs
      </button>
    </div>
  )
}

// JobActions Component
interface JobActionsJob {
  readonly job_id: string
  readonly status: string
  readonly preview_url?: string
}

interface JobActionsProps {
  readonly job: JobActionsJob
  readonly isDeleting: boolean
  readonly onOpenSource: (jobId: string) => void
  readonly onOpenIterate: (jobId: string) => void
  readonly onDelete: (jobId: string) => void
}

export function JobActions({ job, isDeleting, onOpenSource, onOpenIterate, onDelete }: JobActionsProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {job.status === 'done' && job.preview_url && (
        <a
          href={job.preview_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 bg-purple-600 hover:bg-purple-700 text-white text-xs sm:text-sm font-medium rounded-lg"
        >
          <ExternalLink className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
          <span className="hidden xs:inline">Open in New Tab</span>
          <span className="xs:hidden">Open</span>
        </a>
      )}
      {job.status === 'done' && (
        <>
          <button
            onClick={() => onOpenSource(job.job_id)}
            className="inline-flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 bg-gray-700 hover:bg-gray-800 text-white text-xs sm:text-sm font-medium rounded-lg"
          >
            <Code className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
            <span className="hidden sm:inline">View Source</span>
            <span className="sm:hidden">Source</span>
          </button>
          <button
            onClick={() => onOpenIterate(job.job_id)}
            className="inline-flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs sm:text-sm font-medium rounded-lg"
          >
            <RefreshCw className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
            Iterate
          </button>
        </>
      )}
      <button
        onClick={() => onDelete(job.job_id)}
        disabled={isDeleting}
        className="inline-flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 bg-red-100 hover:bg-red-200 text-red-700 text-xs sm:text-sm font-medium rounded-lg disabled:opacity-50"
      >
        {isDeleting ? <Loader2 className="w-3 h-3 sm:w-3.5 sm:h-3.5 animate-spin" /> : <Trash2 className="w-3 h-3 sm:w-3.5 sm:h-3.5" />}
        Delete
      </button>
    </div>
  )
}

// NoJobSelected Component
export function NoJobSelected() {
  return (
    <div className="bg-gray-50 rounded-xl border border-gray-200 p-6 sm:p-10 text-center text-gray-500 h-[40vh] sm:h-[50vh] lg:h-[calc(100vh-180px)]">
      <div className="flex flex-col items-center justify-center h-full">
        <Sparkles className="w-10 h-10 sm:w-12 sm:h-12 text-gray-300 mb-3" />
        <p className="text-sm sm:text-base">Select an artifact to view details</p>
      </div>
    </div>
  )
}
