/**
 * @fileoverview One row, or one column, of a matrix in its editor (7.61.00): the label (named "Row 2"; Enter adds one
 * below), a column's optional score, the code when codes are shown (checked as you type, locked once there are
 * responses), and its ⋯ menu (move up or down, delete). Alt+Shift+↑/↓ moves it.
 *
 * @module pages/FeedbackForms/questions/MatrixItemRow
 */
import type { KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react'
import { codeProblem, isReservedMatrixCode } from '../model/codes'
import ActionsMenu from '../ui/ActionsMenu'
import { moveOnArrowKeys } from '../../../lib/reorderKeys'
import { FieldProblems } from './fields'
import { numberOrUndefined } from './fieldHelpers'
import CodeCell from './CodeCell'
import type { ListRowProps } from './listRowProps'

export interface MatrixItemRowProps extends ListRowProps {
  readonly kind: 'row' | 'column'
  /** A column's score (absent: a row, which has none). */
  readonly score?: { readonly value: number | undefined; readonly onChange: (score: number | undefined) => void }
  /** Why it cannot be deleted (the list's minimum), or undefined. */
  readonly deleteBlocked?: string
}

/** The row's grid: the number, the label, a score and a code when shown, the menu. */
const GRIDS = ['grid-cols-[auto_minmax(0,1fr)_auto]', 'grid-cols-[auto_minmax(0,1fr)_auto_auto]', 'grid-cols-[auto_minmax(0,1fr)_auto_auto_auto]']

/** The `problems.<code>` key of each way a typed row or column code is wrong. */
const CODE_PROBLEMS = { reserved: 'matrixCodeReserved', invalid: 'matrixCodeInvalid', taken: 'matrixCodeTwice', '': '' } as const

function ScoreField({ number, value, onChange, invalid }: Readonly<{ number: number; value: number | undefined; onChange: (score: number | undefined) => void; invalid: boolean }>) {
  const { t } = useTranslation('feedbackForms')
  return (
    <input type="number" step={1} min={-100} max={100} className="input w-20 font-mono text-[12px]" aria-label={t('matrix.scoreOf', { number })}
      placeholder={t('matrix.score')} value={value ?? ''} aria-invalid={invalid ? true : undefined}
      onChange={(event) => onChange(numberOrUndefined(event.target.value))} />
  )
}

export default function MatrixItemRow(props: MatrixItemRowProps) {
  const { kind, index, total, label, code, locked, showCodes, problems, score, inputRef, otherCodes, deleteBlocked } = props
  const { onLabel, onCode, onEnter, onMove, onDelete } = props
  const { t } = useTranslation('feedbackForms')
  const number = index + 1
  const problemsId = `matrix-${kind}-${String(number)}-problems`
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); onEnter() }
  }
  const extras = (score === undefined ? 0 : 1) + (showCodes ? 1 : 0)
  return (
    <li onKeyDown={(event) => moveOnArrowKeys(event, index, total, onMove)}>
      <div className={clsx('grid items-center gap-1.5', GRIDS[extras])}>
        <span aria-hidden="true" className="w-5 text-right font-mono text-[12px] text-muted">{number}</span>
        <input ref={inputRef} className="input min-w-0" aria-label={t(`matrix.${kind}N`, { number })} value={label}
          aria-invalid={problems.some((p) => p.severity === 'error') ? true : undefined}
          aria-describedby={problems.length === 0 ? undefined : problemsId}
          onChange={(event) => onLabel(event.target.value)} onKeyDown={onKey} />
        {score !== undefined && <ScoreField number={number} value={score.value} onChange={score.onChange}
          invalid={problems.some((p) => p.at.field === 'column_score')} />}
        {showCodes && <CodeCell code={code} name={t(`matrix.codeOf.${kind}`, { number })} locked={locked} lockedText={t('matrix.codeLocked')}
          problemOf={(typed) => CODE_PROBLEMS[codeProblem(typed, otherCodes, isReservedMatrixCode)]} onCode={onCode} />}
        <ActionsMenu label={t(`matrix.menu.${kind}`, { number })} items={[
          { label: t('questionList.moveUp'), icon: ArrowUp, onSelect: () => onMove(index - 1), disabledReason: index === 0 ? t('questionList.alreadyFirst') : undefined },
          { label: t('questionList.moveDown'), icon: ArrowDown, onSelect: () => onMove(index + 1), disabledReason: index === total - 1 ? t('questionList.alreadyLast') : undefined },
          null,
          { label: t('questionList.delete'), icon: Trash2, danger: true, onSelect: onDelete, disabledReason: deleteBlocked },
        ]} />
      </div>
      <FieldProblems id={problemsId} problems={problems} />
    </li>
  )
}
