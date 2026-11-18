/**
 * @fileoverview One option of a choice question in the Labels view (UX §4.1): the grip (drag), the label (named
 * "Option 3"; Enter adds an option below, Backspace in an empty one deletes it), the jump marker ("→ 2"), the code
 * column when codes are shown (checked as you type, locked once there are responses), and its ⋯ menu. Pasting
 * several lines into one label offers to make them options.
 *
 * @module pages/FeedbackForms/questions/OptionRow
 */
import { useState } from 'react'
import type { ClipboardEvent, DragEvent, KeyboardEvent, Ref } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { ArrowDown, ArrowUp, Copy, GripVertical, Lock, Trash2 } from 'lucide-react'
import { InfoTip } from '../../../components/Tooltip/InfoTip'
import { isReservedCode, isValidCode } from '../model/codes'
import type { FormProblem } from '../model/validateForm'
import ActionsMenu from '../ui/ActionsMenu'
import { FieldProblems } from './fields'
import { moveOnArrowKeys } from '../../../lib/reorderKeys'

export interface OptionRowProps {
  readonly index: number
  readonly total: number
  readonly label: string
  readonly code: string
  /** Every other option's code (a hand-typed code must not repeat one). */
  readonly otherCodes: readonly string[]
  readonly locked: boolean
  readonly showCodes: boolean
  /** The question number a jump goes to ("→ 2"), or an ending's title; null: no jump. */
  readonly jump: string | null
  readonly problems: readonly FormProblem[]
  readonly inputRef: Ref<HTMLInputElement>
  readonly onLabel: (value: string) => void
  readonly onCode: (value: string) => void
  readonly onEnter: () => void
  readonly onRemoveEmpty: () => void
  readonly onMove: (to: number) => void
  readonly onDuplicate: () => void
  readonly onDelete: () => void
  readonly onPasteLines: (lines: readonly string[]) => void
  readonly drag: { readonly onDragStart: () => void; readonly onDrop: () => void; readonly over: boolean; readonly onDragOver: () => void }
}

/** What is wrong with a hand-typed code ('' when nothing). */
function codeProblem(code: string, others: readonly string[]): 'reservedCode' | 'invalidCode' | 'duplicateCode' | '' {
  if (isReservedCode(code)) return 'reservedCode'
  if (!isValidCode(code)) return 'invalidCode'
  return others.includes(code) ? 'duplicateCode' : ''
}

function CodeCell({ code, otherCodes, locked, number, onCode }: Readonly<{ code: string; otherCodes: readonly string[]; locked: boolean; number: number; onCode: (value: string) => void }>) {
  const { t } = useTranslation('feedbackForms')
  const [typed, setTyped] = useState<string | null>(null)
  const shown = typed ?? code
  const problem = typed === null ? '' : codeProblem(typed, otherCodes)
  const name = t('choice.codeOf', { number })
  if (locked) {
    return (
      <span className="inline-flex items-center gap-1 font-mono text-[12px] text-muted">
        <Lock size={12} aria-hidden="true" /><span aria-label={name}>{code}</span>
        <InfoTip text={t('choice.codeLocked')} />
      </span>
    )
  }
  return (
    <span className="block w-36 shrink-0">
      <input className="input w-full font-mono text-[12px]" aria-label={name} value={shown} aria-invalid={problem === '' ? undefined : true}
        onChange={(event) => setTyped(event.target.value)}
        onBlur={() => {
          if (typed !== null && problem === '' && typed !== code) onCode(typed)
          setTyped(null)
        }} />
      {problem !== '' && <span role="alert" className="mt-0.5 block text-[12px] text-danger">{t(`problems.${problem}`, { code: shown })}</span>}
    </span>
  )
}

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
      <div className="flex items-center gap-1.5">
        <span draggable onDragStart={drag.onDragStart} aria-hidden="true" className="cursor-grab text-muted"><GripVertical size={14} /></span>
        <input ref={inputRef} className="input min-w-0 flex-1" aria-label={t('choice.optionN', { number })} value={label}
          aria-invalid={problems.some((p) => p.severity === 'error') ? true : undefined}
          aria-describedby={problems.length === 0 ? undefined : problemsId}
          onChange={(event) => props.onLabel(event.target.value)} onKeyDown={onKey} onPaste={onPaste} />
        {jump !== null && <span className="shrink-0 text-[12px] text-muted" aria-label={t('choice.goesTo', { target: jump })}>→ {jump}</span>}
        {showCodes && <CodeCell code={code} otherCodes={props.otherCodes} locked={locked} number={number} onCode={props.onCode} />}
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
