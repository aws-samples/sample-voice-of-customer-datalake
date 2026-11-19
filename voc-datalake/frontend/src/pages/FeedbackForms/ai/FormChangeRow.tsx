/**
 * @fileoverview One change from the AI (UX §12.2): its checkbox ("Apply: Added question 2"), the kind as text with
 * +, − or ~, the number, the type icon and the headline; ▸ / ▾ shows each changed field before → after (rules as
 * sentences). A change that depends on another says what goes with it; one that brings in an address waits for
 * "I've checked this address".
 *
 * @module pages/FeedbackForms/ai/FormChangeRow
 */
import { createElement, useId } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { ChevronDown, ChevronRight, EyeOff, Flag, Hand, Languages } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { FormV2 } from '../model/formsV2'
import type { FormChange } from '../model/formDiff'
import { questionIcon } from '../ui/typeIcons'
import { applyLabel, fieldName, headlineOf, numberOf, questionOf, ruleLines, changeSource, valueText } from './changeText'

const SIGNS = { added: '+', removed: '−', changed: '~' } as const

const AREA_ICONS: Readonly<Record<Exclude<FormChange['area'], 'question'>, LucideIcon>> = {
  ending: Flag, hidden: EyeOff, language: Languages, welcome: Hand,
}

function iconOf(change: FormChange, before: FormV2, after: FormV2): LucideIcon {
  if (change.area !== 'question') return AREA_ICONS[change.area]
  const question = questionOf(change, before, after)
  return question === undefined ? Flag : questionIcon(question)
}

function FieldChanges({ change, before, after }: Readonly<{ change: FormChange; before: FormV2; after: FormV2 }>) {
  const { t } = useTranslation('feedbackForms')
  const form = changeSource(change, before, after)
  return (
    <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 gap-y-1.5 text-[13px]">
      {change.fields.map((field) => (
        <div key={field.field} className="contents">
          <dt className="text-[12px] font-medium text-muted">{fieldName(t, field.field)}</dt>
          <dd className="min-w-0 space-y-0.5 break-words">
            {field.field === 'logic'
              ? ruleLines(t, field, change, before, after).map((line) => <p key={line} className="text-text">{line}</p>)
              : (
                <>
                  <p className="text-muted line-through decoration-muted/60"><span className="sr-only">{t('ai.diff.before')}: </span>{valueText(t, before, field.before, field.field)}</p>
                  <p className="text-text-strong"><span className="sr-only">{t('ai.diff.after')}: </span>{valueText(t, form, field.after, field.field)}</p>
                </>
              )}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export interface ChangeRowProps {
  readonly change: FormChange
  readonly before: FormV2
  readonly after: FormV2
  readonly accepted: boolean
  readonly onAccept: (accepted: boolean) => void
  readonly expanded: boolean
  readonly onExpand: (expanded: boolean) => void
  readonly checked: ReadonlySet<string>
  readonly onCheck: (url: string, checked: boolean) => void
  /** What goes with this change when it is rejected ("Not applied with it: the rule on 1."), if anything. */
  readonly dependency: string | null
}

function AddressChecks({ change, accepted, checked, onCheck }: Readonly<Pick<ChangeRowProps, 'change' | 'accepted' | 'checked' | 'onCheck'>>) {
  const { t } = useTranslation('feedbackForms')
  const waiting = change.addresses.some((address) => !checked.has(address.url))
  return (
    <div className="space-y-1">
      {change.addresses.map((address) => (
        <label key={address.url} className="flex flex-wrap items-center gap-2 text-[13px] text-text">
          <input type="checkbox" checked={checked.has(address.url)} onChange={(event) => onCheck(address.url, event.target.checked)} />
          <span className="font-mono text-[12px] break-all">{address.url}</span>
          <span>{t('ai.diff.checkAddress')}</span>
        </label>
      ))}
      {accepted && waiting && <p className="text-[12px] text-warn">{t('ai.diff.addressWaits')}</p>}
    </div>
  )
}

export default function FormChangeRow(props: ChangeRowProps) {
  const { change, before, after, accepted, onAccept, expanded, onExpand, dependency } = props
  const { t } = useTranslation('feedbackForms')
  const id = useId()
  const number = numberOf(change, before, after)
  const expandLabel = expanded ? t('ai.diff.collapse') : t('ai.diff.expand')
  return (
    <li className={clsx('space-y-2 rounded-md border border-border p-3', accepted ? 'bg-card' : 'bg-bg-accent')} data-testid={`change-${change.key}`}>
      <div className="flex items-start gap-2">
        <input id={id} type="checkbox" className="mt-1" checked={accepted} onChange={(event) => onAccept(event.target.checked)}
          aria-label={applyLabel(t, change, before, after)} />
        <label htmlFor={id} className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
          <span className="font-medium text-text-strong"><span aria-hidden="true">{SIGNS[change.kind]} </span>{t(`ai.diff.kinds.${change.kind}`)}</span>
          {number !== null && <span className="tabular-nums text-muted">{number}</span>}
          {createElement(iconOf(change, before, after), { size: 14, className: 'shrink-0 text-muted', 'aria-hidden': true })}
          <span className="min-w-0 text-text">{headlineOf(t, change, before, after)}</span>
          {!accepted && <span className="text-[12px] text-muted">{t('ai.diff.notApplied')}</span>}
        </label>
        {change.fields.length > 0 && (
          <button title={expandLabel} type="button" className="icon-btn" aria-label={expandLabel} aria-expanded={expanded} onClick={() => onExpand(!expanded)}>
            {expanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
          </button>
        )}
      </div>
      {expanded && <div className="pl-6"><FieldChanges change={change} before={before} after={after} /></div>}
      {!accepted && dependency !== null && <p className="pl-6 text-[12px] text-text">{dependency}</p>}
      {change.addresses.length > 0 && <div className="pl-6"><AddressChecks {...props} /></div>}
    </li>
  )
}
