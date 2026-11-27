/**
 * @fileoverview The editor's labelled fields (UX §3.4): every field is an `.input` with a visible `<label>`; its
 * problems sit under it in `text-danger` with `CircleX`, linked by `aria-describedby`, and its hint in `text-muted`.
 *
 * @module pages/FeedbackForms/questions/fields
 */
import { useId } from 'react'
import type { ReactNode, Ref } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { AlertTriangle, CircleX } from 'lucide-react'
import type { FormProblem } from '../model/validateForm'
import { problemMessage } from '../builder/problemText'

/** The problems of one field, as the problems list words them (`problemMessage`: languages by their names). */
export function FieldProblems({ id, problems }: Readonly<{ id: string; problems: readonly FormProblem[] }>) {
  const { t } = useTranslation('feedbackForms')
  if (problems.length === 0) return null
  return (
    <ul id={id} className="mt-1 space-y-0.5">
      {problems.map((problem) => (
        <li key={`${problem.code}-${JSON.stringify(problem.params)}`}
          className={clsx('flex items-start gap-1 text-[12px]', problem.severity === 'error' ? 'text-danger' : 'text-text')}>
          {problem.severity === 'error'
            ? <CircleX size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
            : <AlertTriangle size={12} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />}
          <span>{problemMessage(t, problem)}</span>
        </li>
      ))}
    </ul>
  )
}

export interface TextFieldProps {
  readonly label: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly placeholder?: string
  readonly required?: boolean
  readonly multiline?: boolean
  /** Show "N / max" from 80 % of the limit. */
  readonly counter?: number
  readonly hint?: ReactNode
  readonly problems?: readonly FormProblem[]
  readonly inputRef?: Ref<HTMLInputElement & HTMLTextAreaElement>
  readonly mono?: boolean
  readonly type?: 'text' | 'url' | 'number'
  /** A control beside the label (recall's "Insert a value" menu). */
  readonly action?: ReactNode
  /** Lines under the field, above its problems (recall's preview). */
  readonly below?: ReactNode
}

function Counter({ value, max }: Readonly<{ value: string; max: number }>) {
  if (value.length < max * 0.8) return null
  return <span className={clsx('font-mono text-[12px] tabular-nums', value.length > max ? 'text-danger' : 'text-muted')}>{value.length} / {max}</span>
}

/** The control's ARIA: required, invalid when an error is on it, described by its hint and its problems. */
function controlAria(id: string, props: Pick<TextFieldProps, 'required' | 'hint' | 'problems'>) {
  const problems = props.problems ?? []
  const described = [props.hint === undefined ? null : `${id}-hint`, problems.length === 0 ? null : `${id}-problems`]
    .filter((part) => part !== null).join(' ')
  return {
    'aria-required': props.required === true ? true : undefined,
    'aria-invalid': problems.some((problem) => problem.severity === 'error') ? true : undefined,
    'aria-describedby': described === '' ? undefined : described,
  }
}

export function TextField(props: TextFieldProps) {
  const { label, value, onChange, placeholder, required = false, multiline = false, counter, hint, problems = [], inputRef, type = 'text' } = props
  const id = useId()
  const hintId = `${id}-hint`
  const problemsId = `${id}-problems`
  const shared = { id, value, placeholder, ...controlAria(id, props), className: clsx('input w-full', props.mono === true && 'font-mono text-[12px]') }
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <label htmlFor={id} className="flex items-center gap-1 text-sm font-medium text-text">
          {label}{required && <span aria-hidden="true">*</span>}
        </label>
        <span className="flex items-center gap-1">
          {counter !== undefined && <Counter value={value} max={counter} />}
          {props.action}
        </span>
      </div>
      {multiline
        ? <textarea {...shared} ref={inputRef} rows={2} className={clsx(shared.className, 'min-h-[2.5rem] resize-y')} onChange={(event) => onChange(event.target.value)} />
        : <input {...shared} ref={inputRef} type={type} onChange={(event) => onChange(event.target.value)} />}
      {hint !== undefined && <p id={hintId} className="mt-1 text-[12px] text-muted">{hint}</p>}
      {props.below}
      <FieldProblems id={problemsId} problems={problems} />
    </div>
  )
}

/** A labelled native select (`.select`). */
export function SelectField<T extends string>({ label, value, options, onChange, hint }: Readonly<{
  label: string
  value: T
  options: readonly { readonly value: T; readonly label: string }[]
  onChange: (value: T) => void
  hint?: ReactNode
}>) {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-text">{label}</label>
      <select id={id} className="select" value={value} aria-describedby={hint === undefined ? undefined : `${id}-hint`}
        onChange={(event) => {
          const next = options.find((option) => option.value === event.target.value)
          if (next !== undefined) onChange(next.value)
        }}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      {hint !== undefined && <p id={`${id}-hint`} className="mt-1 text-[12px] text-muted">{hint}</p>}
    </div>
  )
}

/** A field group's heading row ("Options", "Labels"). */
export function FieldHeading({ children, actions }: Readonly<{ children: ReactNode; actions?: ReactNode }>) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold tracking-tight text-text-strong">{children}</h3>
      {actions}
    </div>
  )
}
