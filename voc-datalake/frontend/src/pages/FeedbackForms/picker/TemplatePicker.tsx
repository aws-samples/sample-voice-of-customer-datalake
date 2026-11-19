/**
 * @fileoverview The template picker, `/feedback-forms/new` (UX §2): "Describe your form" first, then the twelve
 * templates by goal, and the preview of the one picked (`?template=<id>`; on a narrow screen that address shows the
 * preview alone, and Back returns to the list). "Create in" is the form's primary language: the preview speaks it,
 * and the form is made in it.
 *
 * Both ways open the builder with an unsaved new form at `/feedback-forms/new/questions` (D11): the first Save
 * creates it, Off. Leaving the builder's AI draft with Discard comes back here with its description
 * (`location.state.describe`).
 *
 * @module pages/FeedbackForms/picker/TemplatePicker
 */
import { useId, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import { z } from 'zod'
import clsx from 'clsx'
import { ChevronLeft } from 'lucide-react'
import { languageNames } from '../../../i18n/languages'
import { useRegisterKeepClear } from '../../../components/StickyActionBar/actionBarRegistry'
import { PageTitle } from '../../../components/PageTitle/PageTitle'
import { FORM_TEMPLATES, templateById } from '../formTemplates'
import { TEMPLATE_GROUPS } from '../templates/templateKit'
import type { TemplateFlow } from '../templates/templateKit'
import type { FormLanguage } from '../model/formsV2'
import { FORM_LANGUAGES, isFormLanguage } from '../model/formsV2'
import { pickerPath } from '../builder/builderPaths'
import { useAiDraftRequest } from '../ai/useAiDraftRequest'
import GoalRail from './GoalRail'
import type { GoalFilter } from './GoalRail'
import TemplateCard from './TemplateCard'
import TemplatePreview from './TemplatePreview'
import DescribePanel from './DescribePanel'
import { appFormLanguage, useCreateInCopy } from './useCreateInCopy'
import { usePickerActions } from './usePickerActions'

const describeState = z.object({ describe: z.string() })

/** The description the builder's Discard draft brought back, '' when none. */
function describedIn(state: unknown): string {
  const parsed = describeState.safeParse(state)
  return parsed.success ? parsed.data.describe : ''
}

function TemplateSections({ filter, selected, onSelect }: Readonly<{ filter: GoalFilter; selected: string | null; onSelect: (id: string) => void }>) {
  const { t } = useTranslation('feedbackForms')
  const groups = filter === 'all' ? TEMPLATE_GROUPS : [filter]
  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <section key={group} aria-labelledby={`group-${group}`} className="space-y-2">
          <h2 id={`group-${group}`} className="text-[11px] font-semibold uppercase tracking-[.08em] text-muted-strong">{t(`picker.groups.${group}`)}</h2>
          <div className="grid grid-cols-1 gap-2 2xl:grid-cols-2">
            {FORM_TEMPLATES.filter((flow) => flow.group === group).map((flow) => (
              <TemplateCard key={flow.id} flow={flow} selected={selected === flow.id} onSelect={onSelect} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

/** "Create in", the form's one language control (Describe says the language and moves here to change it). */
function CreateIn({ language, onChange, selectRef }: Readonly<{
  language: FormLanguage
  onChange: (language: FormLanguage) => void
  selectRef: RefObject<HTMLSelectElement | null>
}>) {
  const { t } = useTranslation('feedbackForms')
  const id = useId()
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-[13px] font-medium text-text">{t('picker.createIn')}</label>
      <select ref={selectRef} id={id} className="select w-auto" value={language}
        onChange={(event) => { if (isFormLanguage(event.target.value)) onChange(event.target.value) }}>
        {FORM_LANGUAGES.map((code) => <option key={code} value={code} lang={code}>{languageNames[code]}</option>)}
      </select>
    </div>
  )
}

/** On a narrow screen a picked template's preview is the page; desktop shows all three columns. */
const listClass = (picked: boolean) => clsx(picked && 'hidden md:block')

export default function TemplatePicker({ template }: Readonly<{ template: string | null }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  const navigate = useNavigate()
  const location = useLocation()
  const [language, setLanguage] = useState<FormLanguage>(() => appFormLanguage(i18n.language))
  const [filter, setFilter] = useState<GoalFilter>('all')
  const [initialDescription] = useState(() => describedIn(location.state))
  const describeRef = useRef<HTMLTextAreaElement>(null)
  const createInRef = useRef<HTMLSelectElement>(null)
  // (the assistant launcher stands beside the preview, never on its Use this template: StickyActionBar/actionBarRegistry)
  const previewRef = useRef<HTMLElement>(null)
  useRegisterKeepClear(previewRef, { mode: 'beside' })
  const request = useAiDraftRequest()
  const copy = useCreateInCopy(language)
  const flow: TemplateFlow | null = template === null ? null : templateById(template) ?? null
  const actions = usePickerActions({ flow, copy, language, request })
  const picked = flow !== null
  const select = (id: string) => { void navigate(pickerPath(id), { replace: picked }) }
  const previewForm = flow === null || !copy.ready ? null : copy.formOf(flow)

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className={clsx('flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between', picked && 'hidden md:flex')}>
        <PageTitle title={t('picker.title')} subtitle={t('picker.subtitle')} />
        <CreateIn language={language} onChange={setLanguage} selectRef={createInRef} />
      </div>
      {picked && (
        <button type="button" className="btn btn-ghost btn-sm md:hidden" onClick={() => { void navigate(pickerPath()) }}>
          <ChevronLeft size={14} aria-hidden="true" />{t('picker.backToList')}
        </button>
      )}
      {/* (a `grid-cols-1` base and `min-w-0` columns: an implicit column grew to the goal rail's and the phone frame's
          min-content, 669 px wide at 390, WCAG 1.4.10) */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[12rem_minmax(0,1fr)] xl:grid-cols-[12rem_minmax(0,1fr)_24rem]">
        <div className={clsx('min-w-0', listClass(picked))}>
          <GoalRail value={filter} onChange={setFilter} onDescribe={() => describeRef.current?.focus()} />
        </div>
        <div className={clsx('min-w-0 space-y-5', listClass(picked))}>
          <DescribePanel language={language} onLanguage={setLanguage} onChangeLanguage={() => createInRef.current?.focus()}
            request={request} initialDescription={initialDescription} textareaRef={describeRef} onSubmit={actions.draft} />
          <TemplateSections filter={filter} selected={flow?.id ?? null} onSelect={select} />
        </div>
        <aside ref={previewRef} aria-label={t('picker.preview.label')}
          className={clsx('min-w-0 md:col-span-2 xl:col-span-1 xl:sticky xl:top-4 xl:self-start', !picked && !request.busy && 'hidden md:block')}>
          <TemplatePreview flow={flow} form={previewForm} drafting={request.busy} onUse={actions.use} />
        </aside>
      </div>
    </div>
  )
}
