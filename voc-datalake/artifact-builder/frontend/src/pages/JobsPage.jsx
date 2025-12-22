import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Clock, CheckCircle, XCircle, Loader2, ExternalLink } from 'lucide-react'
import { api } from '../api'

const STATUS_CONFIG = {
  queued: { icon: Clock, color: 'text-gray-500', bg: 'bg-gray-100', label: 'Queued' },
  generating: { icon: Loader2, color: 'text-blue-500', bg: 'bg-blue-100', label: 'Generating', animate: true },
  building: { icon: Loader2, color: 'text-yellow-500', bg: 'bg-yellow-100', label: 'Building', animate: true },
  publishing: { icon: Loader2, color: 'text-purple-500', bg: 'bg-purple-100', label: 'Publishing', animate: true },
  done: { icon: CheckCircle, color: 'text-green-500', bg: 'bg-green-100', label: 'Complete' },
  failed: { icon: XCircle, color: 'text-red-500', bg: 'bg-red-100', label: 'Failed' },
}

function StatusBadge({ status }) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.queued
  const Icon = config.icon
  
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-sm font-medium ${config.bg} ${config.color}`}>
      <Icon className={`w-4 h-4 ${config.animate ? 'animate-spin' : ''}`} />
      {config.label}
    </span>
  )
}

function formatDate(dateString) {
  const date = new Date(dateString)
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function JobsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.listJobs(),
    refetchInterval: 5000, // Poll every 5 seconds
  })
  
  const jobs = data?.jobs || []
  
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-primary-500" />
      </div>
    )
  }
  
  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-red-600">Failed to load jobs: {error.message}</p>
      </div>
    )
  }
  
  if (jobs.length === 0) {
    return (
      <div className="text-center py-20">
        <h2 className="text-xl font-semibold text-gray-900 mb-2">No artifacts yet</h2>
        <p className="text-gray-600 mb-6">Create your first artifact to get started</p>
        <Link
          to="/"
          className="inline-flex items-center gap-2 px-6 py-3 bg-primary-600 hover:bg-primary-700 text-white font-medium rounded-xl"
        >
          Build an Artifact
        </Link>
      </div>
    )
  }
  
  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Build History</h1>
      
      <div className="space-y-4">
        {jobs.map(job => (
          <Link
            key={job.job_id}
            to={`/jobs/${job.job_id}`}
            className="block bg-white rounded-xl border border-gray-200 p-4 hover:border-primary-300 hover:shadow-md transition-all"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-2">
                  <span className="font-mono text-sm text-gray-500">#{job.job_id}</span>
                  <StatusBadge status={job.status} />
                </div>
                <p className="text-gray-900 line-clamp-2 mb-2">
                  {job.prompt}
                </p>
                <div className="flex items-center gap-4 text-sm text-gray-500">
                  <span>{job.project_type}</span>
                  <span>•</span>
                  <span>{job.style}</span>
                  <span>•</span>
                  <span>{formatDate(job.created_at)}</span>
                </div>
              </div>
              
              {job.status === 'done' && job.preview_url && (
                <a
                  href={job.preview_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="flex items-center gap-1 px-3 py-1.5 bg-primary-50 text-primary-700 rounded-lg hover:bg-primary-100 text-sm font-medium"
                >
                  <ExternalLink className="w-4 h-4" />
                  Preview
                </a>
              )}
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
