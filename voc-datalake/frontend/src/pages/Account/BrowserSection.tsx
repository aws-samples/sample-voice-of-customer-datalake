/**
 * @fileoverview Account → "This browser": what this browser keeps in its local
 * storage (`voc-config`: the API endpoint and a cached copy of the brand), and
 * "Reset local settings", which clears it. Moved from Administration → General's
 * Danger zone in 5.09: it changes nothing on the server, so it is personal, and
 * a non-admin could not reach it on `/admin`. The "Go to settings" buttons shown
 * when no API endpoint is set (Dashboard, Feedback Forms, Scrapers) land here.
 *
 * @module pages/Account/BrowserSection
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Monitor } from 'lucide-react'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { useConfigStore } from '../../store/configStore'

/** What "Reset local settings" writes: the browser's config with nothing in it. */
const CLEARED_CONFIG = { apiEndpoint: '', brandName: '', brandHandles: [], hashtags: [], urlsToTrack: [] }

function ResetLocalSettings() {
  const { t } = useTranslation('settings')
  const setConfig = useConfigStore((s) => s.setConfig)
  const [confirming, setConfirming] = useState(false)
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
      <div>
        <p className="font-medium text-sm text-text-strong">{t('dangerZone.resetTitle')}</p>
        <p className="text-sm text-muted">{t('dangerZone.resetDescription')}</p>
      </div>
      <button type="button" onClick={() => { setConfirming(true) }} className="btn btn-danger w-full sm:w-auto">
        {t('dangerZone.resetButton')}
      </button>
      <ConfirmModal
        isOpen={confirming}
        title={t('dangerZone.resetTitle')}
        message={t('dangerZone.resetConfirmMessage')}
        confirmLabel={t('dangerZone.resetConfirmLabel')}
        variant="danger"
        onConfirm={() => { setConfig(CLEARED_CONFIG); setConfirming(false) }}
        onCancel={() => { setConfirming(false) }}
      />
    </div>
  )
}

/**
 * Technical, so collapsed under "Advanced" (open when no API endpoint is set:
 * the "Go to settings" buttons of an unconfigured page land here to show why).
 */
export default function BrowserSection() {
  const { t } = useTranslation('common')
  const apiEndpoint = useConfigStore((s) => s.config.apiEndpoint)
  return (
    <details className="card" open={apiEndpoint === ''}>
      <summary className="cursor-pointer text-base font-semibold text-text-strong flex items-center gap-2 focus-ring rounded-sm">
        <Monitor size={16} className="text-muted" aria-hidden="true" /> {t('account.browser.advanced')}
      </summary>
      <div className="space-y-4 mt-4">
        <p className="text-sm text-muted">{t('account.browser.hint')}</p>
        <dl className="text-sm">
          <dt className="text-xs text-muted">{t('account.browser.endpoint')}</dt>
          <dd className="text-text-strong mt-0.5 break-all">{apiEndpoint === '' ? t('account.browser.endpointNone') : apiEndpoint}</dd>
        </dl>
        <ResetLocalSettings />
      </div>
    </details>
  )
}
