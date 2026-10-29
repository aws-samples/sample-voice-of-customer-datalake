/**
 * @fileoverview The board editor's basics: name, slug (with the share link it gives and Copy for
 * the saved link) and description.
 * @module pages/Settings/boards/BoardBasicsFields
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy } from 'lucide-react'
import { BOARD_LIMITS, isValidSlug } from '../../../api/boardFields'
import { useCopyToClipboard } from '../../../hooks/useCopyToClipboard'
import { sharePreview } from './boardDraft'
import type { BoardDraft } from './boardDraft'

type BasicsPatch = Partial<Pick<BoardDraft, 'name' | 'slug' | 'description'>>

/** `slug` null (not valid yet): the saved link is shown as it is. */
function ShareLink({ savedUrl, slug }: Readonly<{ savedUrl: string; slug: string | null }>) {
  const { t } = useTranslation('settings')
  const { tryCopy, copiedKey } = useCopyToClipboard()
  const preview = slug === null ? savedUrl : sharePreview(savedUrl, slug)
  const changed = savedUrl !== '' && preview !== savedUrl
  const copy = () => { void tryCopy(savedUrl === '' ? preview : savedUrl) }
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted">{t('boards.editor.shareLink')}</span>
      <span className="font-mono text-text break-all">{preview}</span>
      {changed ? <span className="text-muted">{t('boards.editor.shareAfterSave')}</span> : null}
      <button type="button" className="btn btn-ghost btn-sm" onClick={copy}>
        <Copy size={14} aria-hidden="true" /> {t('boards.editor.copyLink')}
      </button>
      {copiedKey === null ? null : <span role="status" className="text-ok">{t('boards.editor.copied')}</span>}
    </div>
  )
}

export default function BoardBasicsFields({ draft, savedUrl, disabled, onChange }: Readonly<{
  draft: BoardDraft; savedUrl: string; disabled: boolean; onChange: (patch: BasicsPatch) => void
}>) {
  const { t } = useTranslation('settings')
  const nameId = useId()
  const slugId = useId()
  const slugHintId = useId()
  const descriptionId = useId()
  const slugOk = isValidSlug(draft.slug)
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor={nameId} className="block text-sm font-medium text-text">{t('boards.editor.name')}</label>
          <input id={nameId} className="input w-full" value={draft.name} maxLength={BOARD_LIMITS.name} disabled={disabled}
            aria-invalid={draft.name.trim() === ''} onChange={(e) => onChange({ name: e.target.value })} />
        </div>
        <div className="space-y-1">
          <label htmlFor={slugId} className="block text-sm font-medium text-text">{t('boards.editor.slug')}</label>
          <input id={slugId} className="input w-full font-mono" value={draft.slug} maxLength={BOARD_LIMITS.slug} disabled={disabled}
            aria-invalid={!slugOk} aria-describedby={slugHintId}
            onChange={(e) => onChange({ slug: e.target.value.toLowerCase() })} />
          <p id={slugHintId} className={slugOk ? 'text-xs text-muted' : 'text-xs text-danger'}>{t('boards.editor.slugHint')}</p>
        </div>
      </div>
      <ShareLink savedUrl={savedUrl} slug={slugOk ? draft.slug : null} />
      <div className="space-y-1">
        <label htmlFor={descriptionId} className="block text-sm font-medium text-text">{t('boards.editor.description')}</label>
        <textarea id={descriptionId} rows={3} className="input w-full" value={draft.description} maxLength={BOARD_LIMITS.description}
          disabled={disabled} onChange={(e) => onChange({ description: e.target.value })} />
      </div>
    </div>
  )
}
