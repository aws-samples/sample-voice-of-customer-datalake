/**
 * @fileoverview The model choice's field (7.58.00): a select of the default (the caller's words: a role's default, or
 * each role's own), Auto, Opus 5.5, Sonnet 5.5, Haiku 5.5 and "Other model…", each saying where it is available, a
 * note under it on what the pick means on each harness, and, only while "Other model…" is picked, the model: for a
 * role on the native harness a select of the other Bedrock models this deployment enables (no Auto there, which is
 * Kiro's alone: modelChoice.ts `choicesOn`, `otherModelsOn`), else a text field for the model id with the hint of the
 * harness it is for and what is wrong with it (modelChoice.ts `modelIssue`). For a role on Kiro, with the deployment's
 * price per Kiro credit (`creditPrice`, 7.58.00), a line saying the role is billed in Kiro credits at it, which the cost
 * cap counts.
 *
 * @module pages/Agents/ModelChoiceField
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { BEDROCK_MODELS, KIRO_MODELS, choicesOn, isNamedChoice, modelIssue, otherModelsOn } from './modelChoice'
import { useModelChoiceText } from './modelChoiceText'
import type { ModelDraft, ModelHarness, ModelPick } from './modelChoice'

interface Props {
  readonly label: string
  /** The first option's words (the default: no choice). */
  readonly defaultLabel: string
  readonly draft: ModelDraft
  readonly onChange: (draft: ModelDraft) => void
  /** The harness an other id is for ('any': the run's roles may be on either). */
  readonly harness: ModelHarness | 'any'
  /** The Bedrock models this deployment enables (a native role's "Other model…" is one of them); null: not known here. */
  readonly enabled?: readonly string[] | null
  /** (7.58.00) USD per Kiro credit here (`-c engineeringKiroCreditPrice`): said for a role on Kiro; null: not said. */
  readonly creditPrice?: number | null
  readonly disabled?: boolean
}

/** A Kiro role's billing line: its credits at the deployment's price, counted by the cost cap. */
function KiroCredits({ price }: Readonly<{ price: number }>) {
  const { t, i18n } = useTranslation('agents')
  const amount = new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 })
    .format(price)
  return <p className="text-[12px] text-muted">{t('modelChoice.kiroCredits', { price: amount })}</p>
}

function usePickNote(pick: ModelPick, harness: Props['harness']): string | null {
  const { t } = useTranslation('agents')
  const text = useModelChoiceText()
  if (pick === '') return null
  if (pick === 'other') return t(harness === 'native' ? 'modelChoice.notes.otherNative' : 'modelChoice.notes.other')
  if (pick === 'auto') return t('modelChoice.notes.auto')
  return t('modelChoice.notes.named', { model: text.choice(pick), kiro: KIRO_MODELS[pick], bedrock: BEDROCK_MODELS[pick] })
}

/** A native role's other model: one of the Bedrock models this deployment enables beyond the named three (a choice
 * saved earlier that is none of them is shown, said not to be enabled). */
function EnabledModel({ draft, onChange, enabled, disabled }: Readonly<Omit<Props, 'label' | 'defaultLabel' | 'harness' | 'creditPrice'>>) {
  const { t } = useTranslation('agents')
  const id = useId()
  const models = otherModelsOn(enabled ?? [], draft.other)
  const issue = modelIssue(draft, enabled ?? [])
  if (models.length === 0) return <p className="text-[12px] text-muted">{t('modelChoice.other.noneEnabled')}</p>
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-[12px] font-medium text-muted">{t('modelChoice.other.enabledLabel')}</label>
      <select id={id} className="select w-full font-mono" value={draft.other.trim()} disabled={disabled}
        aria-invalid={issue === 'notEnabled' ? true : undefined}
        aria-describedby={issue === 'notEnabled' ? `${id}-hint ${id}-issue` : `${id}-hint`}
        onChange={(event) => onChange({ pick: 'other', other: event.target.value })}>
        <option value="">{t('modelChoice.other.choose')}</option>
        {models.map((model) => <option key={model} value={model}>{model}</option>)}
      </select>
      <p id={`${id}-hint`} className="text-[12px] text-muted">{t('modelChoice.other.hint.native')}</p>
      {issue === 'notEnabled' && (
        <p id={`${id}-issue`} className="text-[12px] text-danger">{t('modelChoice.issues.notEnabled', { id: draft.other.trim() })}</p>
      )}
    </div>
  )
}

function OtherModel({ draft, onChange, harness, enabled, disabled }: Readonly<Omit<Props, 'label' | 'defaultLabel' | 'creditPrice'>>) {
  const { t } = useTranslation('agents')
  const id = useId()
  if (harness === 'native') return <EnabledModel draft={draft} onChange={onChange} enabled={enabled} disabled={disabled} />
  const issue = modelIssue(draft)
  // (an id not typed yet is not marked invalid: it only holds the save or the start)
  const invalid = issue !== null && issue !== 'empty'
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-[12px] font-medium text-muted">{t('modelChoice.other.label')}</label>
      <input id={id} className="input w-full font-mono" autoComplete="off" spellCheck={false} maxLength={128} value={draft.other}
        disabled={disabled} aria-invalid={invalid ? true : undefined}
        aria-describedby={issue === null ? `${id}-hint` : `${id}-hint ${id}-issue`}
        onChange={(event) => onChange({ pick: 'other', other: event.target.value })} />
      <p id={`${id}-hint`} className="text-[12px] text-muted">{t(harness === 'kiro' ? 'modelChoice.other.hint.kiro' : 'modelChoice.other.hint.any')}</p>
      {issue !== null && (
        <p id={`${id}-issue`} className={`text-[12px] ${invalid ? 'text-danger' : 'text-muted'}`}>
          {t(`modelChoice.issues.${issue}`, { id: draft.other.trim() })}
        </p>
      )}
    </div>
  )
}

export function ModelChoiceField({ label, defaultLabel, draft, onChange, harness, enabled = null, creditPrice = null,
  disabled = false }: Props) {
  const { t } = useTranslation('agents')
  const id = useId()
  const note = usePickNote(draft.pick, harness)
  const picks = choicesOn(harness, draft.pick)
  const optionText = (pick: ModelPick): string => {
    if (pick === '') return defaultLabel
    return isNamedChoice(pick) ? t(`modelChoice.options.${pick}`) : t('modelChoice.options.other')
  }
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <label htmlFor={id} className="block text-[12px] font-medium text-muted">{label}</label>
        <select id={id} className="select w-full" value={draft.pick} disabled={disabled}
          aria-describedby={note === null ? undefined : `${id}-note`}
          onChange={(event) => {
            const pick = picks.find((value) => value === event.target.value) ?? ''
            onChange({ pick, other: pick === 'other' ? draft.other : '' })
          }}>
          {picks.map((pick) => <option key={pick || 'default'} value={pick}>{optionText(pick)}</option>)}
        </select>
        {note !== null && <p id={`${id}-note`} className="text-[12px] text-muted">{note}</p>}
      </div>
      {draft.pick === 'other' && (
        <OtherModel draft={draft} onChange={onChange} harness={harness} enabled={enabled} disabled={disabled} />
      )}
      {harness === 'kiro' && creditPrice !== null && <KiroCredits price={creditPrice} />}
    </div>
  )
}
