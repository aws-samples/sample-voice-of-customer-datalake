/**
 * FormCard Component - displays a single feedback form with embed options and stats
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Trash2, Copy, Check, Code, ExternalLink, ToggleLeft, ToggleRight, Edit2, MessageSquare, Star, BarChart3 } from 'lucide-react'
import type { FeedbackForm } from '../../api/client'
import { api } from '../../api/client'
import clsx from 'clsx'
import SubmissionsModal from './SubmissionsModal'

interface FormCardProps {
  readonly form: FeedbackForm
  readonly onEdit: (form: FeedbackForm) => void
  readonly onDelete: (formId: string) => void
  readonly onToggle: (formId: string, enabled: boolean) => void
  readonly apiEndpoint: string
}

function getRatingTypeLabel(ratingType: string): string {
  if (ratingType === 'stars') return '⭐ Stars'
  if (ratingType === 'emoji') return '😀 Emoji'
  return '🔢 Numeric'
}

function getCollectsLabel(collectName: boolean, collectEmail: boolean): string {
  const parts = [collectName && 'Name', collectEmail && 'Email'].filter(Boolean)
  return parts.length > 0 ? parts.join(', ') : 'Rating & Text'
}

interface FormStatsProps {
  readonly stats: { total_submissions: number; avg_rating: number | null } | undefined
  readonly onViewSubmissions: () => void
}

function FormStats({ stats, onViewSubmissions }: FormStatsProps) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4 p-3 bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg border border-blue-100">
      <div className="flex items-center gap-2">
        <div className="p-1.5 bg-blue-100 rounded">
          <MessageSquare size={14} className="text-blue-600" />
        </div>
        <div>
          <p className="text-lg font-bold text-gray-900">{stats?.total_submissions ?? '—'}</p>
          <p className="text-xs text-gray-500">Submissions</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="p-1.5 bg-yellow-100 rounded">
          <Star size={14} className="text-yellow-600" />
        </div>
        <div>
          <p className="text-lg font-bold text-gray-900">
            {stats?.avg_rating !== null && stats?.avg_rating !== undefined 
              ? stats.avg_rating.toFixed(1) 
              : '—'}
          </p>
          <p className="text-xs text-gray-500">Avg Rating</p>
        </div>
      </div>
      <div className="col-span-2 sm:col-span-2 flex items-center justify-end">
        <button
          onClick={onViewSubmissions}
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-blue-600 hover:bg-blue-100 rounded-lg transition-colors"
          disabled={!stats || stats.total_submissions === 0}
        >
          <BarChart3 size={16} />
          View Submissions
        </button>
      </div>
    </div>
  )
}

interface EmbedCodeSectionProps {
  readonly iframeUrl: string
  readonly iframeEmbed: string
  readonly copied: string | null
  readonly onCopy: (text: string, id: string) => void
}

function EmbedCodeSection({ iframeUrl, iframeEmbed, copied, onCopy }: EmbedCodeSectionProps) {
  return (
    <div className="mt-3 space-y-3">
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-gray-500">Direct Link</span>
          <div className="flex gap-2">
            <a href={iframeUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1">
              Preview <ExternalLink size={12} />
            </a>
            <button onClick={() => onCopy(iframeUrl, 'url')} className="text-xs text-gray-600 hover:text-gray-800 flex items-center gap-1">
              {copied === 'url' ? <Check size={12} className="text-green-600" /> : <Copy size={12} />}
              Copy
            </button>
          </div>
        </div>
        <code className="block bg-gray-100 p-2 rounded text-xs break-all">{iframeUrl}</code>
      </div>
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-gray-500">iFrame Embed</span>
          <button onClick={() => onCopy(iframeEmbed, 'iframe')} className="text-xs text-gray-600 hover:text-gray-800 flex items-center gap-1">
            {copied === 'iframe' ? <Check size={12} className="text-green-600" /> : <Copy size={12} />}
            Copy
          </button>
        </div>
        <pre className="bg-gray-900 text-gray-100 p-2 rounded text-xs overflow-x-auto">
          <code>{iframeEmbed}</code>
        </pre>
      </div>
    </div>
  )
}

export default function FormCard({ form, onEdit, onDelete, onToggle, apiEndpoint }: FormCardProps) {
  const [copied, setCopied] = useState<string | null>(null)
  const [showEmbed, setShowEmbed] = useState(false)
  const [showSubmissions, setShowSubmissions] = useState(false)

  const { data: statsData } = useQuery({
    queryKey: ['form-stats', form.form_id],
    queryFn: () => api.getFeedbackFormStats(form.form_id),
    staleTime: 30000,
  })

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(null), 2000)
  }

  const iframeUrl = `${apiEndpoint}/feedback-forms/${form.form_id}/iframe`
  const iframeEmbed = `<iframe 
  src="${iframeUrl}"
  style="width: 100%; min-height: 400px; border: none;"
  title="${form.name}"
></iframe>`

  return (
    <>
      <div className="card">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-4">
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <h3 className="font-semibold text-base sm:text-lg">{form.name}</h3>
              <span className={clsx(
                'px-2 py-0.5 rounded text-xs font-medium',
                form.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
              )}>
                {form.enabled ? 'Active' : 'Disabled'}
              </span>
            </div>
            <p className="text-sm text-gray-500 mt-1 line-clamp-2">{form.title}</p>
            {form.category && (
              <p className="text-xs text-blue-600 mt-2">
                Category: <span className="font-medium">{form.category}</span>
                {form.subcategory && <span> → {form.subcategory}</span>}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
            <button onClick={() => onToggle(form.form_id, !form.enabled)} className="p-2 hover:bg-gray-100 rounded-lg transition-colors" title={form.enabled ? 'Disable form' : 'Enable form'}>
              {form.enabled ? <ToggleRight size={20} className="text-green-600" /> : <ToggleLeft size={20} className="text-gray-400" />}
            </button>
            <button onClick={() => onEdit(form)} className="p-2 hover:bg-gray-100 rounded-lg transition-colors" title="Edit form">
              <Edit2 size={18} className="text-gray-600" />
            </button>
            <button onClick={() => onDelete(form.form_id)} className="p-2 hover:bg-red-50 rounded-lg transition-colors" title="Delete form">
              <Trash2 size={18} className="text-red-500" />
            </button>
          </div>
        </div>

        <FormStats stats={statsData?.stats} onViewSubmissions={() => setShowSubmissions(true)} />

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 mb-4 p-3 bg-gray-50 rounded-lg">
          <div>
            <p className="text-xs text-gray-500">Rating Type</p>
            <p className="font-medium text-sm">{getRatingTypeLabel(form.rating_type)}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Collects</p>
            <p className="font-medium text-sm">{getCollectsLabel(form.collect_name, form.collect_email)}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Theme</p>
            <div className="flex items-center gap-1">
              <div className="w-4 h-4 rounded flex-shrink-0" style={{ backgroundColor: form.theme.primary_color }} />
              <span className="text-sm font-mono truncate">{form.theme.primary_color}</span>
            </div>
          </div>
        </div>

        <div className="border-t pt-4">
          <button onClick={() => setShowEmbed(!showEmbed)} className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700">
            <Code size={16} />
            {showEmbed ? 'Hide Embed Code' : 'Show Embed Code'}
          </button>
          
          {showEmbed && (
            <EmbedCodeSection
              iframeUrl={iframeUrl}
              iframeEmbed={iframeEmbed}
              copied={copied}
              onCopy={copyToClipboard}
            />
          )}
        </div>
      </div>

      {showSubmissions && (
        <SubmissionsModal
          formId={form.form_id}
          formName={form.name}
          onClose={() => setShowSubmissions(false)}
        />
      )}
    </>
  )
}
