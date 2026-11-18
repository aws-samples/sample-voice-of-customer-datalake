/**
 * @fileoverview The Languages tab's rows (UX §8): the primary ("primary", how many texts, Change…: only to a complete
 * translation, it swaps the roles), then each translation with its state (▲ N missing / ✓ Complete), a bar and
 * "38 of 42", Translate and ⋯ Remove language….
 *
 * @module pages/FeedbackForms/tabs/languages/LanguageRows
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Languages, Trash2 } from 'lucide-react'
import { languageNames } from '../../../../i18n/languages'
import ActionsMenu from '../../ui/ActionsMenu'
import type { FormLanguage, FormV2 } from '../../model/formsV2'
import { completeness } from './languageEdits'

const nameOf = (language: FormLanguage) => `${languageNames[language]} (${language})`

function StateBadge({ missing }: Readonly<{ missing: number }>) {
  const { t } = useTranslation('feedbackForms')
  return missing === 0
    ? <span className="badge badge-ok inline-flex items-center gap-1"><Check size={12} aria-hidden="true" />{t('languages.complete')}</span>
    : <span className="badge badge-warn inline-flex items-center gap-1"><Languages size={12} aria-hidden="true" />{t('languages.missingCount', { count: missing })}</span>
}

function TranslationRow({ form, language, onTranslate, onRemove }: Readonly<{
  form: FormV2
  language: FormLanguage
  onTranslate: () => void
  onRemove: () => void
}>) {
  const { t } = useTranslation('feedbackForms')
  const stats = completeness(form, language)
  const share = stats.total === 0 ? 100 : Math.round((stats.done / stats.total) * 100)
  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2" data-testid={`language-${language}`}>
      <span className="min-w-[9rem] text-sm font-medium text-text-strong" lang={language}>{nameOf(language)}</span>
      <StateBadge missing={stats.missing} />
      <span aria-hidden="true" className="h-1.5 w-32 overflow-hidden rounded-full bg-bg-hover">
        <span className="block h-full bg-accent" style={{ width: `${String(share)}%` }} />
      </span>
      <span className="text-[13px] text-muted tabular-nums">{t('languages.doneOf', { done: stats.done, total: stats.total })}</span>
      <span className="ml-auto flex items-center gap-1">
        <button type="button" className="btn btn-secondary btn-sm" onClick={onTranslate}>{t('languages.translate')}</button>
        <ActionsMenu label={t('languages.actions', { language: languageNames[language] })}
          items={[{ label: t('languages.remove'), icon: Trash2, danger: true, onSelect: onRemove }]} />
      </span>
    </li>
  )
}

function ChangePrimary({ form, onChange }: Readonly<{ form: FormV2; onChange: (language: FormLanguage) => void }>) {
  const { t } = useTranslation('feedbackForms')
  const others = form.languages.filter((language) => language !== form.language)
  if (others.length === 0) return <p className="text-[12px] text-muted">{t('languages.changeNone')}</p>
  return (
    <ul className="space-y-1" aria-label={t('languages.changeLabel')}>
      {others.map((language) => {
        const complete = completeness(form, language).missing === 0
        return (
          <li key={language} className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-secondary btn-sm" aria-disabled={complete ? undefined : true}
              onClick={() => { if (complete) onChange(language) }}>
              {t('languages.makePrimary', { language: languageNames[language] })}
            </button>
            {!complete && <span className="text-[12px] text-muted">{t('languages.completeFirst')}</span>}
          </li>
        )
      })}
    </ul>
  )
}

export default function LanguageRows({ form, onTranslate, onRemove, onPrimary }: Readonly<{
  form: FormV2
  onTranslate: (language: FormLanguage) => void
  onRemove: (language: FormLanguage) => void
  onPrimary: (language: FormLanguage) => void
}>) {
  const { t } = useTranslation('feedbackForms')
  const [changing, setChanging] = useState(false)
  const total = completeness(form, form.language).total
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[12px] font-medium text-muted">{t('languages.primary')}</span>
        <span className="text-sm font-medium text-text-strong" lang={form.language}>{nameOf(form.language)}</span>
        <span className="text-[13px] text-muted">{t('languages.primaryHint')}</span>
        <button type="button" className="btn btn-ghost btn-sm ml-auto" aria-expanded={changing} onClick={() => setChanging((on) => !on)}>
          {t('languages.change')}
        </button>
      </div>
      {changing && <ChangePrimary form={form} onChange={(language) => { onPrimary(language); setChanging(false) }} />}
      <ul className="divide-y divide-border rounded-lg border border-border" aria-label={t('languages.listLabel')}>
        <li className="flex flex-wrap items-center gap-3 px-3 py-2" data-testid={`language-${form.language}`}>
          <span className="min-w-[9rem] text-sm font-medium text-text-strong" lang={form.language}>{nameOf(form.language)}</span>
          <span className="badge badge-muted">{t('languages.primaryBadge')}</span>
          <span className="text-[13px] text-muted tabular-nums">{t('languages.texts', { count: total })}</span>
        </li>
        {form.languages.filter((language) => language !== form.language).map((language) => (
          <TranslationRow key={language} form={form} language={language}
            onTranslate={() => onTranslate(language)} onRemove={() => onRemove(language)} />
        ))}
      </ul>
    </div>
  )
}
