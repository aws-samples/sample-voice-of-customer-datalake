/**
 * @fileoverview The matrix editor (7.61.00, docs/feedback-forms.md "Matrix"): the rows (what is rated, 1 to 20) and
 * the columns (the scale, 2 to 10, each with an optional score Results average per row), then how it shows (Shuffle
 * rows; Auto, Grid or Stacked) and, for an optional matrix, how many rows an answer must cover. A new row's or
 * column's code follows its label until the form is saved (`freshCodes`); a code edited by hand stops following it,
 * and every code locks once the form has responses (answers are stored under them).
 *
 * @module pages/FeedbackForms/questions/MatrixEditor
 */
import { useEffect, useId, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import SwitchField from '../../../components/SwitchField/SwitchField'
import type { MatrixDisplay, MatrixQuestion } from '../model/formsV2'
import { LIMITS, MATRIX_DISPLAYS } from '../model/formsV2'
import { textIn } from '../model/i18nText'
import { updateMatrix } from '../model/mutations'
import { problemsAt } from '../model/validateForm'
import type { FormProblem } from '../model/validateForm'
import { useDraft } from '../builder/formDraftContext'
import Segmented from '../ui/Segmented'
import { FieldHeading, FieldProblems } from './fields'
import { fieldProblems, numberOrUndefined } from './fieldHelpers'
import MatrixItemRow from './MatrixItemRow'
import type { MatrixList } from './matrixOps'
import { followLabel, typedCode } from './freshCodes'
import { matrixFreshKey, withColumnScore, withItemCode, withItemLabel, withItemMoved, withNewItem, withoutItem } from './matrixOps'

const KIND: Readonly<Record<MatrixList, 'row' | 'column'>> = { rows: 'row', columns: 'column' }
const MAX: Readonly<Record<MatrixList, number>> = { rows: LIMITS.matrixRows, columns: LIMITS.matrixColumns }
const MIN: Readonly<Record<MatrixList, number>> = { rows: 1, columns: LIMITS.minMatrixColumns }

function useMatrixEdits(question: MatrixQuestion, list: MatrixList, focusAt: (index: number) => void) {
  const draft = useDraft()
  const { form } = draft
  const id = question.id
  const change = (fn: (q: MatrixQuestion) => MatrixQuestion) => draft.update((current) => updateMatrix(current, id, fn))
  const key = (code: string) => matrixFreshKey(id, list, code)
  return {
    change,
    add: (at: number) => {
      const next = withNewItem(question, list, at, '', form.language)
      const { code } = next
      if (code === null) return
      change(() => next.question)
      draft.setFreshCodes((keys) => new Set([...keys, key(code)]))
      focusAt(at)
    },
    label: (at: number, value: string) => followLabel(draft, key, question[list][at]?.code, (_code, fresh) => {
      const next = withItemLabel(question, list, at, value, form.language, fresh)
      change(() => next.question)
      return next.code
    }),
    code: (at: number, value: string) => typedCode(draft, key, question[list][at]?.code, () => change((q) => withItemCode(q, list, at, value))),
    move: (from: number, to: number) => { change((q) => withItemMoved(q, list, from, to)); focusAt(to) },
    remove: (at: number) => change((q) => withoutItem(q, list, at)),
  }
}

function ItemList({ question, list, showCodes, problems }: Readonly<{
  question: MatrixQuestion; list: MatrixList; showCodes: boolean; problems: readonly FormProblem[]
}>) {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const inputs = useRef<(HTMLInputElement | null)[]>([])
  const pendingFocus = useRef<number | null>(null)
  const edits = useMatrixEdits(question, list, (at) => { pendingFocus.current = at })
  // (after the render that added or moved a row or column: focus the one asked for)
  useEffect(() => {
    if (pendingFocus.current === null) return
    inputs.current[pendingFocus.current]?.focus()
    pendingFocus.current = null
  })
  const kind = KIND[list]
  const items = question[list]
  const codes = items.map((item) => item.code)
  const full = items.length >= MAX[list]
  return (
    <section className="space-y-2" aria-label={t(`matrix.${list}`)}>
      <FieldHeading actions={<span className="font-mono text-[12px] tabular-nums text-muted">{t('choice.count', { n: items.length, max: MAX[list] })}</span>}>
        {t(`matrix.${list}`)}
      </FieldHeading>
      {list === 'columns' && <p className="text-[12px] text-muted">{t('matrix.scoreHint')}</p>}
      <ol className="space-y-1.5" aria-label={t(`matrix.${list}`)}>
        {items.map((item, at) => (
          <MatrixItemRow key={String(at)} kind={kind} index={at} total={items.length} label={textIn(item.label, draft.form.language)} code={item.code}
            otherCodes={codes.filter((_code, other) => other !== at)} locked={draft.locked} showCodes={showCodes}
            score={list === 'columns' ? { value: question.columns[at]?.score, onChange: (score) => edits.change((q) => withColumnScore(q, at, score)) } : undefined}
            deleteBlocked={items.length <= MIN[list] ? t(`matrix.last.${list}`) : undefined}
            problems={problems.filter((p) => p.at.optionIndex === at && (p.at.field ?? '').startsWith(kind))}
            inputRef={(element) => { inputs.current[at] = element }}
            onLabel={(value) => edits.label(at, value)} onCode={(value) => edits.code(at, value)} onEnter={() => edits.add(at + 1)}
            onMove={(to) => edits.move(at, to)} onDelete={() => edits.remove(at)} />
        ))}
      </ol>
      <FieldProblems id={`${question.id}-${list}-problems`} problems={fieldProblems(problems, list)} />
      <button type="button" className="btn btn-secondary btn-sm" aria-disabled={full ? true : undefined} onClick={() => { if (!full) edits.add(items.length) }}>
        <Plus size={14} aria-hidden="true" />{t(`matrix.add.${list}`)}
      </button>
    </section>
  )
}

function MinRows({ question, problems, onChange }: Readonly<{ question: MatrixQuestion; problems: readonly FormProblem[]; onChange: (q: MatrixQuestion) => void }>) {
  const { t } = useTranslation('feedbackForms')
  const id = useId()
  const own = fieldProblems(problems, 'min_rows')
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-[13px] text-text">{t('matrix.minRows')}
        <input id={id} type="number" min={1} max={question.rows.length} className="input ml-2 w-20" value={question.min_rows ?? ''}
          aria-invalid={own.length > 0 ? true : undefined} aria-describedby={`${id}-hint ${id}-problems`}
          onChange={(event) => onChange({ ...question, min_rows: numberOrUndefined(event.target.value) })} />
      </label>
      <p id={`${id}-hint`} className="text-[12px] text-muted">{t('matrix.minRowsHint')}</p>
      <FieldProblems id={`${id}-problems`} problems={own} />
    </div>
  )
}

