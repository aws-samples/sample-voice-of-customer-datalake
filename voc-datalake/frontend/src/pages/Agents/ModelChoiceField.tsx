/**
 * @fileoverview The model choice's field (7.58.00): a select of the default (the caller's words: a role's default, or
 * each role's own), Auto, Opus 5.5, Sonnet 5.5, Haiku 5.5 and "Other model…", each saying where it is available, a
 * note under it on what the pick means on each harness, and, only while "Other model…" is picked, a text field for the
 * model id with the hint of the harness it is for and what is wrong with it (modelChoice.ts `modelIssue`).
 *
 * @module pages/Agents/ModelChoiceField
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { BEDROCK_MODELS, KIRO_MODELS, NAMED_MODEL_CHOICES, isNamedChoice, modelIssue } from './modelChoice'
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
  /** The Bedrock models this deployment enables (a native role's other id must be one); null: not checked here. */
  readonly enabled?: readonly string[] | null
  readonly disabled?: boolean
}

const PICKS: readonly ModelPick[] = ['', ...NAMED_MODEL_CHOICES, 'other']

function usePickNote(pick: ModelPick): string | null {
  const { t } = useTranslation('agents')
  const text = useModelChoiceText()
  if (pick === '') return null
  if (pick === 'other') return t('modelChoice.notes.other')
  if (pick === 'auto') return t('modelChoice.notes.auto')
  return t('modelChoice.notes.named', { model: text.choice(pick), kiro: KIRO_MODELS[pick], bedrock: BEDROCK_MODELS[pick] })
}

function OtherModel({ draft, onChange, harness, enabled, disabled }: Readonly<Omit<Props, 'label' | 'defaultLabel'>>) {
  const { t } = useTranslation('agents')
  const id = useId()
  const issue = modelIssue(draft, harness === 'native' ? enabled ?? null : null)
  // (an id not typed yet is not marked invalid: it only holds the save or the start)
  const invalid = issue !== null && issue !== 'empty'
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-[12px] font-medium text-muted">{t('modelChoice.other.label')}</label>
      <input id={id} className="input w-full font-mono" autoComplete="off" spellCheck={false} maxLength={128} value={draft.other}
        disabled={disabled} aria-invalid={invalid ? true : undefined}
        aria-describedby={issue === null ? `${id}-hint` : `${id}-hint ${id}-issue`}
        onChange={(event) => onChange({ pick: 'other', other: event.target.value })} />
      <p id={`${id}-hint`} className="text-[12px] text-muted">{t(`modelChoice.other.hint.${harness}`)}</p>
      {issue !== null && (
        <p id={`${id}-issue`} className={`text-[12px] ${invalid ? 'text-danger' : 'text-muted'}`}>
          {t(`modelChoice.issues.${issue}`, { id: draft.other.trim() })}
        </p>
      )}
    </div>
  )
}

export function ModelChoiceField({ label, defaultLabel, draft, onChange, harness, enabled = null, disabled = false }: Props) {
  const { t } = useTranslation('agents')
  const id = useId()
  const note = usePickNote(draft.pick)
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
            const pick = PICKS.find((value) => value === event.target.value) ?? ''
            onChange({ pick, other: pick === 'other' ? draft.other : '' })
          }}>
          {PICKS.map((pick) => <option key={pick || 'default'} value={pick}>{optionText(pick)}</option>)}
        </select>
        {note !== null && <p id={`${id}-note`} className="text-[12px] text-muted">{note}</p>}
      </div>
      {draft.pick === 'other' && (
        <OtherModel draft={draft} onChange={onChange} harness={harness} enabled={enabled} disabled={disabled} />
      )}
    </div>
  )
}
