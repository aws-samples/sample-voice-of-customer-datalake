/**
 * @fileoverview The builder header's ⋯ (UX §3.1): Improve with AI… · Discard changes · Duplicate form · Preview full
 * screen · Turn off (Live only) · Delete form… (a ConfirmModal naming the form and its response count). A duplicate
 * opens unsaved, like a template (UX §2.1).
 *
 * @module pages/FeedbackForms/builder/FormMenu
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Copy, ExternalLink, PowerOff, Sparkles, Trash2, Undo2 } from 'lucide-react'
import ConfirmModal from '../../../components/ConfirmModal/ConfirmModal'
import { saveIgnoringFailure } from '../../../components/UnsavedChangesGuard/useSnapshotGuard'
import { api } from '../../../api/client'
import { feedbackFormsKey } from '../../../api/feedbackFormQueryKeys'
import ActionsMenu from '../ui/ActionsMenu'
import type { MenuAction } from '../ui/ActionsMenu'
import { useDraft } from './formDraftContext'
import { useBuilderUi } from './builderUi'
import { FORMS_LIST_PATH, builderPath, formPreviewPath } from './builderPaths'
import { handoffState } from './newFormHandoff'

type Confirming = 'discard' | 'delete' | null

export default function FormMenu() {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const ui = useBuilderUi()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState<Confirming>(null)
  const formId = ui.formId
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteFeedbackForm(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: feedbackFormsKey() })
      ui.leave(FORMS_LIST_PATH)
    },
  })
  const saveFirst = formId === null ? t('builder.menu.saveFirst') : undefined

  const duplicate = () => {
    const copy = {
      ...draft.form, enabled: false, name: t('builder.copyName', { name: draft.form.name }),
      settings: { test: { ...draft.form.settings.test, link_enabled: false } },
    }
    void navigate(builderPath(null, 'questions'), { state: handoffState({ form: copy, templateId: draft.templateId, ai: null }) })
  }
  const items: (MenuAction | null)[] = [
    { label: t('builder.menu.improve'), icon: Sparkles, onSelect: ui.openImprove },
    { label: t('builder.menu.discard'), icon: Undo2, onSelect: () => setConfirming('discard'),
      disabledReason: draft.dirty ? undefined : t('builder.menu.nothingToDiscard') },
    { label: t('builder.menu.duplicate'), icon: Copy, onSelect: duplicate },
    { label: t('builder.menu.preview'), icon: ExternalLink, disabledReason: saveFirst,
      onSelect: () => { if (formId !== null) window.open(formPreviewPath(formId), '_blank', 'noopener') } },
    ...(draft.form.enabled && formId !== null
      ? [{ label: t('builder.menu.turnOff'), icon: PowerOff, onSelect: () => saveIgnoringFailure(draft.turnOff) }]
      : []),
    null,
    { label: t('builder.menu.delete'), icon: Trash2, danger: true, disabledReason: saveFirst, onSelect: () => setConfirming('delete') },
  ]
  const name = draft.form.name.trim() === '' ? t('builder.name.untitled') : draft.form.name
  const responses = draft.meta?.response_count ?? 0
  return (
    <>
      <ActionsMenu label={t('builder.menu.label')} items={items} />
      <ConfirmModal isOpen={confirming === 'discard'} title={t('builder.confirmDiscard.title')}
        message={draft.isNew ? t('builder.confirmDiscard.messageNew') : t('builder.confirmDiscard.message')}
        confirmLabel={t('builder.confirmDiscard.confirm')} variant="warning"
        onConfirm={() => { setConfirming(null); draft.discard() }} onCancel={() => setConfirming(null)} />
      <ConfirmModal isOpen={confirming === 'delete'} title={t('builder.confirmDelete.title')}
        message={responses > 0 ? t('builder.confirmDelete.messageResponses', { name, count: responses }) : t('builder.confirmDelete.message', { name })}
        confirmLabel={t('builder.confirmDelete.confirm')} variant="danger" isLoading={remove.isPending}
        onConfirm={() => { if (formId !== null) remove.mutate(formId) }} onCancel={() => setConfirming(null)} />
    </>
  )
}
