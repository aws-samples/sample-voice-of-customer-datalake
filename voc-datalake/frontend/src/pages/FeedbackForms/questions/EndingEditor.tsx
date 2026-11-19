/**
 * @fileoverview An ending (UX §7): its title (required) and description, an optional button (label and an https
 * address), which paths end here ("Reached by: 7 is not accepted · the end of the questions (default)"), and its id
 * under Advanced (locked after the first response).
 *
 * @module pages/FeedbackForms/questions/EndingEditor
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Flag, Lightbulb } from 'lucide-react'
import SwitchField from '../../../components/SwitchField/SwitchField'
import CollapsibleSection from '../../../components/CollapsibleSection/CollapsibleSection'
import type { Ending, FormV2 } from '../model/formsV2'
import { textIn, withText } from '../model/i18nText'
import { isValidEndingId } from '../model/codes'
import { endingIds, renameEndingId, updateEnding } from '../model/mutations'
import { arrivalsAt } from '../model/paths'
import { problemsAt } from '../model/validateForm'
import { conditionText } from '../logic/ruleSentence'
import { useDraft } from '../builder/formDraftContext'
import { useBuilderUi } from '../builder/builderUi'
import { TextField } from './fields'
import { fieldProblems } from './fieldHelpers'
import { takeFocusRequest } from './focusRequest'
import IdField from './IdField'

/** "7 is not accepted", "the end of the questions (default)": each way a respondent reaches `ending`. */
function reachedBy(t: TFunction<'feedbackForms'>, form: FormV2, ending: Ending): string[] {
  return arrivalsAt(form, ending.id).map((arrival) => {
    const index = form.questions.findIndex((q) => q.id === arrival.questionId)
    const question = form.questions[index]
    const rule = arrival.ruleIndex === null ? undefined : question?.logic?.[arrival.ruleIndex]
    if (question === undefined || rule === undefined) return t('endings.endOfQuestions')
    const condition = rule.when.op === 'submitted' ? t('endings.otherwise') : conditionText(t, form, question, rule)
    return t('endings.reachedFrom', { number: index + 1, condition })
  })
}

export default function EndingEditor({ ending }: Readonly<{ ending: Ending }>) {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const { go } = useBuilderUi()
  const { form } = draft
  const lng = form.language
  const title = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const [advanced, setAdvanced] = useState(false)
  useEffect(() => { if (takeFocusRequest(ending.id)) title.current?.focus() }, [ending.id])
  const problems = problemsAt(draft.problems, 'ending', ending.id)
  const set = (fn: (e: Ending) => Ending) => draft.update((current) => updateEnding(current, ending.id, fn))
  const { button } = ending
  const reached = reachedBy(t, form, ending)
  const tip = draft.templateId === 'onboarding' && ending.id === 'end_newcomer'
  const checkId = (id: string) => {
    if (!isValidEndingId(id)) return 'problems.invalidEndingId'
    return endingIds(form).has(id) && id !== ending.id ? 'problems.duplicateEndingId' : ''
  }
  return (
    <div className="space-y-3">
      <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight text-text-strong">
        <Flag size={16} className="text-muted" aria-hidden="true" />{t('types.ending')}
        {form.endings[0]?.id === ending.id && <span className="badge badge-muted">{t('endings.default')}</span>}
      </h2>
      <TextField label={t('endings.title')} required inputRef={title} value={textIn(ending.title, lng)} problems={fieldProblems(problems, 'title')}
        onChange={(value) => set((e) => ({ ...e, title: withText(e.title, lng, value) }))} />
      <TextField label={t('endings.description')} multiline value={textIn(ending.description, lng)}
        onChange={(value) => set((e) => ({ ...e, description: withText(e.description, lng, value) }))} />
      <SwitchField checked={button !== undefined} label={t('endings.addButton')}
        onChange={(on) => set((e) => ({ ...e, button: on ? { label: {}, url: '' } : undefined }))} />
      {button !== undefined && (
        <div className="grid gap-2 sm:grid-cols-2">
          <TextField label={t('endings.buttonLabel')} required value={textIn(button.label, lng)} problems={fieldProblems(problems, 'button_label')}
            onChange={(value) => set((e) => ({ ...e, button: { url: e.button?.url ?? '', label: withText(e.button?.label, lng, value) } }))} />
          <TextField label={t('statement.address')} required type="url" mono value={button.url} placeholder="https://"
            hint={t('statement.addressHint')} problems={fieldProblems(problems, 'button_url')}
            onChange={(value) => set((e) => ({ ...e, button: { label: e.button?.label ?? {}, url: value } }))} />
        </div>
      )}
      <p className="text-[13px] text-text">
        <span className="font-medium">{t('endings.reachedBy')}</span>{' '}
        {reached.length === 0 ? t('problems.unreachableEnding') : reached.join(' · ')}
      </p>
      {tip && (
        <p className="flex items-start gap-2 text-[12px] text-muted">
          <Lightbulb size={14} className="mt-0.5 shrink-0" aria-hidden="true" />{t('templates.onboarding.tips.end_newcomer')}
        </p>
      )}
      <CollapsibleSection size="sm" title={t('question.advanced')} open={advanced} onOpenChange={setAdvanced}>
        <IdField label={t('endings.id')} value={ending.id} locked={draft.locked} lockedText={t('endings.idLocked')} check={checkId}
          onCommit={(id) => { draft.update((current) => renameEndingId(current, ending.id, id)); go('questions', ['end', id], { replace: true }) }} />
      </CollapsibleSection>
    </div>
  )
}
