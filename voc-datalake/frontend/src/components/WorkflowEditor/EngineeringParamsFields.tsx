/**
 * @fileoverview The settings of an engineering flow's step (`data.params`, `voc-workflow/2`): an agent's role, skill
 * version, model and budget share; a map's sharding; a board's posters, claimers and end; a quality gate's rounds,
 * packs and final-go model; a memory step's mode, scope and limit. The values offered are the ones
 * `lambda/shared/workflow_engineering.py` accepts (mirrored by `engineeringRules.ts`). Roles and gate packs are shown
 * by their ids, as the platform names them.
 *
 * @module components/WorkflowEditor/EngineeringParamsFields
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LabeledField } from '../LabeledField/LabeledField'
import {
  BOARD_CLAIMERS, BOARD_POSTERS, BOARD_UNTIL, ENGINEERING_ROLES, GATE_PACKS, MAX_GATE_ROUNDS, MAX_MEMORY_LIMIT,
  MAX_SHARD_CAP, MEMORY_MODES, MEMORY_SCOPES, SHARD_BY,
} from './engineeringRules'
import type { ReactNode } from 'react'
import type { WorkflowNode } from '../../api/workflowsApi'

interface Props {
  node: WorkflowNode
  readOnly: boolean
  onParams: (params: Record<string, unknown>) => void
}

/** What every setting of a step's panel shares: its params, read-only, and how to set one. */
interface Panel {
  params: Readonly<Record<string, unknown>>
  readOnly: boolean
  /** Set one setting; an empty value leaves it out (the server's default applies). */
  set: (key: string, value: unknown) => void
}

/** A whole number from the input, within its bounds; an empty field leaves the setting out (its default applies). */
const bounded = (raw: string, low: number, high: number): number | '' =>
  (raw === '' ? '' : Math.max(low, Math.min(high, Math.trunc(Number(raw)) || low)))

/** A labelled setting (`editor.engineering.<label>`), with its hint under it when it has one. */
function Field({ label, hint, children }: Readonly<{ label: string; hint?: string; children: (id: string) => ReactNode }>) {
  const { t } = useTranslation('agents')
  return (
    <LabeledField label={t(`editor.engineering.${label}`)}>
      {(id) => (
        <>
          {children(id)}
          {hint !== undefined && <p className="text-[12px] text-muted">{t(`editor.engineering.${hint}`)}</p>}
        </>
      )}
    </LabeledField>
  )
}

/** A setting chosen from a list; `group` names its options' labels (none: shown by their ids). */
function SettingChoice({ panel, name, label, options, group, fallback }: Readonly<{
  panel: Panel; name: string; label: string; options: readonly string[]; group?: string; fallback?: string
}>) {
  const { t } = useTranslation('agents')
  const value = panel.params[name] ?? fallback
  const text = (option: string) => (group === undefined ? option : t(`editor.engineering.${group}.${option}`))
  return (
    <Field label={label}>
      {(id) => (
        <select id={id} className="select w-full" disabled={panel.readOnly} value={typeof value === 'string' ? value : ''}
          onChange={(e) => panel.set(name, e.target.value)}>
          {/* Nothing chosen yet (an imported step): shown as such, never as the first option. */}
          {typeof value !== 'string' && <option value="">—</option>}
          {options.map((option) => <option key={option} value={option}>{text(option)}</option>)}
        </select>
      )}
    </Field>
  )
}

/** A setting holding a list of ids (roles, packs), each a checkbox. */
function SettingList({ panel, name, label, options }: Readonly<{
  panel: Panel; name: string; label: string; options: readonly string[]
}>) {
  const { t } = useTranslation('agents')
  const chosen = panel.params[name]
  const current = Array.isArray(chosen) ? chosen.filter((item): item is string => typeof item === 'string') : []
  const toggle = (item: string, on: boolean) =>
    panel.set(name, on ? options.filter((option) => option === item || current.includes(option))
      : current.filter((other) => other !== item))
  return (
    <fieldset className="space-y-1">
      <legend className="text-[12px] font-medium text-muted">{t(`editor.engineering.${label}`)}</legend>
      <div className="grid grid-cols-2 gap-x-2 gap-y-1">
        {options.map((item) => (
          <label key={item} className="flex items-center gap-2 text-[13px] text-text font-mono">
            <input type="checkbox" className="accent-accent" disabled={panel.readOnly} checked={current.includes(item)}
              onChange={(e) => toggle(item, e.target.checked)} />
            {item}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

/** A free-text setting (a model id, a skill version). */
function SettingText({ panel, name, label, hint }: Readonly<{ panel: Panel; name: string; label: string; hint: string }>) {
  const value = panel.params[name]
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <input id={id} className="input w-full" disabled={panel.readOnly} maxLength={128}
          value={typeof value === 'string' ? value : ''} onChange={(e) => panel.set(name, e.target.value.trim())} />
      )}
    </Field>
  )
}

/**
 * A number setting; `parse` turns the typed text into the stored value ('' leaves it out). The field shows what is
 * typed while it has focus (so "0.4" can be typed through "0" and "0."), and the stored value once it is left.
 */
function SettingNumber({ panel, name, label, hint, min, max, step = 1, fallback, parse }: Readonly<{
  panel: Panel; name: string; label: string; hint?: string; min: number; max: number; step?: number
  fallback?: number; parse: (raw: string) => number | ''
}>) {
  const [typed, setTyped] = useState<string | null>(null)
  const value = panel.params[name] ?? fallback
  const stored = typeof value === 'number' ? String(value) : ''
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <input id={id} type="number" min={min} max={max} step={step} className="input w-full" disabled={panel.readOnly}
          value={typed ?? stored} onBlur={() => setTyped(null)}
          onChange={(e) => { setTyped(e.target.value); panel.set(name, parse(e.target.value)) }} />
      )}
    </Field>
  )
}