export default function MatrixEditor({ question, showCodes, onChange }: Readonly<{
  question: MatrixQuestion
  showCodes: boolean
  onChange: (q: MatrixQuestion) => void
}>) {
  const { t } = useTranslation('feedbackForms')
  const draft = useDraft()
  const problems = problemsAt(draft.problems, 'question', question.id)
  return (
    <div className="space-y-4">
      <ItemList question={question} list="rows" showCodes={showCodes} problems={problems} />
      <ItemList question={question} list="columns" showCodes={showCodes} problems={problems} />
      <div className="space-y-3 border-t border-border pt-3">
        <SwitchField checked={question.shuffle_rows} label={t('matrix.shuffleRows')} hint={t('matrix.shuffleRowsHint')}
          onChange={(shuffle) => onChange({ ...question, shuffle_rows: shuffle })} />
        <div className="space-y-1">
          <Segmented label={t('choice.showAs')} value={question.display} onChange={(display: MatrixDisplay) => onChange({ ...question, display })}
            choices={MATRIX_DISPLAYS.map((value) => ({ value, label: t(`matrix.display.${value}`) }))} />
          <p className="text-[12px] text-muted">{t(`matrix.displayHint.${question.display}`)}</p>
        </div>
        {!question.required && <MinRows question={question} problems={problems} onChange={onChange} />}
      </div>
    </div>
  )
}
