/**
 * @fileoverview The warning notice and the loading line the admin Settings cards share
 * (Logs → Alerts, Sources → Email inbox).
 * @module pages/Settings/SettingsNotice
 */
import { AlertCircle, Loader2 } from 'lucide-react'

export function SettingsNotice({ text }: { readonly text: string }) {
  return (
    <div role="alert" className="flex items-start gap-2 text-sm text-warn bg-warn-subtle border border-warn/30 p-3 rounded-lg">
      <AlertCircle size={16} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
      <span>{text}</span>
    </div>
  )
}

export function SettingsLoading({ text }: { readonly text: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted">
      <Loader2 size={14} className="animate-spin" aria-hidden="true" />
      {text}
    </p>
  )
}
