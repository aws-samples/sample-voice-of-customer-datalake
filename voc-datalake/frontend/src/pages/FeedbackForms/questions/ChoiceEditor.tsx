/**
 * @fileoverview The choice editor (UX §4.1) for single and multiple choice: Labels | Routing, the options (drag,
 * Alt+Shift+↑/↓, ⋯; Enter adds one below, Backspace on an empty one deletes it; "6 of 50"), Paste list, and the
 * question's choice settings (ChoiceSettings). A new option's code follows its label until the form is saved
 * (`freshCodes`); a code edited by hand stops following it.
 *
 * @module pages/FeedbackForms/questions/ChoiceEditor
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ClipboardPaste, Plus } from 'lucide-react'
import { useCategoriesConfig } from '../../../hooks/useCategories'
import type { ChoiceQuestion, FormV2 } from '../model/formsV2'
import { LIMITS } from '../model/formsV2'
import { codeFromLabel } from '../model/codes'
import { textIn } from '../model/i18nText'
import { moved, renameOptionCode, updateChoice } from '../model/mutations'
import { problemsAt } from '../model/validateForm'
import { useDraft } from '../builder/formDraftContext'
import Segmented from '../ui/Segmented'
import OptionRow from './OptionRow'
import PasteOptions from './PasteOptions'
import ChoiceRouting from './ChoiceRouting'
import ChoiceSettings from './ChoiceSettings'
import { FieldHeading, FieldProblems } from './fields'
import { freshKey, optionJump, optionLabels, withNewOptions, withOptionLabel } from './choiceOps'

type View = 'labels' | 'routing'

/** "→ 2" for a jump to question 2, "→ Thank you" for an ending; null without one. */
function jumpLabel(form: FormV2, question: ChoiceQuestion, code: string): string | null {
  const jump = optionJump(question, code)
  if (jump.kind !== 'own') return null
  const at = form.questions.findIndex((q) => q.id === jump.target)
  if (at !== -1) return String(at + 1)
  return textIn(form.endings.find((e) => e.id === jump.target)?.title, form.language)
}

function useOptionEdits(question: ChoiceQuestion, focusAt: (index: number) => void) {
  const draft = useDraft()
  const { form } = draft
  const id = question.id
  const change = (fn: (q: ChoiceQuestion) => ChoiceQuestion) => draft.update((current) => updateChoice(current, id, fn))
  const markFresh = (codes: readonly string[]) => draft.setFreshCodes((keys) => new Set([...keys, ...codes.map((code) => freshKey(id, code))]))
  const insert = (at: number, labels: readonly string[]) => {
    const next = withNewOptions(question, at, labels, form.language)
    change(() => next.question)
    markFresh(next.codes)
    return next.codes.length
  }
  return {
    change,
    insert,
    label: (at: number, value: string) => {
      const option = question.options[at]
      if (option === undefined) return
      const fresh = draft.freshCodes.has(freshKey(id, option.code))
      const next = withOptionLabel(form, id, option.code, value, fresh)
      draft.update(() => next.form)
      if (next.code !== option.code) {
        draft.setFreshCodes((keys) => new Set([...[...keys].filter((key) => key !== freshKey(id, option.code)), freshKey(id, next.code)]))
      }
    },
    code: (at: number, value: string) => {
      const option = question.options[at]
      if (option === undefined) return
      draft.update((current) => renameOptionCode(current, id, option.code, value))
      draft.setFreshCodes((keys) => new Set([...keys].filter((key) => key !== freshKey(id, option.code))))
    },
    remove: (at: number) => change((q) => ({ ...q, options: q.options.filter((_option, index) => index !== at) })),
    move: (from: number, to: number) => { change((q) => ({ ...q, options: moved(q.options, from, to) })); focusAt(to) },
    duplicate: (at: number) => {
      const option = question.options[at]
      if (option === undefined || question.options.length >= LIMITS.options) return
      const code = codeFromLabel(textIn(option.label, form.language), new Set(question.options.map((o) => o.code)))
      change((q) => ({ ...q, options: [...q.options.slice(0, at + 1), { ...option, code }, ...q.options.slice(at + 1)] }))
      markFresh([code])
    },
    pasteLines: (at: number, lines: readonly string[]) => {
      const option = question.options[at]
      const replaceEmpty = option !== undefined && textIn(option.label, form.language) === ''
      const base = replaceEmpty ? { ...question, options: question.options.filter((_option, index) => index !== at) } : question
      const next = withNewOptions(base, replaceEmpty ? at : at + 1, lines, form.language)
      change(() => next.question)
      markFresh(next.codes)
    },
    replaceAll: (labels: readonly string[]) => {
      const next = withNewOptions({ ...question, options: [] }, 0, labels, form.language)
      change(() => next.question)
      markFresh(next.codes)
    },
  }
}

