/**
 * @fileoverview The Hidden fields tab (UX §6): the values an app or a link passes in with each response, which
 * respondents never see. Declare them (at most 20; the ID checked as you type, locked once the form has a real
 * response), then copy the link or code that fills them, live or test.
 *
 * @module pages/FeedbackForms/tabs/HiddenFieldsTab
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EyeOff, Plus } from 'lucide-react'
import Notice from '../../../components/Notice/Notice'
import ConfirmModal from '../../../components/ConfirmModal/ConfirmModal'
import { useDimensionsConfig } from '../../../hooks/useDimensions'
import { useDraft } from '../builder/formDraftContext'
import type { HiddenField } from '../model/formsV2'
import { LIMITS } from '../model/formsV2'
import HiddenFieldEditor from './hidden/HiddenFieldEditor'
import HiddenFieldsTable from './hidden/HiddenFieldsTable'
import HiddenSnippets from './hidden/HiddenSnippets'

function useDimensionLabels(): ReadonlyMap<string, string> {
  const { data } = useDimensionsConfig()
  return useMemo(() => new Map((data?.dimensions ?? []).map((dimension) => [dimension.key, dimension.label])), [data])
}

export default function HiddenFieldsTab() {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const fields = draft.form.hidden_fields
  const dimensions = useDimensionLabels()
  const [adding, setAdding] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const full = fields.length >= LIMITS.hiddenFields
  const write = (next: readonly HiddenField[]) => draft.update((form) => ({ ...form, hidden_fields: next }))
  const add = (field: HiddenField) => {
    write([...fields, field])
    setAdding(false)
  }
  const startAdding = () => { if (!full) setAdding(true) }
  return (
    <section aria-labelledby="hidden-heading" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="hidden-heading" className="text-sm font-semibold tracking-tight text-text-strong">{t('hidden.title')}</h2>
          <p className="text-[13px] text-muted">{t('hidden.intro')}</p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" aria-disabled={full ? true : undefined} onClick={startAdding}>
          <Plus size={14} aria-hidden="true" />{t('hidden.addField')}
        </button>
      </div>
      {full && <p className="text-[13px] text-muted">{t('hidden.limit')}</p>}
      {fields.length === 0 && !adding ? (
        <Notice variant="empty" icon={EyeOff} title={t('hidden.emptyTitle')} text={t('hidden.empty')}
          action={{ label: t('hidden.addField'), icon: Plus, onClick: startAdding }} />
      ) : (
        <HiddenFieldsTable fields={fields} dimensions={dimensions} renaming={renaming} locked={draft.locked}
          onRename={setRenaming} onDelete={setDeleting}
          onRenamed={(from, next) => { write(fields.map((field) => (field.id === from ? next : field))); setRenaming(null) }} />
      )}
      {adding && <HiddenFieldEditor initial={null} locked={false} taken={new Set(fields.map((field) => field.id))} onDone={add} onCancel={() => setAdding(false)} />}
      <p className="text-[12px] text-muted tabular-nums">{t('hidden.count', { n: fields.length, max: LIMITS.hiddenFields })}</p>
      <HiddenSnippets />
      <ConfirmModal isOpen={deleting !== null} variant="danger" title={t('hidden.deleteTitle', { id: deleting ?? '' })}
        message={t('hidden.deleteMessage')} confirmLabel={t('hidden.deleteConfirm')}
        onCancel={() => setDeleting(null)}
        onConfirm={() => { write(fields.filter((field) => field.id !== deleting)); setDeleting(null) }} />
    </section>
  )
}
