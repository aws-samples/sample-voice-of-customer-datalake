/**
 * @fileoverview What a run's start said beside the run (7.63.00; `POST /agents/engineering/runs`' `warnings`): today a
 * fine-grained token's expiry within 3 days, which the run's push would be refused after. The Start dialog hands the
 * warnings to the workspace it opens (startRunRules.ts `startedState`); they are shown once at the top, in the server's
 * words, until dismissed. The run started all the same.
 *
 * @module pages/Agents/RunWorkspace/StartWarnings
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'

export function StartWarnings({ warnings }: Readonly<{ warnings: readonly string[] }>) {
  const { t } = useTranslation('agents')
  const [dismissed, setDismissed] = useState(false)
  if (dismissed || warnings.length === 0) return null
  return (
    <div role="status" className="flex items-start gap-3 rounded-lg border border-warn/30 bg-warn-subtle p-3 text-sm text-text">
      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium text-text-strong">{t('runWorkspace.startWarnings.title')}</p>
        <ul className="space-y-1">
          {warnings.map((warning) => <li key={warning} className="break-words">{warning}</li>)}
        </ul>
      </div>
      <button type="button" className="btn btn-secondary btn-sm shrink-0" onClick={() => { setDismissed(true) }}>
        {t('runWorkspace.startWarnings.dismiss')}
      </button>
    </div>
  )
}
