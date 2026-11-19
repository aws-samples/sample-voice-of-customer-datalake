/**
 * @fileoverview The addresses the AI suggested (UX §12.3): each is an error until the person confirms it or removes
 * it ("Confirm or remove the address the AI suggested."), so nothing the AI wrote sends respondents anywhere
 * unchecked.
 *
 * @module pages/FeedbackForms/ai/AiAddressList
 */
import { useTranslation } from 'react-i18next'
import { Check, Sparkles, Trash2 } from 'lucide-react'
import { useDraft } from '../builder/formDraftContext'
import { addressAt, sameLocation, withoutAddress } from './aiAddresses'
import type { ProblemLocation } from '../model/validateForm'

export default function AiAddressList() {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const unconfirmed = draft.ai?.unconfirmed ?? []
  const shown = unconfirmed.map((location) => ({ location, url: addressAt(draft.form, location) })).filter((entry) => entry.url !== '')
  if (shown.length === 0) return null
  const forget = (location: ProblemLocation) => draft.setAi((ai) => (ai === null ? ai
    : { ...ai, unconfirmed: ai.unconfirmed.filter((other) => !sameLocation(other, location)) }))
  return (
    <ul className="space-y-1.5" aria-label={t('ai.banner.addresses.label')}>
      {shown.map(({ location, url }) => (
        <li key={`${location.kind}:${location.id ?? ''}:${location.field ?? ''}`} className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="badge badge-aim inline-flex items-center gap-1"><Sparkles size={12} aria-hidden="true" />{t('ai.banner.addresses.suggested')}</span>
          <span className="min-w-0 break-all font-mono text-[12px] text-text">{url}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => forget(location)}>
            <Check size={14} aria-hidden="true" />{t('ai.banner.addresses.confirm')}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { draft.update((form) => withoutAddress(form, location)); forget(location) }}>
            <Trash2 size={14} aria-hidden="true" />{t('ai.banner.addresses.remove')}
          </button>
        </li>
      ))}
    </ul>
  )
}
