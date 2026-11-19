/**
 * @fileoverview The "go to" select of a rule and of an Otherwise (UX §5.2): "Next question" first, then the later
 * questions, numbered, then the endings. Earlier questions are never listed (jumps go forward by construction); a
 * target that became earlier, or was deleted, stays selected so its error shows under the row.
 *
 * @module pages/FeedbackForms/logic/TargetSelect
 */
import { useTranslation } from 'react-i18next'
import type { TargetGroups } from './ruleControls'

export default function TargetSelect({ id, label, value, groups, first, describedBy, onChange }: Readonly<{
  id: string
  /** The accessible name ("Rule 1: go to"). */
  label: string
  value: string
  groups: TargetGroups
  /** An entry before the groups (the Otherwise's "Next question: 2 · …", value ''). */
  first?: { readonly value: string; readonly label: string }
  describedBy?: string
  onChange: (value: string) => void
}>) {
  const { t } = useTranslation('feedbackForms')
  return (
    <select id={id} aria-label={label} aria-describedby={describedBy} value={value}
      className="select select-sm w-auto max-w-[18rem]" onChange={(event) => onChange(event.target.value)}>
      {first !== undefined && <option value={first.value}>{first.label}</option>}
      {groups.invalid !== null && <option value={groups.invalid.value}>{groups.invalid.label}</option>}
      {groups.next.length > 0 && (
        <optgroup label={t('logic.groups.next')}>
          {groups.next.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </optgroup>
      )}
      {groups.later.length > 0 && (
        <optgroup label={t('logic.groups.later')}>
          {groups.later.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </optgroup>
      )}
      {groups.endings.length > 0 && (
        <optgroup label={t('logic.groups.endings')}>
          {groups.endings.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </optgroup>
      )}
    </select>
  )
}
