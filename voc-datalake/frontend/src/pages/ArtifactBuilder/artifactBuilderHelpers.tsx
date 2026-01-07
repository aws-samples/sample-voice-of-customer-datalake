/**
 * @fileoverview Helper functions and constants for ArtifactBuilder.
 * @module pages/ArtifactBuilder/artifactBuilderHelpers
 */

import {
  Clock,
  Loader2,
  CheckCircle,
  XCircle,
  FileCode,
  FileText,
  File,
  Image,
  Package,
} from 'lucide-react'
import type { ArtifactJob } from '../../api/client'
import type { ReactElement } from 'react'

export const STATUS_CONFIG: Record<string, { icon: typeof Clock; color: string; bg: string; label: string; animate?: boolean }> = {
  queued: { icon: Clock, color: 'text-gray-500', bg: 'bg-gray-100', label: 'Queued' },
  cloning: { icon: Loader2, color: 'text-blue-500', bg: 'bg-blue-100', label: 'Cloning', animate: true },
  generating: { icon: Loader2, color: 'text-blue-500', bg: 'bg-blue-100', label: 'Generating', animate: true },
  building: { icon: Loader2, color: 'text-yellow-500', bg: 'bg-yellow-100', label: 'Building', animate: true },
  publishing: { icon: Loader2, color: 'text-purple-500', bg: 'bg-purple-100', label: 'Publishing', animate: true },
  done: { icon: CheckCircle, color: 'text-green-500', bg: 'bg-green-100', label: 'Complete' },
  failed: { icon: XCircle, color: 'text-red-500', bg: 'bg-red-100', label: 'Failed' },
}

const fileIconMap: Record<string, ReactElement> = {
  png: <Image className="w-4 h-4 text-purple-500" />,
  jpg: <Image className="w-4 h-4 text-purple-500" />,
  jpeg: <Image className="w-4 h-4 text-purple-500" />,
  gif: <Image className="w-4 h-4 text-purple-500" />,
  svg: <Image className="w-4 h-4 text-purple-500" />,
  ico: <Image className="w-4 h-4 text-purple-500" />,
  js: <FileCode className="w-4 h-4 text-yellow-500" />,
  jsx: <FileCode className="w-4 h-4 text-yellow-500" />,
  ts: <FileCode className="w-4 h-4 text-yellow-500" />,
  tsx: <FileCode className="w-4 h-4 text-yellow-500" />,
  json: <FileCode className="w-4 h-4 text-green-500" />,
  yaml: <FileCode className="w-4 h-4 text-green-500" />,
  yml: <FileCode className="w-4 h-4 text-green-500" />,
  md: <FileText className="w-4 h-4 text-blue-500" />,
  css: <FileCode className="w-4 h-4 text-pink-500" />,
  scss: <FileCode className="w-4 h-4 text-pink-500" />,
  html: <FileCode className="w-4 h-4 text-orange-500" />,
}

const defaultFileIcon = <File className="w-4 h-4 text-gray-400" />
const packageJsonIcon = <Package className="w-4 h-4 text-red-500" />

export function getFileIcon(filename: string): ReactElement {
  if (filename === 'package.json') return packageJsonIcon
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return fileIconMap[ext] ?? defaultFileIcon
}

export function formatDate(dateString: string): string {
  const date = new Date(dateString)
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export interface GroupedJob extends ArtifactJob {
  iterations?: ArtifactJob[]
}

function findRootParentId(job: ArtifactJob, jobMap: Map<string, ArtifactJob>): string {
  if (!job.parent_job_id) return job.job_id
  const parent = jobMap.get(job.parent_job_id)
  if (!parent) return job.job_id
  return findRootParentId(parent, jobMap)
}

function sortByDateDesc(a: ArtifactJob, b: ArtifactJob): number {
  return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
}

function sortByDateAsc(a: ArtifactJob, b: ArtifactJob): number {
  return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
}

export function groupJobs(jobs: ArtifactJob[]): GroupedJob[] {
  const jobMap = new Map<string, ArtifactJob>()
  jobs.forEach((job) => jobMap.set(job.job_id, job))
  
  const rootJobs: GroupedJob[] = []
  const iterationsByRoot = new Map<string, ArtifactJob[]>()
  
  jobs.forEach((job) => {
    if (!job.parent_job_id) {
      rootJobs.push({ ...job, iterations: [] })
    } else {
      const rootId = findRootParentId(job, jobMap)
      const iterations = iterationsByRoot.get(rootId) ?? []
      iterations.push(job)
      iterationsByRoot.set(rootId, iterations)
    }
  })
  
  rootJobs.forEach(root => {
    const iterations = iterationsByRoot.get(root.job_id) ?? []
    root.iterations = [...iterations].sort(sortByDateDesc)
  })
  
  iterationsByRoot.forEach((iterations, rootId) => {
    if (!rootJobs.some(r => r.job_id === rootId)) {
      const sorted = [...iterations].sort(sortByDateAsc)
      const newRoot = sorted[0]
      if (newRoot) {
        rootJobs.push({ 
          ...newRoot, 
          iterations: sorted.slice(1).sort(sortByDateDesc)
        })
      }
    }
  })
  
  return [...rootJobs].sort(sortByDateDesc)
}
