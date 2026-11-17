/**
 * @fileoverview A step's assertions, on every kind that takes them (7.52.00 C2; docs/ux part 5 §5.4 N4): what the
 * board checks of what the step recorded (`params.assert`, `[{check, args?, on_fail?}]`). Building, each is edited
 * from the closed vocabulary (`GET …/assertions`): only the checks this kind is checked on (`kinds`), each with its
 * arguments (a role, a number in its bounds) and the `on_fail` this place allows (`fail_arrow` on a gate only), at most
 * the vocabulary's `max`. Viewing, they are a list. In a run, each with what the board recorded (pass, fail,
 * pending), from the run's assertions.
 *
 * @module components/WorkflowEditor/inspector/AssertionsField
 */
import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { assertionsOf } from './assertions'
import type { StepAssertion } from './assertions'
import { Tooltip } from '../../Tooltip/Tooltip'
import { useAssertionVocabulary } from './useFlowSetup'
import type { TFunction } from 'i18next'
import type { AssertionCheck, AssertionVocabulary } from '../../../api/flowSetupApi'
import type { RunAssertion } from '../../../api/engineeringRunWorkspaceApi'
import type { FlowMode } from '../nodes/nodeData'

const RESULT_TONE: Readonly<Record<string, string>> = {
  pass: 'badge badge-ok', fail: 'badge badge-danger', pending: 'badge badge-muted', unread: 'badge badge-warn',
}

/** A check's words: its label (in the person's language where the catalogue has it, else what it asks). */
function checkLabel(t: TFunction<'agents'>, check: string, entry: AssertionCheck | undefined): string {
  return t(`inspector.assertions.checks.${check.replace(/\./g, '_')}`, { defaultValue: entry?.asks ?? check })
}

/** An assertion's arguments in words ("by: commit reviewer · min: 2"). */
function argsText(assertion: StepAssertion): string {
  return Object.entries(assertion.args ?? {}).map(([name, value]) => `${name}: ${String(value)}`).join(' · ')
}

/** The first value each argument takes (a role: the first role; a number: its least). */
function defaultArgs(entry: AssertionCheck, roles: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(entry.args.map((arg) => [arg.name, arg.type === 'role' ? roles[0] ?? '' : arg.minimum ?? 1]))
}

function ArgField({ name, type, value, roles, minimum, maximum, onChange }: Readonly<{
  name: string; type: string; value: unknown; roles: readonly string[]; minimum: number | null; maximum: number | null
  onChange: (value: unknown) => void
}>) {
  const { t } = useTranslation('agents')
  const label = t('inspector.assertions.argument', { name })
  if (type === 'role') {
    return (
      <select aria-label={label} className="select select-sm" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
        {roles.map((role) => <option key={role} value={role}>{t(`skills.role.${role}`, { defaultValue: role })}</option>)}
      </select>
    )
  }
  return (
    <input aria-label={label} type="number" className="input w-24" min={minimum ?? 1} max={maximum ?? undefined}
      value={typeof value === 'number' ? value : ''}
      onChange={(e) => onChange(Math.max(minimum ?? 1, Math.min(maximum ?? Number.MAX_SAFE_INTEGER, Math.trunc(Number(e.target.value)) || 1)))} />
  )
}

function EditRow({ assertion, entry, vocabulary, onChange, onRemove }: Readonly<{
  assertion: StepAssertion; entry: AssertionCheck | undefined; vocabulary: AssertionVocabulary
  onChange: (next: StepAssertion) => void; onRemove: () => void
}>) {
  const { t } = useTranslation('agents')
  const label = checkLabel(t, assertion.check, entry)
  return (
    <li className="space-y-1.5 rounded-md border border-border p-2">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-[13px] text-text">{label}</span>
        <Tooltip kind="label" content={t('inspector.assertions.remove', { check: label })}>
          <button type="button" className="icon-btn" aria-label={t('inspector.assertions.remove', { check: label })} onClick={onRemove}>
            <Trash2 size={14} aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {(entry?.args ?? []).map((arg) => (
          <ArgField key={arg.name} name={arg.name} type={arg.type} value={assertion.args?.[arg.name]} roles={vocabulary.roles}
            minimum={arg.minimum} maximum={arg.maximum}
            onChange={(value) => onChange({ ...assertion, args: { ...assertion.args, [arg.name]: value } })} />
        ))}
        <select aria-label={t('inspector.assertions.onFail', { check: label })} className="select select-sm"
          value={assertion.on_fail ?? vocabulary.default_on_fail} onChange={(e) => onChange({ ...assertion, on_fail: e.target.value })}>
          {(entry?.on_fail ?? [vocabulary.default_on_fail]).map((choice) => (
            <option key={choice} value={choice}>{t(`runWorkspace.assertions.onFail.${choice}`, { defaultValue: choice })}</option>
          ))}
        </select>
      </div>
    </li>
  )
}

