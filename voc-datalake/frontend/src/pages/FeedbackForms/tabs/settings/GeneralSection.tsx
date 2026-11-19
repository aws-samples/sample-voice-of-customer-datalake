/**
 * @fileoverview Settings › General and Danger zone (UX §14.1): the internal name (also edited inline in the header),
 * the primary language with a way to Languages; and Delete form…, which names the form and its response count before
 * it deletes, then leaves the builder for the list. A new, unsaved form has nothing to delete.
 *
 * @module pages/FeedbackForms/tabs/settings/GeneralSection
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2 } from 'lucide-react'
import ConfirmModal from '../../../../components/ConfirmModal/ConfirmModal'
import { languageNames } from '../../../../i18n/languages'
import { useDraft } from '../../builder/formDraftContext'
import { useBuilderUi } from '../../builder/builderUi'
import { FORMS_LIST_PATH } from '../../builder/builderPaths'
import { useOptimisticFormDelete } from '../../useOptimisticFormDelete'

export function GeneralSection() {
  const { t } = useTranslation('feedbackForms')
  const { form, update } = useDraft()
  const { go } = useBuilderUi()
  const id = useId()
  return (
    <div className="space-y-4">
      <div>
        <label htmlFor={id} className="mb-1 block text-sm font-medium text-text">{t('settings.general.name')}</label>
        <input id={id} className="input" value={form.name} aria-describedby={`${id}-hint`}
          onChange={(event) => update((current) => ({ ...current, name: event.target.value }))} />
        <p id={`${id}-hint`} className="mt-1 text-[12px] text-muted">{t('settings.general.nameHint')}</p>
      </div>
      <div className="text-sm text-text">
        <span className="font-medium">{t('settings.general.primary')}</span>{' '}
        <span lang={form.language}>{languageNames[form.language]}</span>{' · '}
        <button type="button" className="link" onClick={() => go('languages')}>{t('settings.general.toLanguages')}</button>
        <p className="mt-1 text-[12px] text-muted">{t('settings.general.languageHint')}</p>
      </div>
    </div>
  )
}

export function DangerZone() {
  const { t } = useTranslation('feedbackForms')
  const { form, meta } = useDraft()
  const { leave } = useBuilderUi()
  const remove = useOptimisticFormDelete()
  const [asking, setAsking] = useState(false)
  if (meta === null) return null
  const name = form.name.trim() === '' ? t('settings.danger.unnamed') : form.name
  return (
    <div className="space-y-2">
      <p className="text-sm text-text">{t('settings.danger.hint')}</p>
      <button type="button" className="btn btn-danger" onClick={() => setAsking(true)}>
        <Trash2 size={16} aria-hidden="true" />{t('settings.danger.delete')}
      </button>
      {remove.isError && <p role="alert" className="text-[12px] text-danger">{t('settings.danger.failed')}</p>}
      <ConfirmModal isOpen={asking} variant="danger" isLoading={remove.isPending}
        title={t('settings.danger.confirmTitle')}
        message={t('settings.danger.confirmMessage', { name, count: meta.response_count })}
        confirmLabel={t('settings.danger.confirm')}
        onCancel={() => setAsking(false)}
        onConfirm={() => remove.mutate(meta.form_id, {
          onSuccess: () => leave(FORMS_LIST_PATH),
          onSettled: () => setAsking(false),
        })} />
    </div>
  )
}
