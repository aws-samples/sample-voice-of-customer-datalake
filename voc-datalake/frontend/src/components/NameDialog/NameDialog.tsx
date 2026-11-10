/**
 * @fileoverview A dialog that asks for a name: the workflow editor's "Save
 * as…", Rename in the workflow library and the agent list, and — with an
 * optional description field and a hint — "New agent" / "New workflow".
 * Submits the trimmed name; empty is refused, and each field is capped at the
 * caller's API limit. Nothing is saved until the form is submitted.
 *
 * @module components/NameDialog/NameDialog
 */
import { useId, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import ModalShell from '../ModalShell/ModalShell'

interface NameDialogProps {
  title: string
  /** One line under the title, if any. */
  hint?: string
  /** The field's label. */
  label: string
  /** The API's name limit, in characters. */
  maxLength: number
  /** Adds an optional description field (its label and API limit). */
  description?: Readonly<{ label: string; maxLength: number }>
  submitLabel: string
  initialName: string
  saving: boolean
  /** Shown under the field (a failed save), if any. */
  error?: string
  /** The trimmed name, and the description as typed (`''` without the field). */
  onSave: (name: string, description: string) => void
  onClose: () => void
}

function DescriptionField({ label, maxLength, value, onChange }: Readonly<{
  label: string; maxLength: number; value: string; onChange: (value: string) => void
}>) {
  const id = useId()
  return (
    <div className="space-y-1 pt-2">
      <label htmlFor={id} className="block text-[12px] font-medium text-muted">{label}</label>
      <textarea id={id} rows={3} className="input w-full" value={value} maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

export function NameDialog({
  title, hint, label, maxLength, description, submitLabel, initialName, saving, error, onSave, onClose,
}: Readonly<NameDialogProps>) {
  const { t } = useTranslation('common')
  const [name, setName] = useState(initialName)
  const [text, setText] = useState('')
  const titleId = useId()
  const inputId = useId()
  const trimmed = name.trim()
  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} panelClassName="w-full max-w-md">
      <div className="dialog-header">
        <div>
          <h2 id={titleId} className="dialog-title">{title}</h2>
          {hint !== undefined && <p className="dialog-description">{hint}</p>}
        </div>
      </div>
      <form className="contents" onSubmit={(e) => { e.preventDefault(); if (trimmed !== '') onSave(trimmed, text) }}>
        <div className="dialog-body space-y-1">
          <label htmlFor={inputId} className="block text-[12px] font-medium text-muted">{label}</label>
          <input id={inputId} className="input w-full" value={name} maxLength={maxLength}
            onChange={(e) => setName(e.target.value)} />
          {description !== undefined && <DescriptionField {...description} value={text} onChange={setText} />}
          {error !== undefined && <p role="alert" className="text-[12px] text-danger">{error}</p>}
        </div>
        <div className="dialog-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t('cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={saving || trimmed === ''}>
            {saving && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} {submitLabel}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}