/** "Add an assertion": a check this kind is checked on that the step has not got yet, added with its first values. */
function AddAssertion({ place, current, vocabulary, onAdd }: Readonly<{
  place: string; current: readonly StepAssertion[]; vocabulary: AssertionVocabulary; onAdd: (assertion: StepAssertion) => void
}>) {
  const { t } = useTranslation('agents')
  const [choice, setChoice] = useState('')
  const offered = vocabulary.checks.filter((entry) => entry.kinds.includes(place) && !current.some((each) => each.check === entry.check))
  if (current.length >= vocabulary.max) return <p className="text-[12px] text-muted">{t('inspector.assertions.full', { max: vocabulary.max })}</p>
  if (offered.length === 0) return <p className="text-[12px] text-muted">{t('inspector.assertions.noneApply')}</p>
  const add = () => {
    const entry = offered.find((each) => each.check === choice) ?? offered[0]
    if (entry === undefined) return
    const args = defaultArgs(entry, vocabulary.roles)
    onAdd({ check: entry.check, ...(Object.keys(args).length === 0 ? {} : { args }), on_fail: vocabulary.default_on_fail })
    setChoice('')
  }
  return (
    <div role="group" aria-label={t('inspector.assertions.add')} className="flex flex-wrap items-center gap-2">
      <select aria-label={t('inspector.assertions.check')} className="select select-sm min-w-0 flex-1" value={choice} onChange={(e) => setChoice(e.target.value)}>
        <option value="">{t('inspector.assertions.choose')}</option>
        {offered.map((entry) => <option key={entry.check} value={entry.check}>{checkLabel(t, entry.check, entry)}</option>)}
      </select>
      <button type="button" className="btn btn-secondary btn-sm" onClick={add}><Plus size={14} aria-hidden="true" /> {t('inspector.assertions.add')}</button>
    </div>
  )
}

export interface AssertionsFieldProps {
  /** Where they are checked: the step's type, or `learn` (Start's Learn). */
  readonly place: string
  readonly value: unknown
  readonly mode: FlowMode
  /** Build: the new list (empty: none, the setting left out). */
  readonly onChange?: (next: StepAssertion[]) => void
  /** Run: what the board recorded of this step's. */
  readonly results?: readonly RunAssertion[]
}

/** The assertions edited (build, the vocabulary read). */
function EditList({ place, current, vocabulary, onChange }: Readonly<{
  place: string; current: readonly StepAssertion[]; vocabulary: AssertionVocabulary; onChange: (next: StepAssertion[]) => void
}>) {
  const { t } = useTranslation('agents')
  const byCheck = new Map(vocabulary.checks.map((entry) => [entry.check, entry]))
  return (
    <div className="space-y-2">
      {current.length === 0 && <p className="text-[12px] text-muted">{t('inspector.empty.noAssertionsBuild')}</p>}
      <ul className="space-y-1.5">
        {current.map((assertion, index) => (
          <EditRow key={assertion.check} assertion={assertion} entry={byCheck.get(assertion.check)} vocabulary={vocabulary}
            onChange={(next) => onChange(current.map((each, at) => (at === index ? next : each)))}
            onRemove={() => onChange(current.filter((_each, at) => at !== index))} />
        ))}
      </ul>
      <AddAssertion place={place} current={current} vocabulary={vocabulary} onAdd={(added) => onChange([...current, added])} />
    </div>
  )
}

export function AssertionsField({ place, value, mode, onChange, results }: AssertionsFieldProps) {
  const { t } = useTranslation('agents')
  const vocabulary = useAssertionVocabulary(mode === 'build')
  const current = assertionsOf(value)
  const read = vocabulary.data
  if (mode === 'build' && onChange !== undefined && read !== undefined) {
    return <EditList place={place} current={current} vocabulary={read} onChange={onChange} />
  }
  if (current.length === 0) return <p className="text-[12px] text-muted">{t('inspector.empty.noAssertions')}</p>
  const byCheck = new Map((read?.checks ?? []).map((entry) => [entry.check, entry]))
  const recorded = new Map((results ?? []).map((result) => [result.check, result]))
  return (
    <ul className="space-y-1">
      {current.map((assertion) => {
        const result = recorded.get(assertion.check)
        return (
          <li key={assertion.check} className="flex flex-wrap items-center gap-2 text-[13px]">
            {result !== undefined && (
              <span className={RESULT_TONE[result.status] ?? 'badge badge-muted'}>
                {t(`runWorkspace.assertions.status.${result.status}`, { defaultValue: result.status })}
              </span>
            )}
            <span className="text-text">{checkLabel(t, assertion.check, byCheck.get(assertion.check))}</span>
            {argsText(assertion) !== '' && <span className="text-[12px] text-muted">{argsText(assertion)}</span>}
            <span className="text-[12px] text-muted">
              {t(`runWorkspace.assertions.onFail.${assertion.on_fail ?? 'block'}`, { defaultValue: assertion.on_fail ?? 'block' })}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
