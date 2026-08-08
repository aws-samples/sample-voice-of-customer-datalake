/**
 * BuildPrototypeButton — kicks off an Opus 5 HTML prototype build for the whole
 * project and hands the wait to the Background Jobs panel.
 *
 * It used to await the job in local component state, which meant the only
 * progress indication in the app died with the component on any unmount, and a
 * build that outlived a five-minute client deadline was reported as a failure
 * while it was still running and about to succeed. The panel already renders
 * status, progress and staleness for exactly these job records, and survives
 * tab switches — so this component's job ends once the job is started.
 *
 * The backend references the project's latest PRD *and* PR-FAQ: if both exist
 * it uses both, if only one exists it uses that one. So the button is enabled
 * once at least one of them exists. When only one is present, clicking it first
 * confirms with the user that the build will use just that document.
 *
 * Lives in the project tab bar (top-right).
 */
import { AlertCircle, Loader2, Wand2 } from 'lucide-react'
import ConfirmModal from '../../components/ConfirmModal'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { projectsApi } from '../../api/projectsApi'

/** Exactly one of the two source documents exists, so the build needs a confirm. */
function hasOnlyOneDoc(hasPrd: boolean, hasPrfaq: boolean): boolean {
  return hasPrd !== hasPrfaq
}

// Keyed rather than branched in a helper, so neither the component's complexity
// budget nor the no-selector-parameter rule is tripped.
const SINGLE_DOC_MESSAGE = {
  prd: { key: 'documents.prototype.confirmPrdOnly', defaultValue: 'No PR-FAQ yet — the prototype will be built from the PRD only. Continue?' },
  prfaq: { key: 'documents.prototype.confirmPrfaqOnly', defaultValue: 'No PRD yet — the prototype will be built from the PR-FAQ only. Continue?' },
} as const

export default function BuildPrototypeButton({
  projectId, hasPrd, hasPrfaq, onJobStarted,
}: {
  readonly projectId: string
  readonly hasPrd: boolean
  readonly hasPrfaq: boolean
  /** Tells the Background Jobs panel to pick the new job up. */
  readonly onJobStarted?: () => void
}) {
  const { t, i18n } = useTranslation('projectDetail')
  const [busy, setBusy] = useState(false)
  const [started, setStarted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [showConfirm, setShowConfirm] = useState(false)
  const disabled = !hasPrd && !hasPrfaq

  // Both → build straight away. Only one → confirm we'll build from just that
  // document. This was window.confirm, which cannot be styled and sat outside
  // the ConfirmModal pattern every other guarded action in the app uses.
  const needsConfirm = hasOnlyOneDoc(hasPrd, hasPrfaq)
  const single = SINGLE_DOC_MESSAGE[hasPrd ? 'prd' : 'prfaq']
  const confirmMessage = t(single.key, { defaultValue: single.defaultValue })

  // Only the *start* call is reported here. Progress, failure and completion all
  // belong to the jobs panel, which outlives this component.
  const runBuild = useCallback(async () => {
    setBusy(true)
    setError(null)
    setStarted(false)
    try {
      await projectsApi.buildPrototype(projectId, { response_language: i18n.language })
      setStarted(true)
      onJobStarted?.()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Prototype failed')
    } finally {
      setBusy(false)
    }
  }, [projectId, i18n.language, onJobStarted])

  const onClick = useCallback(() => {
    if (needsConfirm) {
      setShowConfirm(true)
      return
    }
    void runBuild()
  }, [needsConfirm, runBuild])

  const onConfirm = useCallback(() => {
    setShowConfirm(false)
    void runBuild()
  }, [runBuild])

  const isDisabled = disabled || busy
  const buttonTitleKey = hasPrd && hasPrfaq
    ? { key: 'documents.prototype.buttonTitle', defaultValue: 'Generate a clickable HTML prototype from this project’s PRD + PR-FAQ' }
    : { key: 'documents.prototype.buttonTitleOne', defaultValue: 'Generate a clickable HTML prototype from the available document (PRD or PR-FAQ)' }
  const title = disabled
    ? t('documents.prototype.needsDocs', { defaultValue: 'Create a PRD or a PR-FAQ first to enable prototype build' })
    : t(buttonTitleKey.key, { defaultValue: buttonTitleKey.defaultValue })

  return (
    <div className="flex items-center gap-2">
      {error ? (
        <span className="text-xs text-red-600 inline-flex items-center gap-1 max-w-[200px] truncate" title={error}>
          <AlertCircle size={12} /> {error}
        </span>
      ) : null}
      {/* The jobs panel is the real progress report, but it is a refetch away
          and renders nothing until the job appears — so acknowledge the start
          here too, the way the product report card does. */}
      {started && error == null ? (
        <span className="text-xs text-emerald-700">{t('documents.prototype.started')}</span>
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
      <ConfirmModal
        isOpen={showConfirm}
        title={t('documents.prototype.button', { defaultValue: 'Build Prototype' })}
        message={confirmMessage}
        confirmLabel={t('documents.prototype.confirmBuild', { defaultValue: 'Build anyway' })}
        cancelLabel={t('documents.prototype.cancel', { defaultValue: 'Cancel' })}
        variant="warning"
        onConfirm={onConfirm}
        onCancel={() => setShowConfirm(false)}
      />
    </div>
  )
}
