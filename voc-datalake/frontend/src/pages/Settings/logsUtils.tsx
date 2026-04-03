/**
 * @fileoverview Shared utilities and components for log panels.
 * @module pages/Settings/logsUtils
 */

import { Loader2 } from 'lucide-react'
import type { CheckCircle } from 'lucide-react'

export function LogsLoadingState() {
  return (
    <div className="card flex items-center justify-center py-8">
      <Loader2 size={24} className="animate-spin text-gray-400" />
    </div>
  )
}

export function LogsEmptyState({
  message, icon: emptyIcon,
}: {
  readonly message: string;
  readonly icon: typeof CheckCircle
}) {
  const EmptyIcon = emptyIcon
  return (
    <div className="card flex flex-col items-center justify-center py-8 text-gray-500">
      <EmptyIcon size={32} className="mb-2 text-green-500" />
      <p>{message}</p>
    </div>
  )
}
