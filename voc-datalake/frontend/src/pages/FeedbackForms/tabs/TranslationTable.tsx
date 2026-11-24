/**
 * @fileoverview The side-by-side translation of one language (UX §8, `/languages/<lng>`): every text the primary
 * has, grouped by question in form order, then the welcome card and the endings. Each row names its field, shows
 * the primary text read-only and the target field ("English: Option 7 of question 1"); an empty target is marked
 * Missing, a text filled from the template's catalogue "From template" until it is edited. Only missing and Search
 * (either side) filter it.
 *
 * @module pages/FeedbackForms/tabs/TranslationTable
 */
import { createElement, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { ChevronLeft, Flag } from 'lucide-react'
import SwitchField from '../../../components/SwitchField/SwitchField'
import { TruncatedText } from '../../../components/Tooltip/TruncatedText'
import { languageNames } from '../../../i18n/languages'
import { useDraft } from '../builder/formDraftContext'
import { useBuilderUi } from '../builder/builderUi'
import type { FormLanguage, FormV2 } from '../model/formsV2'
import { hasText, textIn } from '../model/i18nText'
import { headlineShown } from '../model/recall'
import { textsToTranslate } from '../model/translatable'
import type { TranslatableText } from '../model/translatable'
import { questionIcon } from '../ui/typeIcons'
import { completeness } from './languages/languageEdits'

interface Group {
  readonly key: string
  readonly heading: string
  readonly kind: TranslatableText['owner']['kind']
  readonly ownerId: string
  readonly entries: readonly TranslatableText[]
}

function headingOf(t: TFunction<'feedbackForms'>, form: FormV2, owner: TranslatableText['owner']): string {
  if (owner.kind === 'welcome') return t('types.welcome')
  if (owner.kind === 'ending') return textIn(form.endings.find((e) => e.id === owner.id)?.title, form.language)
  const at = form.questions.findIndex((q) => q.id === owner.id)
  return t('logic.target.question', { number: at + 1, headline: headlineShown(form.questions[at], form.language) })
}

function groupsOf(t: TFunction<'feedbackForms'>, form: FormV2, entries: readonly TranslatableText[]): Group[] {
  const groups = new Map<string, TranslatableText[]>()
  for (const entry of entries) {
    const key = `${entry.owner.kind}:${entry.owner.id}`
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }
  return [...groups.entries()].flatMap(([key, items]) => {
    const [first] = items
    return first === undefined ? [] : [{ key, kind: first.owner.kind, ownerId: first.owner.id, heading: headingOf(t, form, first.owner), entries: items }]
  })
}

function targetName(t: TFunction<'feedbackForms'>, form: FormV2, entry: TranslatableText, language: FormLanguage): string {
  const field = t(`languages.fields.${entry.field}`, { number: entry.number ?? 0 })
  const name = languageNames[language]
  if (entry.owner.kind === 'welcome') return t('languages.targetWelcome', { language: name, field })
  if (entry.owner.kind === 'ending') return t('languages.targetEnding', { language: name, field, title: headingOf(t, form, entry.owner) })
  return t('languages.targetQuestion', { language: name, field, number: form.questions.findIndex((q) => q.id === entry.owner.id) + 1 })
}

function TranslationRow({ entry, language }: Readonly<{ entry: TranslatableText; language: FormLanguage }>) {
  const { t } = useTranslation('feedbackForms')
  const id = useId()
  const draft = useDraft()
  const { form } = draft
  const value = textIn(entry.text, language)
  const templateKey = `${language}:${entry.key}`
  const fromTemplate = draft.fromTemplate.has(templateKey)
  const write = (next: string) => {
    draft.update((current) => entry.write(current, language, next))
    if (fromTemplate) draft.setFromTemplate((keys) => new Set([...keys].filter((key) => key !== templateKey)))
  }
  return (
    <li className="grid gap-1 py-2 md:grid-cols-[9rem_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center md:gap-3">
      <label htmlFor={id} className="text-[12px] font-medium text-muted">{t(`languages.fields.${entry.field}`, { number: entry.number ?? 0 })}</label>
      <TruncatedText as="p" className="truncate text-[13px] text-text" text={textIn(entry.text, form.language)} />
      <input id={id} className="input" value={value} aria-label={targetName(t, form, entry, language)} lang={language}
        onChange={(event) => write(event.target.value)} />
      <span className="flex gap-1">
        {value === '' && <span className="badge badge-warn">{t('languages.missing')}</span>}
        {value !== '' && fromTemplate && <span className="badge badge-info">{t('languages.fromTemplate')}</span>}
      </span>
    </li>
  )
}

function GroupHeading({ group, form }: Readonly<{ group: Group; form: FormV2 }>) {
  const question = form.questions.find((q) => q.id === group.ownerId)
  const questionGlyph = question === undefined ? null : questionIcon(question)
  const Icon = group.kind === 'ending' ? Flag : questionGlyph
  return (
    <h3 className="flex items-center gap-2 text-sm font-medium text-text-strong">
      {Icon !== null && createElement(Icon, { size: 14, className: 'text-muted', 'aria-hidden': true })}
      <TruncatedText className="truncate" text={group.heading} />
    </h3>
  )
}

export default function TranslationTable({ language }: Readonly<{ language: FormLanguage }>) {
  const { t } = useTranslation('feedbackForms')
  const { form } = useDraft()
  const { go } = useBuilderUi()
  const [onlyMissing, setOnlyMissing] = useState(false)
  const [search, setSearch] = useState('')
  const stats = completeness(form, language)
  const groups = useMemo(() => {
    const query = search.trim().toLowerCase()
    const shown = textsToTranslate(form).filter((entry) => (!onlyMissing || !hasText(entry.text, language))
      && (query === '' || `${textIn(entry.text, form.language)}\n${textIn(entry.text, language)}`.toLowerCase().includes(query)))
    return groupsOf(t, form, shown)
  }, [form, language, onlyMissing, search, t])
  return (
    <section aria-labelledby="translation-heading" className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => go('languages')}>
          <ChevronLeft size={14} aria-hidden="true" />{t('languages.back')}
        </button>
        <h2 id="translation-heading" className="text-sm font-semibold tracking-tight text-text-strong tabular-nums">
          {t('languages.viewTitle', { language: languageNames[language], code: language, done: stats.done, total: stats.total })}
        </h2>
        <span className="ml-auto"><SwitchField checked={onlyMissing} onChange={setOnlyMissing} label={t('languages.onlyMissing')} /></span>
        <input type="search" className="input w-full sm:w-56" value={search} aria-label={t('languages.search')}
          placeholder={t('languages.search')} onChange={(event) => setSearch(event.target.value)} />
      </div>
      {groups.length === 0 && <p className="text-[13px] text-muted">{t('languages.nothingShown')}</p>}
      {groups.map((group) => (
        <div key={group.key} className="rounded-lg border border-border p-3" data-testid={`translate-${group.ownerId}`}>
          <GroupHeading group={group} form={form} />
          <ul className="divide-y divide-border">
            {group.entries.map((entry) => <TranslationRow key={entry.key} entry={entry} language={language} />)}
          </ul>
        </div>
      ))}
    </section>
  )
}
