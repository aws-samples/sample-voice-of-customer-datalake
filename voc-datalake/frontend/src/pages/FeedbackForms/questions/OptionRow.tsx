/**
 * @fileoverview One option of a choice question in the Labels view (UX §4.1): the grip (drag), the label (named
 * "Option 3"; Enter adds an option below, Backspace in an empty one deletes it), the jump marker ("→ 2"), the code
 * column when codes are shown (checked as you type, locked once there are responses), and its ⋯ menu. Pasting
 * several lines into one label offers to make them options.
 *
 * The row is a grid whose jump-marker column is reserved on every row, jump or not, so the labels of one question
 * line up at one width.
 *
 * @module pages/FeedbackForms/questions/OptionRow
 */
import { useState } from 'react'
import type { ClipboardEvent, DragEvent, KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { ArrowDown, ArrowUp, Copy, GripVertical, Trash2 } from 'lucide-react'
import { TruncatedText } from '../../../components/Tooltip/TruncatedText'
import { codeProblem, isReservedCode } from '../model/codes'
import ActionsMenu from '../ui/ActionsMenu'
import { FieldProblems } from './fields'
import CodeCell from './CodeCell'
import type { ListRowProps } from './listRowProps'
import { moveOnArrowKeys } from '../../../lib/reorderKeys'

export interface OptionRowProps extends ListRowProps {
  /** The question number a jump goes to ("→ 2"), or an ending's title; null: no jump. */
  readonly jump: string | null
  readonly onRemoveEmpty: () => void
  readonly onDuplicate: () => void
  readonly onPasteLines: (lines: readonly string[]) => void
  readonly drag: { readonly onDragStart: () => void; readonly onDrop: () => void; readonly over: boolean; readonly onDragOver: () => void }
}

/** The `problems.<code>` key of each way a hand-typed option code is wrong. */
const CODE_PROBLEMS = { reserved: 'reservedCode', invalid: 'invalidCode', taken: 'duplicateCode', '': '' } as const

function PastePrompt({ lines, onAdd, onKeep }: Readonly<{ lines: readonly string[]; onAdd: () => void; onKeep: () => void }>) {
  const { t } = useTranslation('feedbackForms')
  return (
    <div role="group" className="mt-1 flex flex-wrap items-center gap-2 rounded-md border border-border bg-bg-accent p-2 text-[12px] text-text">
      <span>{t('choice.pasteAsOptions', { count: lines.length })}</span>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onAdd}>{t('choice.addAsOptions')}</button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onKeep}>{t('choice.keepAsOne')}</button>
    </div>
  )
}

export default function OptionRow(props: OptionRowProps) {
  const { index, total, label, code, locked, showCodes, jump, problems, inputRef, drag } = props
  const { t } = useTranslation('feedbackForms')
  const [pasted, setPasted] = useState<readonly string[] | null>(null)
  const number = index + 1
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); props.onEnter(); return }
    if (event.key === 'Backspace' && label === '' && total > 1) { event.preventDefault(); props.onRemoveEmpty() }
  }
  const onRowKey = (event: KeyboardEvent<HTMLLIElement>) => { moveOnArrowKeys(event, index, total, props.onMove) }
  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const lines = event.clipboardData.getData('text').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
    if (lines.length < 2) return
    event.preventDefault()
    setPasted(lines)
  }
  const problemsId = `option-${String(number)}-problems`
  return (
    <li onKeyDown={onRowKey} onDragOver={(event: DragEvent<HTMLLIElement>) => { event.preventDefault(); drag.onDragOver() }}
      onDrop={(event) => { event.preventDefault(); drag.onDrop() }} className={clsx(drag.over && 'shadow-[0_-2px_0_0_var(--accent)]')}>
      <div className={clsx('grid items-center gap-1.5', showCodes ? 'grid-cols-[auto_minmax(0,1fr)_2.5rem_auto_auto]' : 'grid-cols-[auto_minmax(0,1fr)_2.5rem_auto]')}>
        <span draggable onDragStart={drag.onDragStart} aria-hidden="true" className="cursor-grab text-muted"><GripVertical size={14} /></span>
        <input ref={inputRef} className="input min-w-0" aria-label={t('choice.optionN', { number })} value={label}
          aria-invalid={problems.some((p) => p.severity === 'error') ? true : undefined}
          aria-describedby={problems.length === 0 ? undefined : problemsId}
          onChange={(event) => props.onLabel(event.target.value)} onKeyDown={onKey} onPaste={onPaste} />
        {/* (the column stays when there is no jump, so every label is the same width; `role="img"` because a name
            on a plain span is not read out, and "→ 2" alone says little) */}
        <span className="min-w-0 text-[12px] text-muted">
          {jump !== null && (
            <span role="img" className="block" aria-label={t('choice.goesTo', { target: jump })}>
              <TruncatedText as="span" className="block truncate" text={`→ ${jump}`} />
            </span>
          )}
        </span>
        {showCodes && <CodeCell code={code} name={t('choice.codeOf', { number })} locked={locked} lockedText={t('choice.codeLocked')}
          problemOf={(typed) => CODE_PROBLEMS[codeProblem(typed, props.otherCodes, isReservedCode)]} onCode={props.onCode} />}
        <ActionsMenu label={t('choice.optionMenu', { number })} items={[
          { label: t('questionList.moveUp'), icon: ArrowUp, onSelect: () => props.onMove(index - 1), disabledReason: index === 0 ? t('questionList.alreadyFirst') : undefined },
          { label: t('questionList.moveDown'), icon: ArrowDown, onSelect: () => props.onMove(index + 1), disabledReason: index === total - 1 ? t('questionList.alreadyLast') : undefined },
          { label: t('questionList.duplicate'), icon: Copy, onSelect: props.onDuplicate },
          null,
          { label: t('questionList.delete'), icon: Trash2, danger: true, onSelect: props.onDelete, disabledReason: total <= 1 ? t('choice.lastOption') : undefined },
        ]} />
      </div>
      <FieldProblems id={problemsId} problems={problems} />
      {pasted !== null && (
        <PastePrompt lines={pasted} onAdd={() => { props.onPasteLines(pasted); setPasted(null) }}
          onKeep={() => { props.onLabel(`${label}${pasted.join(' ')}`); setPasted(null) }} />
      )}
    </li>
  )
}