export default function ChoiceEditor({ question, index, showCodes, onEditLogic }: Readonly<{
  question: ChoiceQuestion
  index: number
  showCodes: boolean
  /** Open the question's Logic section (an option a broader rule routes). */
  onEditLogic: () => void
}>) {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const { form } = draft
  const categories = useCategoriesConfig().data?.categories ?? []
  const [view, setView] = useState<View>('labels')
  const [pasting, setPasting] = useState(false)
  const inputs = useRef<(HTMLInputElement | null)[]>([])
  const pendingFocus = useRef<number | null>(null)
  const setFocusIndex = (at: number) => { pendingFocus.current = at }
  const edits = useOptionEdits(question, setFocusIndex)
  // (after the render that added, removed or moved the option: focus the one asked for)
  useEffect(() => {
    if (pendingFocus.current === null) return
    inputs.current[pendingFocus.current]?.focus()
    pendingFocus.current = null
  })
  const [drag, setDrag] = useState<{ from: number; over: number | null } | null>(null)
  const problems = problemsAt(draft.problems, 'question', question.id)
  const full = question.options.length >= LIMITS.options
  const codes = question.options.map((o) => o.code)
  const add = (at: number) => { if (!full) { edits.insert(at, ['']); setFocusIndex(at) } }
  return (
    <section className="space-y-3" aria-label={t('choice.options')}>
      <FieldHeading actions={(
        <span className="flex flex-wrap items-center gap-2">
          <Segmented label={t('choice.view')} value={view} onChange={setView}
            choices={[{ value: 'labels', label: t('choice.labels') }, { value: 'routing', label: t('choice.routing.title') }]} />
          {view === 'labels' && (
            <button type="button" className="btn btn-secondary btn-sm" aria-expanded={pasting} onClick={() => setPasting(!pasting)}>
              <ClipboardPaste size={14} aria-hidden="true" />{t('choice.pasteList')}
            </button>
          )}
        </span>
      )}>{t('choice.options')}</FieldHeading>
      {view === 'routing' ? (
        <ChoiceRouting form={form} question={question} index={index} categories={categories}
          onChange={(next) => edits.change(() => next)} onEditLogic={onEditLogic} />
      ) : (
        <>
          {pasting && (
            <PasteOptions existing={optionLabels(question, form.language)} locked={draft.locked}
              onAdd={(labels) => { edits.insert(question.options.length, labels); setPasting(false) }}
              onReplace={(labels) => { edits.replaceAll(labels); setPasting(false) }} onClose={() => setPasting(false)} />
          )}
          <ol className="space-y-1.5" aria-label={t('choice.options')}>
            {question.options.map((option, at) => (
              <OptionRow key={String(at)} index={at} total={question.options.length} label={textIn(option.label, form.language)}
                code={option.code} otherCodes={codes.filter((_code, other) => other !== at)} locked={draft.locked} showCodes={showCodes}
                jump={jumpLabel(form, question, option.code)}
                problems={problems.filter((p) => p.at.optionIndex === at && (p.at.field === 'option' || p.at.field === 'code'))}
                inputRef={(element) => { inputs.current[at] = element }}
                onLabel={(value) => edits.label(at, value)} onCode={(value) => edits.code(at, value)}
                onEnter={() => add(at + 1)} onRemoveEmpty={() => { edits.remove(at); setFocusIndex(Math.max(0, at - 1)) }}
                onMove={(to) => edits.move(at, to)} onDuplicate={() => edits.duplicate(at)} onDelete={() => edits.remove(at)}
                onPasteLines={(lines) => edits.pasteLines(at, lines)}
                drag={{
                  onDragStart: () => setDrag({ from: at, over: null }),
                  onDragOver: () => setDrag((current) => (current === null ? null : { ...current, over: at })),
                  onDrop: () => {
                    if (drag !== null && drag.from !== at) edits.move(drag.from, at)
                    setDrag(null)
                  },
                  over: drag !== null && drag.over === at && drag.from !== at,
                }} />
            ))}
          </ol>
          <FieldProblems id={`${question.id}-options-problems`} problems={problems.filter((p) => p.at.field === 'options')} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button type="button" className="btn btn-secondary btn-sm" aria-disabled={full ? true : undefined} onClick={() => add(question.options.length)}>
              <Plus size={14} aria-hidden="true" />{t('choice.addOption')}
            </button>
            <span className="font-mono text-[12px] tabular-nums text-muted">{t('choice.count', { n: question.options.length, max: LIMITS.options })}</span>
          </div>
        </>
      )}
      <ChoiceSettings question={question} onChange={(next) => edits.change(() => next)} />
    </section>
  )
}
