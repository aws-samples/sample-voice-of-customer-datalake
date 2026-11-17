/**
 * @fileoverview People → a person's editor → "Ways of working with AI" (docs/ways-of-working.md).
 *
 * A segmented control (the `tabs-track` / `tab` recipe as a radio group: arrow keys, Home and End move the focus, a
 * roving `tabindex` keeps one stop, Space or Enter saves), more AI to the right: Human-driven, AI-assisted, AI-driven.
 * Inside Human-driven the admin can unlock "PR/FAQ with AI" and "PRD with AI" once the person has learned. "How the
 * modes differ" shows what each mode means for the person's PR/FAQs and PRDs and for the engineering automations they
 * enable, in view rather than only in hover tooltips.
 *
 * The mode shapes the AI's writing of PR/FAQs and PRDs and whether the engineering automations the person enables may
 * push and open pull requests (7.50.02): their dial takes only an explicitly saved AI-assisted or AI-driven
 * (lambda/engineering/connectors/dial.py), while documents read nothing saved as AI-driven. So a person with nothing
 * saved shows no option selected, a "Not set" badge and what that means until a mode is chosen; one click on any mode,
 * AI-driven included, saves it. The server enforces both.
 *
 * @module components/UserAdmin/WaysOfWorking
 */
import clsx from 'clsx'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { KeyboardEvent } from 'react'
import { AI_MODES, aiModeApi, readStoredAiMode } from '../../api/aiModeApi'
import type { AiModeName, AiModePatch, StoredAiMode } from '../../api/aiModeApi'
import type { CognitoUser } from '../../api/types'
import { myAiModeKey } from '../../api/queryKeys'
import { RADIO_KEYS, rovingIndex } from '../../utils/rovingIndex'
import { InfoTip } from '../Tooltip/InfoTip'
import { Tooltip } from '../Tooltip/Tooltip'
import { MODE_KEYS } from './aiModeCopy'
import SheetSection from './SheetSection'
import { useSheetSave } from './useSheetSave'

/** An admin who changed their own way of working sees it in the editor at once. */
const ALSO_REFRESH = [myAiModeKey()]

/** "How the modes differ": one row per mode, what it means for the person's documents and their automations. */
function ModesCompared() {
  const { t } = useTranslation('components')
  return (
    <details className="rounded-lg border border-border">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-text-strong focus-ring rounded-lg">
        {t('userAdmin.aiMode.compareTitle')}
      </summary>
      <div className="overflow-x-auto px-3 pb-3">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-muted">
              <th scope="col" className="py-1 pr-3 font-medium">{t('userAdmin.aiMode.compare.mode')}</th>
              <th scope="col" className="py-1 pr-3 font-medium">{t('userAdmin.aiMode.compare.documents')}</th>
              <th scope="col" className="py-1 font-medium">{t('userAdmin.aiMode.compare.automations')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {AI_MODES.map((name) => (
              <tr key={name} className="align-top text-text">
                <th scope="row" className="py-1.5 pr-3 font-medium whitespace-nowrap">{t(MODE_KEYS[name].labelKey)}</th>
                <td className="py-1.5 pr-3">{t(MODE_KEYS[name].documentsKey)}</td>
                <td className="py-1.5">{t(MODE_KEYS[name].automationsKey)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}

/** Arrow keys move the focus between the radios (never a save: a change is saved on Space, Enter or a click). */
function onRadioKey(event: KeyboardEvent<HTMLDivElement>) {
  const radios = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
  const current = radios.findIndex((radio) => radio === document.activeElement)
  const next = current === -1 ? null : rovingIndex(event.key, current, radios.length, RADIO_KEYS)
  if (next === null) return
  event.preventDefault()
  radios[next]?.focus()
}

interface ModesProps {
  readonly mode: StoredAiMode
  readonly disabled: boolean
  readonly onChange: (patch: AiModePatch) => void
}

/** The radio group, named by the section's heading; "Not set" and what it means while nothing is saved. */
function ModeChoice({ labelId, mode, disabled, onChange }: ModesProps & { readonly labelId: string }) {
  const { t } = useTranslation('components')
  const notSetId = useId()
  // (nothing saved selects no option: the default AI-driven is the documents' alone, so a click on it saves it)
  const selected: AiModeName | null = mode.saved ? mode.mode : null
  const tabStop: AiModeName = selected ?? AI_MODES[0]
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-labelledby={labelId} aria-describedby={selected === null ? notSetId : undefined}
          className="tabs-track" onKeyDown={onRadioKey}>
          {AI_MODES.map((name) => (
            <Tooltip key={name} kind="description" content={t(MODE_KEYS[name].tooltipKey)}>
              <button
                type="button"
                role="radio"
                aria-checked={selected === name}
                tabIndex={name === tabStop ? 0 : -1}
                disabled={disabled}
                onClick={() => { if (selected !== name) onChange({ ai_mode: name }) }}
                className={clsx('tab', selected === name && 'tab-active')}
              >
                {t(MODE_KEYS[name].labelKey)}
              </button>
            </Tooltip>
          ))}
        </div>
        {selected === null ? <span className="badge badge-warn">{t('userAdmin.aiMode.notSet')}</span> : null}
      </div>
      {selected === null ? <span id={notSetId} className="text-[12px] text-muted">{t('userAdmin.aiMode.notSetEffect')}</span> : null}
    </div>
  )
}

const UNLOCKS = [
  { field: 'ai_writing_prfaq', labelKey: 'components:userAdmin.aiMode.unlockPrfaq' },
  { field: 'ai_writing_prd', labelKey: 'components:userAdmin.aiMode.unlockPrd' },
] as const

function UnlockBoxes({ mode, disabled, onChange }: ModesProps) {
  const { t } = useTranslation('components')
  return (
    <div className="flex flex-wrap items-center gap-3">
      {UNLOCKS.map(({ field, labelKey }) => (
        <label key={field} className="flex items-center gap-2 text-[13px] text-text">
          <input
            type="checkbox"
            className="accent-accent"
            checked={mode[field]}
            disabled={disabled}
            onChange={(e) => onChange({ [field]: e.target.checked })}
          />
          {t(labelKey)}
        </label>
      ))}
      <InfoTip text={t('userAdmin.aiMode.unlockTooltip')} />
    </div>
  )
}

export default function WaysOfWorking({ user }: Readonly<{ user: CognitoUser }>) {
  const { t } = useTranslation('components')
  const labelId = useId()
  const save = useSheetSave((patch: AiModePatch) => aiModeApi.save(user.username, patch), ALSO_REFRESH)
  const mode = readStoredAiMode(user)
  const change = (patch: AiModePatch) => { save.mutate(patch) }
  return (
    <SheetSection title={t('userAdmin.aiMode.title')} hint={t('userAdmin.aiMode.description')} labelId={labelId}
      error={save.isError ? t('userAdmin.aiMode.saveFailed') : null}>
      <ModeChoice labelId={labelId} mode={mode} disabled={save.isPending} onChange={change} />
      {mode.saved && mode.mode === 'human_driven' ? <UnlockBoxes mode={mode} disabled={save.isPending} onChange={change} /> : null}
      <ModesCompared />
    </SheetSection>
  )
}
