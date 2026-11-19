/**
 * @fileoverview One question of the Flow outline (UX §5.4): its number, type icon, headline and meta line, then its
 * rules as sentences (each a button that opens the same controls as the Logic section in place; Escape closes it and
 * returns focus) and its Otherwise, the problems under the rows, and "+ Add rule" on hover or focus.
 *
 * @module pages/FeedbackForms/logic/FlowQuestion
 */
import { createElement, useId } from 'react'
import type { KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { AlertTriangle, GitBranch, Plus, Sparkles } from 'lucide-react'
import type { Question } from '../model/formsV2'
import { isChoice } from '../model/formsV2'
import { textIn } from '../model/i18nText'
import { questionIcon } from '../ui/typeIcons'
import { useQuestionLogic } from './useQuestionLogic'
import type { QuestionLogic } from './useQuestionLogic'
import { ruleSentence, targetText } from './ruleSentence'
import RuleRow from './RuleRow'
import OtherwiseRow from './OtherwiseRow'
import RuleProblemList from './RuleProblemList'
import { fallthroughLabel } from './ruleControls'

/** What is open in place: a rule of a question (its index), or its Otherwise. */
export interface OpenRule {
  readonly questionId: string
  readonly at: number | 'otherwise'
}

function useMetaLine(question: Question): string {
  const { t } = useTranslation('feedbackForms')
  const parts = [question.required ? t('flow.meta.required') : t('flow.meta.optional')]
  if (isChoice(question)) parts.push(t('flow.meta.options', { count: question.options.length }))
  if (isChoice(question) && question.other.enabled) parts.push(t('flow.meta.other'))
  return parts.join(' · ')
}

/** An in-place rule focuses its operator once it opens; nothing else follows. */
function rowFocused(): void {
  // (the row moved focus itself)
}

function SentenceButton({ text, onOpen, id }: Readonly<{ text: string; onOpen: () => void; id: string }>) {
  return (
    <button id={id} type="button" onClick={onOpen}
      className="flex w-full items-start gap-1.5 rounded-md px-2 py-1 text-left text-[13px] text-text hover:bg-bg-hover focus-ring">
      <GitBranch size={13} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
      <span className="min-w-0">{text}</span>
    </button>
  )
}

function RuleLines({ logic, open, onOpen, onClose, folded }: Readonly<{
  logic: QuestionLogic
  open: OpenRule | null
  onOpen: (at: number | 'otherwise') => void
  onClose: () => void
  folded: boolean
}>) {
  const { t } = useTranslation('feedbackForms')
  const base = useId()
  const buttonId = (at: number | 'otherwise') => `${base}-${String(at)}`
  const isOpen = (at: number | 'otherwise') => open?.questionId === logic.question.id && open.at === at
  const close = (at: number | 'otherwise') => (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    onClose()
    window.setTimeout(() => document.getElementById(buttonId(at))?.focus(), 0)
  }
  const otherwise = logic.otherwise
  if (folded && logic.rules.length === 0 && otherwise === null) return null
  return (
    <ol className="ml-6 space-y-1">
      {logic.rules.map((rule, at) => (
        // (a rule has no id: its position is its identity)
        <li key={at}>
          {isOpen(at) ? (
            <div onKeyDown={close(at)}>
              <ol><RuleRow logic={logic} at={at} focus="operator" onFocused={rowFocused} onMove={(to) => logic.moveRule(at, to)} /></ol>
            </div>
          ) : (
            <>
              <SentenceButton text={ruleSentence(t, logic.form, logic.question, rule)} onOpen={() => onOpen(at)} id={buttonId(at)} />
              <RuleProblemList problems={logic.problems.filter((problem) => problem.ruleIndex === at)} />
            </>
          )}
        </li>
      ))}
      <li>
        {isOpen('otherwise') ? (
          <div onKeyDown={close('otherwise')}><OtherwiseRow logic={logic} /></div>
        ) : (
          <SentenceButton onOpen={() => onOpen('otherwise')} id={buttonId('otherwise')}
            text={t(logic.question.type === 'statement' ? 'flow.thenGoTo' : 'logic.sentence.otherwise', {
              target: otherwise === null ? fallthroughLabel(t, logic.form, logic.index) : targetText(t, logic.form, otherwise),
            })} />
        )}
      </li>
    </ol>
  )
}

export default function FlowQuestion({ questionId, number, reached, marked, folded, open, onOpen, onClose }: Readonly<{
  questionId: string
  number: number
  /** How many paths reach it (0: none does). */
  reached: number
  /** The AI added or changed it (until opened). */
  marked: boolean
  /** Fold a question without rules to one line. */
  folded: boolean
  open: OpenRule | null
  onOpen: (open: OpenRule) => void
  onClose: () => void
}>) {
  const { t } = useTranslation('feedbackForms')
  const logic = useQuestionLogic(questionId)
  const meta = useMetaLine(logic?.question ?? { id: questionId, type: 'statement', headline: {}, required: false })
  if (logic === null) return null
  const { question, form } = logic
  const unreachable = number > 1 && reached === 0
  const statement = question.type === 'statement'
  return (
    <li className={clsx('group rounded-lg border border-border p-3', unreachable && 'text-muted')} data-testid={`flow-${question.id}`}>
      <div className="flex items-center gap-2">
        <span className="w-6 font-mono text-[12px] text-muted">{number}</span>
        {createElement(questionIcon(question), { size: 14, className: 'shrink-0 text-muted', 'aria-hidden': true })}
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-text-strong" title={textIn(question.headline, form.language)}>{textIn(question.headline, form.language)}</h3>
        {marked && <span className="badge badge-aim inline-flex items-center gap-1"><Sparkles size={12} aria-hidden="true" />{t('flow.ai')}</span>}
        {!folded && <span className="hidden text-[12px] text-muted sm:inline">{meta}</span>}
      </div>
      {unreachable && (
        <p className="ml-8 mt-1 flex items-center gap-1.5 text-[12px] text-warn">
          <AlertTriangle size={13} aria-hidden="true" />{t('flow.unreachable')}
        </p>
      )}
      <RuleLines logic={logic} open={open} folded={folded} onClose={onClose} onOpen={(at) => onOpen({ questionId, at })} />
      {!statement && (
        <button type="button" onClick={() => onOpen({ questionId, at: logic.addRule() })}
          className="btn btn-ghost btn-sm ml-6 mt-1 pointer-fine:opacity-0 pointer-fine:focus:opacity-100 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100">
          <Plus size={14} aria-hidden="true" />{t('logic.addRule')}
        </button>
      )}
    </li>
  )
}