const share = (raw: string): number | '' => (raw === '' ? '' : Math.max(0.01, Math.min(1, Number(raw) || 0.01)))

function AgentPanel({ panel }: Readonly<{ panel: Panel }>) {
  return (
    <div className="space-y-3">
      <SettingChoice panel={panel} name="role" label="role" options={ENGINEERING_ROLES} />
      <SettingText panel={panel} name="skill_version" label="skillVersion" hint="skillVersionHint" />
      <SettingText panel={panel} name="model" label="model" hint="modelHint" />
      <SettingNumber panel={panel} name="budget_share" label="budgetShare" hint="budgetShareHint" min={0.01} max={1}
        step={0.05} parse={share} />
    </div>
  )
}

function MapPanel({ panel }: Readonly<{ panel: Panel }>) {
  return (
    <div className="space-y-3">
      <SettingChoice panel={panel} name="shard_by" label="shardBy" options={SHARD_BY} group="shardByOptions" />
      <SettingNumber panel={panel} name="shard_cap" label="shardCap" min={1} max={MAX_SHARD_CAP}
        parse={(raw) => bounded(raw, 1, MAX_SHARD_CAP)} />
    </div>
  )
}

function BoardPanel({ panel }: Readonly<{ panel: Panel }>) {
  return (
    <div className="space-y-3">
      <SettingList panel={panel} name="posters" label="posters" options={BOARD_POSTERS} />
      <SettingList panel={panel} name="claimers" label="claimers" options={BOARD_CLAIMERS} />
      <SettingChoice panel={panel} name="until" label="until" options={BOARD_UNTIL} group="untilOptions" fallback="drained" />
    </div>
  )
}

function GatePanel({ panel }: Readonly<{ panel: Panel }>) {
  const { t } = useTranslation('agents')
  const auto = panel.params.packs === undefined || panel.params.packs === 'auto'
  return (
    <div className="space-y-3">
      <SettingNumber panel={panel} name="max_rounds" label="maxRounds" min={1} max={MAX_GATE_ROUNDS} fallback={3}
        parse={(raw) => bounded(raw, 1, MAX_GATE_ROUNDS)} />
      <label className="flex items-center gap-2 text-sm text-text">
        <input type="checkbox" className="accent-accent" disabled={panel.readOnly} checked={auto}
          onChange={(e) => panel.set('packs', e.target.checked ? 'auto' : [GATE_PACKS[0]])} />
        {t('editor.engineering.packsAuto')}
      </label>
      {!auto && <SettingList panel={panel} name="packs" label="packs" options={GATE_PACKS} />}
      <SettingText panel={panel} name="final_go_model" label="finalGoModel" hint="modelHint" />
    </div>
  )
}

function MemoryPanel({ panel }: Readonly<{ panel: Panel }>) {
  return (
    <div className="space-y-3">
      <SettingChoice panel={panel} name="mode" label="mode" options={MEMORY_MODES} group="modeOptions" />
      <SettingChoice panel={panel} name="scope" label="scope" options={MEMORY_SCOPES} group="scopeOptions" />
      {panel.params.mode === 'read' && (
        <SettingNumber panel={panel} name="limit" label="limit" min={1} max={MAX_MEMORY_LIMIT} fallback={10}
          parse={(raw) => bounded(raw, 1, MAX_MEMORY_LIMIT)} />
      )}
    </div>
  )
}

/** Each engineering step with settings, and its panel (the others have none). */
const PANELS: Readonly<Partial<Record<string, typeof AgentPanel>>> = {
  agent: AgentPanel, map: MapPanel, board: BoardPanel, quality_gate: GatePanel, memory: MemoryPanel,
}

export function EngineeringParamsFields({ node, readOnly, onParams }: Readonly<Props>) {
  const params = node.data.params ?? {}
  const set = (key: string, value: unknown) => {
    const next = Object.fromEntries(Object.entries(params).filter(([k]) => k !== key))
    onParams(value === '' || value === undefined ? next : { ...next, [key]: value })
  }
  const StepPanel = PANELS[node.type]
  return StepPanel === undefined ? null : <StepPanel panel={{ params, readOnly, set }} />
}
