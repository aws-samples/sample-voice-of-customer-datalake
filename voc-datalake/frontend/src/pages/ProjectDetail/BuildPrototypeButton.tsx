/**
 * BuildPrototypeButton — kicks off an Opus 4.8 HTML prototype build for the
 * whole project, then polls the job to completion.
 *
 * The backend references the project's latest PRD *and* PR-FAQ: if both exist
 * it uses both, if only one exists it uses that one. So the button is enabled
 * once at least one of them exists. When only one is present, clicking it first
 * confirms with the user that the build will use just that document.
 *
 * Lives in the project tab bar (top-right).
 */
import { AlertCircle, Loader2, Wand2 } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { projectsApi } from '../../api/projectsApi'

export default function BuildPrototypeButton({
  projectId, hasPrd, hasPrfaq, onDocumentChanged,
}: {
  readonly projectId: string
  readonly hasPrd: boolean
  readonly hasPrfaq: boolean
  readonly onDocumentChanged?: () => void
}) {
  const { t, i18n } = useTranslation('projectDetail')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const disabled = !hasPrd && !hasPrfaq

  const onClick = useCallback(async () => {
    // Both → use both. Only one → confirm we'll build from just that document.
    if (hasPrd && !hasPrfaq) {
      if (!window.confirm(t('documents.prototype.confirmPrdOnly', { defaultValue: 'No PR-FAQ yet — the prototype will be built from the PRD only. Continue?' }))) return
    } else if (!hasPrd && hasPrfaq) {
      if (!window.confirm(t('documents.prototype.confirmPrfaqOnly', { defaultValue: 'No PRD yet — the prototype will be built from the PR-FAQ only. Continue?' }))) return
    }
    setBusy(true)
    setError(null)
    try {
      const start = await projectsApi.buildPrototype(projectId, { response_language: i18n.language })
      const jobId = start.job_id
      const deadline = Date.now() + 5 * 60_000
      // Resilient polling: a single Wi-Fi hiccup or a brief CloudFront edge
      // glitch shouldn't kill the whole flow with "Failed to fetch". Allow up
      // to 5 consecutive transient errors before giving up — that's >15 seconds
      // of network trouble, by which point something is genuinely wrong.
      let consecutiveErrors = 0
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000))
        let job
        try {
          job = await projectsApi.getJobStatus(projectId, jobId)
          consecutiveErrors = 0
        } catch (pollErr) {
          consecutiveErrors += 1
          if (consecutiveErrors >= 5) throw pollErr
          // eslint-disable-next-line no-console -- diagnostic for transient poll failures
          console.warn(`Job poll error ${consecutiveErrors}/5 — retrying`, pollErr)
          continue
        }
        if (job.status === 'completed') {
          onDocumentChanged?.()
          return
        }
        if (job.status === 'failed') {
          throw new Error(job.error || 'Prototype build failed')
        }
      }
      throw new Error(t('documents.prototype.timeout', { defaultValue: 'Prototype build took too long. Check the Documents tab in a moment.' }))
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Prototype failed'
      setError(msg)
    } finally {
      setBusy(false)
    }
  }, [projectId, i18n.language, onDocumentChanged, t, hasPrd, hasPrfaq])

  const isDisabled = disabled || busy
  let title: string
  if (disabled) {
    title = t('documents.prototype.needsDocs', { defaultValue: 'Create a PRD or a PR-FAQ first to enable prototype build' })
  } else if (hasPrd && hasPrfaq) {
    title = t('documents.prototype.buttonTitle', { defaultValue: 'Generate a clickable HTML prototype from this project’s PRD + PR-FAQ' })
  } else {
    title = t('documents.prototype.buttonTitleOne', { defaultValue: 'Generate a clickable HTML prototype from the available document (PRD or PR-FAQ)' })
  }

  return (
    <div className="flex items-center gap-2">
      {error ? (
        <span className="text-xs text-red-600 inline-flex items-center gap-1 max-w-[200px] truncate" title={error}>
          <AlertCircle size={12} /> {error}
        </span>
      ) : null}
      <button
        onClick={onClick}
        disabled={isDisabled}
        className="inline-flex items-center gap-1.5 px-3 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
        title={title}
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
        {busy
          ? t('documents.prototype.building', { defaultValue: 'Building…' })
          : t('documents.prototype.button', { defaultValue: 'Build Prototype' })}
      </button>
    </div>
  )
}
