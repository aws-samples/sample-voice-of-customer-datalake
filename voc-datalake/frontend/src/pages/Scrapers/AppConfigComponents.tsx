/**
 * @fileoverview App review plugin card components with run status display.
 * @module pages/Scrapers/AppConfigComponents
 */

import clsx from 'clsx'
import {
  Play, Settings, Trash2, Smartphone, Loader2, CheckCircle2, AlertCircle,
} from 'lucide-react'
import {
  getAppIdentifier, getFrequencyLabel,
} from './scraper-helpers'
import type { PluginManifest } from '../../plugins/types'

type AppConfig = Record<string, string>

export interface RunStatusInfo {
  status: string
  items_found: number
  errors: string[]
}

function getPlatformLabel(pluginId: string): string {
  if (pluginId === 'app_reviews_ios') return 'iOS'
  if (pluginId === 'app_reviews_android') return 'Android'
  return 'App'
}

function getStatusColor(status: string, hasErrors: boolean): string {
  if (status === 'running') return 'bg-blue-50 border-blue-200'
  if (status === 'error') return 'bg-red-50 border-red-200'
  if (hasErrors) return 'bg-amber-50 border-amber-200'
  return 'bg-green-50 border-green-200'
}

function StatusIcon({
  status, hasErrors,
}: Readonly<{
  status: string
  hasErrors: boolean
}>) {
  if (status === 'running') {
    return <><Loader2 size={14} className="animate-spin text-blue-600" /><span className="font-medium text-blue-700">Running...</span></>
  }
  if (status === 'error') {
    return <><AlertCircle size={14} className="text-red-600" /><span className="font-medium text-red-700">Failed</span></>
  }
  if (hasErrors) {
    return <><AlertCircle size={14} className="text-amber-600" /><span className="font-medium text-amber-700">Completed with errors</span></>
  }
  return <><CheckCircle2 size={14} className="text-green-600" /><span className="font-medium text-green-700">Completed</span></>
}

function AppRunStatusBar({ status }: Readonly<{ status: RunStatusInfo }>) {
  return (
    <div className={clsx('mt-3 p-3 rounded-lg text-sm border', getStatusColor(status.status, status.errors.length > 0))}>
      <div className="flex items-center gap-2 mb-1">
        <StatusIcon status={status.status} hasErrors={status.errors.length > 0} />
      </div>
      <div className="text-xs text-gray-600">
        Reviews found: <span className="font-semibold">{status.items_found}</span>
      </div>
      {status.errors.length > 0 ? <div className="mt-1 text-xs text-red-600 truncate">{status.errors[0]}</div> : null}
    </div>
  )
}

export function AppConfigCard({
  app, plugin, onEdit, onDelete, onRun, isRunning, runStatus,
}: Readonly<{
  app: AppConfig
  plugin: PluginManifest
  onEdit: () => void
  onDelete: () => void
  onRun: () => void
  isRunning: boolean
  runStatus?: RunStatusInfo
}>) {
  const frequencyMinutes = Number.parseInt(app.frequency_minutes === '' ? '1440' : app.frequency_minutes, 10)
  const frequencyLabel = getFrequencyLabel(frequencyMinutes)

  return (
    <div className="card border-2 border-purple-200 bg-purple-50/30 transition-all">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-purple-100 text-purple-600 flex items-center justify-center"><Smartphone size={20} /></div>
          <div>
            <h3 className="font-semibold">{app.app_name === '' ? 'Unnamed App' : app.app_name}</h3>
            <p className="text-sm text-gray-500">{getAppIdentifier(app, plugin.id)}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onRun} disabled={isRunning} className={clsx('p-2 rounded transition-colors', isRunning ? 'bg-blue-100 text-blue-600' : 'hover:bg-green-100 text-green-600')} title="Run now">
            {isRunning ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
          </button>
          <button onClick={onEdit} className="p-2 hover:bg-gray-100 rounded" title="Edit"><Settings size={16} className="text-gray-500" /></button>
          <button onClick={onDelete} className="p-2 hover:bg-gray-100 rounded text-red-500" title="Delete"><Trash2 size={16} /></button>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-4 text-sm">
        <div><span className="text-gray-500">Frequency</span><p className="font-medium">{frequencyLabel}</p></div>
        <div><span className="text-gray-500">Platform</span><p className="font-medium">{getPlatformLabel(plugin.id)}</p></div>
        <div><span className="text-gray-500">Max Reviews</span><p className="font-medium">{app.max_reviews_per_run === '' ? '500' : app.max_reviews_per_run}</p></div>
      </div>
      {runStatus == null ? null : <AppRunStatusBar status={runStatus} />}
    </div>
  )
}
