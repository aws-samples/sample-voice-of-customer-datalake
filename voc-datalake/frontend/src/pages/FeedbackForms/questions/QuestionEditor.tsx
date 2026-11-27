/**
 * @fileoverview The selected question's editor (UX §3.4), top to bottom: the header ("1 · Multiple choice ▾", whose
 * type select lists only the conversions that keep the content; Duplicate; ⋯), Question * and Description, the
 * type's own fields, Required, ▸ Logic · N rules, and ▸ Advanced (the question id, the button label, Show codes).
 * It always edits the primary language; a missing translation is one line under the Question field, with Translate.
 * Logic and Advanced are the compact collapsible sections, so they never outrank the header.
 *
 * @module pages/FeedbackForms/questions/QuestionEditor
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import SwitchField from '../../../components/SwitchField/SwitchField'
import CollapsibleSection from '../../../components/CollapsibleSection/CollapsibleSection'
import type { Question } from '../model/formsV2'
import { LIMITS, isChoice, isMatrix, isScale } from '../model/formsV2'
import { textIn, withText } from '../model/i18nText'
import { isValidQuestionId } from '../model/codes'
import { questionIds, renameQuestionId, updateQuestion } from '../model/mutations'
import { splitOtherwise } from '../model/rules'
import { problemsAt } from '../model/validateForm'
import { useDraft } from '../builder/formDraftContext'
import { useBuilderUi } from '../builder/builderUi'
import LogicSection from '../logic/LogicSection'
import { TextField } from './fields'
import { fieldProblems } from './fieldHelpers'
import { takeFocusRequest } from './focusRequest'
import EditorHeader from './EditorHeader'
import ChoiceEditor from './ChoiceEditor'
import ScaleEditor from './ScaleEditor'
import TextEditor from './TextEditor'
import StatementEditor from './StatementEditor'
import ConsentEditor from './ConsentEditor'
import ContactEditor from './ContactEditor'
import MatrixEditor from './MatrixEditor'
import TranslationBanner from './TranslationBanner'
import RecallField from './RecallField'
import IdField from './IdField'

function OwnFields({ question, index, showCodes, onChange, onEditLogic }: Readonly<{
  question: Question; index: number; showCodes: boolean; onChange: (q: Question) => void; onEditLogic: () => void
}>) {
  if (isChoice(question)) return <ChoiceEditor question={question} index={index} showCodes={showCodes} onEditLogic={onEditLogic} />
  if (isScale(question)) return <ScaleEditor question={question} onChange={onChange} />
  switch (question.type) {
    case 'open_text': return <TextEditor question={question} onChange={onChange} />
    case 'statement': return <StatementEditor question={question} onChange={onChange} />
    case 'consent': return <ConsentEditor question={question} onChange={onChange} />
    case 'contact_info': return <ContactEditor question={question} onChange={onChange} />
    case 'matrix': return <MatrixEditor question={question} showCodes={showCodes} onChange={onChange} />
    default: return null
  }
}

function requiredHint(t: (key: string) => string, question: Question): string | undefined {
  if (question.type === 'matrix') return t('matrix.requiredHint')
  return isScale(question) ? t('question.requiredScaleHint') : undefined
}

export default function QuestionEditor({ question, index }: Readonly<{ question: Question; index: number }>) {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const { go } = useBuilderUi()
  const { form } = draft
  const lng = form.language
  const headline = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const logic = splitOtherwise(question)
  const ruleCount = logic.rules.length + (logic.otherwise === null ? 0 : 1)
  const [logicOpen, setLogicOpen] = useState(ruleCount > 0)
  const [advanced, setAdvanced] = useState(false)
  const [showCodes, setShowCodes] = useState(false)
  useEffect(() => { if (takeFocusRequest(question.id)) headline.current?.focus() }, [question.id])
  const problems = problemsAt(draft.problems, 'question', question.id)
  const replace = (next: Question) => draft.update((current) => updateQuestion(current, question.id, () => next))
  const checkId = (id: string) => {
    if (!isValidQuestionId(id)) return 'problems.invalidQuestionId'
    if (questionIds(form).has(id) && id !== question.id) return 'problems.duplicateQuestionId'
    return draft.retiredIds.has(id) ? 'problems.retiredQuestionId' : ''
  }
  const editLogic = () => {
    setLogicOpen(true)
    window.requestAnimationFrame(() => document.getElementById(`logic-${question.id}`)?.scrollIntoView({ block: 'nearest' }))
  }
  return (
    <div className="space-y-4">
      <EditorHeader question={question} index={index} />
      <div className="space-y-1.5">
        <RecallField before={index} label={question.type === 'statement' ? t('statement.text') : t('question.headline')} required multiline counter={LIMITS.headlineChars}
          inputRef={headline} value={textIn(question.headline, lng)} placeholder={t('question.newQuestion')} problems={fieldProblems(problems, 'headline')}
          onChange={(value) => replace({ ...question, headline: withText(question.headline, lng, value) })} />
        <TranslationBanner ownerId={question.id} />
      </div>
      <RecallField before={index} label={t('question.description')} multiline value={textIn(question.subheader, lng)} problems={fieldProblems(problems, 'subheader')}
        onChange={(value) => replace({ ...question, subheader: withText(question.subheader, lng, value) })} />
      <OwnFields question={question} index={index} showCodes={showCodes} onChange={replace} onEditLogic={editLogic} />
      {question.type !== 'statement' && (
        <SwitchField checked={question.required} label={question.type === 'consent' ? t('consent.mustTick') : t('question.required')}
          hint={requiredHint(t, question)} onChange={(required) => replace({ ...question, required })} />
      )}
      <div id={`logic-${question.id}`}>
        <CollapsibleSection size="sm" title={t('question.logic', { count: ruleCount })} open={logicOpen} onOpenChange={setLogicOpen}>
          <LogicSection questionId={question.id} />
        </CollapsibleSection>
      </div>
      <CollapsibleSection size="sm" title={t('question.advanced')} open={advanced} onOpenChange={setAdvanced}>
        <div className="space-y-3">
          <IdField label={t('question.id')} value={question.id} locked={draft.locked} lockedText={t('question.idLocked')} check={checkId}
            onCommit={(id) => { draft.update((current) => renameQuestionId(current, question.id, id)); go('questions', [id], { replace: true }) }} />
          <TextField label={t('question.buttonLabel')} value={textIn(question.button_label, lng)} placeholder={t('question.buttonLabelPlaceholder')}
            problems={fieldProblems(problems, 'button_label')}
            onChange={(value) => replace({ ...question, button_label: withText(question.button_label, lng, value) })} />
          {(isChoice(question) || isMatrix(question)) && <SwitchField checked={showCodes} label={t('choice.showCodes')} hint={t('choice.showCodesHint')} onChange={setShowCodes} />}
        </div>
      </CollapsibleSection>
    </div>
  )
}
