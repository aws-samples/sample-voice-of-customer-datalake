/**
 * @fileoverview One file in the upload sheet: its name and size; a refusal (a type the library takes not, a file
 * too large or empty) instead of fields; else its title and, under "More details", its short name, source, date
 * and tags; then, once sent, its progress and how it ended.
 *
 * @module pages/Library/UploadEntryCard
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { AlertCircle, CheckCircle2, X } from 'lucide-react'
import { formatFileSize } from '../../utils/file'
import { formatPercent } from '../../utils/numberFormat'
import { ACCEPTED_EXTENSIONS, MAX_TAGS, MAX_TAG_CHARS, slugify } from './libraryFormats'
import type { FileCheck } from './libraryFormats'
import { failureText } from './libraryErrors'
import { fieldProblem } from './useLibraryUpload'
import type { DraftFields, FieldProblem, UploadEntry } from './useLibraryUpload'

function refusalText(t: TFunction<'library'>, check: Extract<FileCheck, { ok: false }>): string {
  switch (check.reason) {
    case 'unsupported': return t('upload.refused.unsupported', { accepted: ACCEPTED_EXTENSIONS })
    case 'empty': return t('upload.refused.empty')
    case 'tooLarge': return t('upload.refused.tooLarge')
    case 'imageTooLarge': return t('upload.refused.imageTooLarge')
  }
}

function problemText(t: TFunction<'library'>, problem: FieldProblem): string {
  switch (problem) {
    case 'titleRequired': return t('fields.titleRequired')
    case 'badSlug': return t('fields.badSlug')
    case 'tooManyTags': return t('fields.tooManyTags', { max: MAX_TAGS })
    case 'tagTooLong': return t('fields.tagTooLong', { max: MAX_TAG_CHARS })
  }
}

function Progress({ entry }: Readonly<{ entry: UploadEntry }>) {
  const { t, i18n } = useTranslation('library')
  const percent = Math.round(entry.progress * 100)
  const label = t('upload.progressLabel', { name: entry.file.name })
  return (
    <div className="space-y-1">
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
        aria-valuetext={formatPercent(percent, i18n.language)} className="h-2 w-full overflow-hidden rounded-full bg-bg-accent">
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${String(percent)}%` }} />
      </div>
    </div>
  )
}

function PhaseLine({ entry }: Readonly<{ entry: UploadEntry }>) {
  const { t, i18n } = useTranslation('library')
  switch (entry.phase) {
    case 'ready': return null
    case 'creating': return <p role="status" className="text-[12px] text-muted">{t('upload.phase.creating')}</p>
    case 'uploading':
      return <p role="status" className="text-[12px] text-muted">{t('upload.phase.uploading', { percent: formatPercent(entry.progress * 100, i18n.language) })}</p>
    case 'finishing': return <p role="status" className="text-[12px] text-muted">{t('upload.phase.finishing')}</p>
    case 'done':
      return <p role="status" className="flex items-center gap-1 text-[12px] text-ok"><CheckCircle2 size={12} aria-hidden="true" />{t('upload.phase.done')}</p>
    case 'failed':
      return (
        <p role="alert" className="flex items-start gap-1 text-[12px] text-danger">
          <AlertCircle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
          {failureText(t, entry.failure ?? 'other')}
        </p>
      )
  }
}

function Fields({ entry, disabled, onChange }: Readonly<{
  entry: UploadEntry; disabled: boolean; onChange: (fields: DraftFields) => void
}>) {
  const { t } = useTranslation('library')
  const id = useId()
  const { fields } = entry
  const set = (change: Partial<DraftFields>) => onChange({ ...fields, ...change })
  const problem = fieldProblem(fields)
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <label htmlFor={`${id}-title`} className="block text-[12px] font-medium text-muted">{t('fields.title')}</label>
        <input id={`${id}-title`} className="input" value={fields.title} maxLength={200} disabled={disabled}
          onChange={(event) => set({ title: event.target.value })} />
      </div>
      <details className="group">
        <summary className="cursor-pointer text-[12px] font-medium text-accent-text">{t('upload.moreDetails')}</summary>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor={`${id}-slug`} className="block text-[12px] font-medium text-muted">{t('fields.slug')}</label>
            <input id={`${id}-slug`} className="input font-mono" value={fields.slug} maxLength={64} disabled={disabled}
              placeholder={slugify(fields.title)} aria-describedby={`${id}-slug-hint`}
              onChange={(event) => set({ slug: event.target.value.toLowerCase() })} />
            <p id={`${id}-slug-hint`} className="text-[12px] text-muted">{t('fields.slugHint')}</p>
          </div>
          <div className="space-y-1">
            <label htmlFor={`${id}-source`} className="block text-[12px] font-medium text-muted">{t('fields.source')}</label>
            <input id={`${id}-source`} className="input" value={fields.source} maxLength={200} disabled={disabled}
              onChange={(event) => set({ source: event.target.value })} />
          </div>
          <div className="space-y-1">
            <label htmlFor={`${id}-date`} className="block text-[12px] font-medium text-muted">{t('fields.docDate')}</label>
            <input id={`${id}-date`} type="date" className="input" value={fields.docDate} disabled={disabled}
              onChange={(event) => set({ docDate: event.target.value })} />
          </div>
          <div className="space-y-1">
            <label htmlFor={`${id}-tags`} className="block text-[12px] font-medium text-muted">{t('fields.tags')}</label>
            <input id={`${id}-tags`} className="input" value={fields.tags} disabled={disabled} aria-describedby={`${id}-tags-hint`}
              onChange={(event) => set({ tags: event.target.value })} />
            <p id={`${id}-tags-hint`} className="text-[12px] text-muted">{t('fields.tagsHint')}</p>
          </div>
        </div>
      </details>
      {problem === null ? null : <p role="alert" className="text-[12px] text-danger">{problemText(t, problem)}</p>}
    </div>
  )
}

export default function UploadEntryCard({ entry, running, onChange, onRemove }: Readonly<{
  entry: UploadEntry
  /** An upload is in flight (this file's or another's): nothing changes meanwhile. */
  running: boolean
  onChange: (fields: DraftFields) => void
  onRemove: () => void
}>) {
  const { t, i18n } = useTranslation('library')
  const sending = entry.phase === 'creating' || entry.phase === 'uploading' || entry.phase === 'finishing'
  const locked = running || entry.phase === 'done'
  return (
    <li className="card min-w-0 space-y-2 p-3">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-all text-sm font-medium text-text-strong">{entry.file.name}</p>
          <p className="text-[12px] text-muted tabular-nums">{formatFileSize(entry.file.size, i18n.language)}</p>
        </div>
        {locked ? null : (
          <button type="button" onClick={onRemove} className="icon-btn shrink-0" aria-label={t('upload.remove', { name: entry.file.name })}>
            <X size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      {entry.check.ok
        ? <Fields entry={entry} disabled={locked} onChange={onChange} />
        : <p role="alert" className="text-[12px] text-danger">{refusalText(t, entry.check)}</p>}
      {sending ? <Progress entry={entry} /> : null}
      <PhaseLine entry={entry} />
    </li>
  )
}
