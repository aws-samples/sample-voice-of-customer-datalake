/**
 * @fileoverview What the Skills screens' approval cards share (SkillActions.tsx, SkillBenchmarkForm.tsx): the version
 * an action is on, a labelled field, the optional reason, and the line that says how an action failed (it changed
 * since it was opened, or the server's own words).
 *
 * @module pages/Agents/SkillActionParts
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'
import type { ActionFailure } from './useSkillAction'
import type { SkillRole, SkillVersionDetail } from '../../api/engineeringSkillsApi'

export interface ActionTarget {
  connection: string
  role: SkillRole
  detail: SkillVersionDetail
  /** The scope's current version as the screen read it (0: none). */
  current: number
  /** The shared skill's current version, which a connection with none of its own runs (0: none, or the shared scope). */
  sharedCurrent: number
}

export function ActionFailureLine({ failure }: Readonly<{ failure: ActionFailure }>) {
  const { t } = useTranslation('agents')
  if (failure === null) return null
  return (
    <p role="alert" className="mt-3 text-sm text-danger">
      {failure.kind === 'changed' ? t('skills.actions.changed') : t('skills.actions.refused', { message: failure.message })}
    </p>
  )
}

/** A label above its control: `children` renders the control with the id the label names. */
export function Field({ label, children }: Readonly<{ label: string; children: (id: string) => ReactNode }>) {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="block text-[12px] font-semibold text-muted">{label}</label>
      {children(id)}
    </div>
  )
}

export function ReasonField({ value, onChange }: Readonly<{ value: string; onChange: (value: string) => void }>) {
  const { t } = useTranslation('agents')
  return (
    <Field label={t('skills.actions.reason')}>{(id) => (
      <textarea id={id} className="input w-full" rows={2} maxLength={2000} value={value} onChange={(e) => onChange(e.target.value)} />
    )}</Field>
  )
}
