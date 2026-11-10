/**
 * @fileoverview Where an ask's button leads: one of our feedback forms (its answers are
 * then attributed to the recipient) or any https page.
 * @module pages/Participants/AskLinkField
 */
import { useId } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { participantsApi, participantsKeys } from '../../api/participantsApi'
import type { AskDraft } from './askDraft'

type LinkPatch = Partial<Pick<AskDraft, 'linkKind' | 'formId' | 'url'>>

export default function AskLinkField({ draft, onChange }: Readonly<{ draft: AskDraft; onChange: (patch: LinkPatch) => void }>) {
  const { t } = useTranslation('participants')
  const group = useId()
  const forms = useQuery({ queryKey: participantsKeys.forms(), queryFn: participantsApi.getForms })
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-text mb-1">{t('composer.link')}</legend>
      <div className="flex flex-wrap gap-4 text-sm text-text">
        <label className="flex items-center gap-2">
          <input type="radio" name={group} checked={draft.linkKind === 'form'} onChange={() => onChange({ linkKind: 'form' })} />
          {t('composer.linkForm')}
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name={group} checked={draft.linkKind === 'url'} onChange={() => onChange({ linkKind: 'url' })} />
          {t('composer.linkUrl')}
        </label>
      </div>
      {draft.linkKind === 'form' ? (
        <label className="block">
          <span className="sr-only">{t('composer.linkForm')}</span>
          <select value={draft.formId} onChange={(e) => onChange({ formId: e.target.value })} className="select w-full">
            <option value="">{t('composer.chooseForm')}</option>
            {(forms.data ?? []).map((form) => (
              <option key={form.form_id} value={form.form_id}>{form.enabled ? form.name : t('composer.formDisabled', { name: form.name })}</option>
            ))}
          </select>
          <span className="block text-xs text-muted mt-1">{t('composer.formHint')}</span>
        </label>
      ) : (
        <label className="block">
          <span className="sr-only">{t('composer.linkUrl')}</span>
          <input type="url" inputMode="url" value={draft.url} placeholder="https://" onChange={(e) => onChange({ url: e.target.value })} className="input w-full" />
        </label>
      )}
    </fieldset>
  )
}
