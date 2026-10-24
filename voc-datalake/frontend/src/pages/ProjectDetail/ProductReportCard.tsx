/**
 * @fileoverview The Product tab's "Generate report" card. The report is a
 * minutes-long AI generation, so the button asks first (ConfirmModal) and only
 * the confirmation starts the job.
 * @module pages/ProjectDetail/ProductReportCard
 */
import { AlertCircle, CheckCircle2, FileOutput, Loader2 } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { projectsApi } from '../../api/projectsApi'
import { useTransientFlag } from './useTransientFlag'

/**
 * The other half of the backend's rule: it accepts at least one field **or** a
 * ready uploaded document. Asked only when the fields are empty, so this costs a
 * request on a path that would otherwise start a job doomed to fail.
 *
 * A failure to answer resolves to `true` — better to let the backend decide than
 * to block a user because a list call failed.
 */
async function hasReadyProductDoc(projectId: string): Promise<boolean> {
  try {
    const { docs } = await projectsApi.listProductDocs(projectId)
    return docs.some((doc) => doc.status === 'ready')
  } catch {
    return true
  }
}

export default function ProductReportCard({
  projectId, hasNoFields, onJobStarted,
}: {
  readonly projectId: string
  readonly hasNoFields: boolean
  readonly onJobStarted?: () => void
}) {
  const { t, i18n } = useTranslation('projectDetail')
  const language = i18n.language
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // Lowers itself once the panel has had time to pick the job up.
  const started = useTransientFlag()
  const [error, setError] = useState<string | null>(null)

  // Fire-and-forget: the server creates the job record and the Background Jobs
  // panel renders its progress. This card keeps a local "started" line because it
  // sits below the fold of an 11-field form.
  //
  // The pre-flight check exists because the backend's own rejection happens
  // *inside* the job: without it the user pays for a job that cannot succeed. It
  // mirrors the backend rule in full — fields OR a ready uploaded document.
  const onGenerate = useCallback(async () => {
    setBusy(true)
    setError(null)
    started.clear()
    try {
      if (hasNoFields && !await hasReadyProductDoc(projectId)) {
        setError(t('product.report.errorEmpty'))
        return
      }
      await projectsApi.generateProductReport(projectId, { response_language: language })
      started.set()
      onJobStarted?.()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Report failed')
    } finally {
      setBusy(false)
    }
  }, [projectId, language, hasNoFields, onJobStarted, started, t])

  return (
    <div className="bg-card border rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <FileOutput size={16} className="text-ok" />
        <h3 className="text-sm font-semibold">{t('product.report.title')}</h3>
      </div>
      <p className="text-xs text-muted mb-3">{t('product.report.description')}</p>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={busy}
        className="btn btn-primary w-full text-sm"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <FileOutput size={14} />}
        {busy ? t('product.report.generating') : t('product.report.button')}
      </button>
      {started.isSet && (
        <div className="mt-2 text-xs text-ok inline-flex items-center gap-1">
          <CheckCircle2 size={12} />
          <span><strong>{t('product.report.startedTitle')}.</strong> {t('product.report.startedMessage')}</span>
        </div>
      )}
      {error && (
        <div className="mt-2 text-xs text-danger inline-flex items-center gap-1">
          <AlertCircle size={12} /> {error}
        </div>
      )}
      <ConfirmModal
        isOpen={confirming}
        variant="info"
        title={t('product.report.confirmTitle')}
        message={t('product.report.confirmMessage')}
        confirmLabel={t('product.report.button')}
        onConfirm={() => { setConfirming(false); void onGenerate() }}
        onCancel={() => setConfirming(false)}
      />
    </div>
  )
}
