import { useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { 
  ArrowLeft, ExternalLink, Download, Clock, CheckCircle, 
  XCircle, Loader2, FileCode, Terminal 
} from 'lucide-react'
import { api } from '../api'

const STATUS_CONFIG = {
  queued: { icon: Clock, color: 'text-gray-500', bg: 'bg-gray-100', label: 'Queued' },
  generating: { icon: Loader2, color: 'text-blue-500', bg: 'bg-blue-100', label: 'Generating Code', animate: true },
  building: { icon: Loader2, color: 'text-yellow-500', bg: 'bg-yellow-100', label: 'Building Project', animate: true },
  publishing: { icon: Loader2, color: 'text-purple-500', bg: 'bg-purple-100', label: 'Publishing', animate: true },
  done: { icon: CheckCircle, color: 'text-green-500', bg: 'bg-green-100', label: 'Complete' },
  failed: { icon: XCircle, color: 'text-red-500', bg: 'bg-red-100', label: 'Failed' },
}

const TIMELINE_STEPS = ['queued', 'generating', 'building', 'publishing', 'done']

function StatusTimeline({ timeline, currentStatus }) {
  const timelineMap = {}
  timeline?.forEach(t => {
    timelineMap[t.status] = t.timestamp
  })
  
  const currentIndex = TIMELINE_STEPS.indexOf(currentStatus)
  const isFailed = currentStatus === 'failed'
  
  return (
    <div className="flex items-center gap-2">
      {TIMELINE_STEPS.map((step, index) => {
        const isComplete = index < currentIndex || currentStatus === 'done'
        const isCurrent = index === currentIndex && !isFailed
        const config = STATUS_CONFIG[step]
        
        return (
          <div key={step} className="flex items-center">
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm ${
              isComplete ? 'bg-green-100 text-green-700' :
              isCurrent ? `${config.bg} ${config.color}` :
              'bg-gray-100 text-gray-400'
            }`}>
              {isComplete ? (
                <CheckCircle className="w-4 h-4" />
              ) : isCurrent ? (
                <config.icon className={`w-4 h-4 ${config.animate ? 'animate-spin' : ''}`} />
              ) : (
                <Clock className="w-4 h-4" />
              )}
              <span className="hidden sm:inline">{config.label}</span>
            </div>
            {index < TIMELINE_STEPS.length - 1 && (
              <div className={`w-8 h-0.5 mx-1 ${isComplete ? 'bg-green-300' : 'bg-gray-200'}`} />
            )}
          </div>
        )
      })}
    </div>
  )
}

function formatDate(dateString) {
  if (!dateString) return ''
  const date = new Date(dateString)
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export default function JobDetailPage() {
  const { jobId } = useParams()
  
  // Fetch job details
  const { data: job, isLoading, error } = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.getJob(jobId),
    refetchInterval: (data) => {
      // Stop polling when job is complete or failed
      if (data?.status === 'done' || data?.status === 'failed') return false
      return 3000 // Poll every 3 seconds while in progress
    },
  })
  
  // Fetch logs
  const { data: logsData } = useQuery({
    queryKey: ['job-logs', jobId],
    queryFn: () => api.getJobLogs(jobId),
    refetchInterval: (data) => {
      if (job?.status === 'done' || job?.status === 'failed') return false
      return 5000
    },
    enabled: !!job,
  })
  
  // Fetch download URL when complete
  const { data: downloadData } = useQuery({
    queryKey: ['job-download', jobId],
    queryFn: () => api.getDownloadUrl(jobId),
    enabled: job?.status === 'done',
  })
  
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-primary-500" />
      </div>
    )
  }
  
  if (error || !job) {
    return (
      <div className="text-center py-20">
        <p className="text-red-600 mb-4">Failed to load job: {error?.message || 'Not found'}</p>
        <Link to="/jobs" className="text-primary-600 hover:underline">
          Back to History
        </Link>
      </div>
    )
  }
  
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link
          to="/jobs"
          className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            Job #{job.job_id}
          </h1>
          <p className="text-gray-500 text-sm">
            Created {formatDate(job.created_at)}
          </p>
        </div>
      </div>
      
      {/* Status Timeline */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 overflow-x-auto">
        <StatusTimeline timeline={job.timeline} currentStatus={job.status} />
      </div>
      
      {/* Error Message */}
      {job.status === 'failed' && job.error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <h3 className="font-medium text-red-800 mb-1">Build Failed</h3>
          <p className="text-red-700 text-sm">{job.error}</p>
        </div>
      )}
      
      {/* Actions */}
      {job.status === 'done' && (
        <div className="flex flex-wrap gap-3">
          {job.preview_url && (
            <a
              href={job.preview_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white font-medium rounded-xl"
            >
              <ExternalLink className="w-5 h-5" />
              Open Preview
            </a>
          )}
          {downloadData?.download_url && (
            <a
              href={downloadData.download_url}
              className="inline-flex items-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium rounded-xl"
            >
              <Download className="w-5 h-5" />
              Download Source
            </a>
          )}
        </div>
      )}
      
      {/* Details Grid */}
      <div className="grid md:grid-cols-2 gap-6">
        {/* Prompt */}
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <h3 className="font-medium text-gray-900 mb-3 flex items-center gap-2">
            <FileCode className="w-5 h-5 text-gray-400" />
            Prompt
          </h3>
          <p className="text-gray-700 whitespace-pre-wrap">{job.prompt}</p>
          <div className="mt-4 flex flex-wrap gap-2 text-sm">
            <span className="px-2 py-1 bg-gray-100 rounded">{job.project_type}</span>
            <span className="px-2 py-1 bg-gray-100 rounded">{job.style}</span>
            {job.include_mock_data && (
              <span className="px-2 py-1 bg-gray-100 rounded">Mock Data</span>
            )}
          </div>
        </div>
        
        {/* Summary */}
        {job.summary && (
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <h3 className="font-medium text-gray-900 mb-3">Summary</h3>
            {job.summary.files_changed && (
              <div className="mb-3">
                <p className="text-sm text-gray-500 mb-1">Files Changed</p>
                <div className="flex flex-wrap gap-1">
                  {job.summary.files_changed.map(file => (
                    <span key={file} className="px-2 py-0.5 bg-gray-100 rounded text-xs font-mono">
                      {file}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      
      {/* Logs */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <h3 className="font-medium text-gray-900 mb-3 flex items-center gap-2">
          <Terminal className="w-5 h-5 text-gray-400" />
          Build Logs
        </h3>
        <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto text-sm font-mono max-h-96 overflow-y-auto">
          {logsData?.logs || 'Waiting for logs...'}
        </pre>
      </div>
    </div>
  )
}
