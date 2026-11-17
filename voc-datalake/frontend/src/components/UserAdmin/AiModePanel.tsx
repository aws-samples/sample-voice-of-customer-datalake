/**
 * @fileoverview Settings → Users: each person's way of working with AI (docs/ways-of-working.md).
 *
 * A segmented control per user (the `tabs-track` / `tab` recipe as a radio group: arrow keys,
 * Home and End move the focus, a roving `tabindex` keeps one stop per row, Space or Enter
 * saves), more AI to the right: Human-driven, AI-assisted, AI-driven. Inside Human-driven the
 * admin can unlock "PR/FAQ with AI" and "PRD with AI" once the person has learned. "How the
 * modes differ" shows what each mode means for the person's PR/FAQs and PRDs and for the
 * engineering automations they enable, in view rather than only in hover tooltips.
 *
 * The mode shapes the AI's writing of PR/FAQs and PRDs and whether the engineering automations
 * the person enables may push and open pull requests (7.50.02): their dial takes only an
 * explicitly saved AI-assisted or AI-driven (lambda/engineering/connectors/dial.py), while
 * documents read nothing saved as AI-driven. So a person with nothing saved shows no option
 * selected, a "Not set" badge and what that means until a mode is chosen; one click on any
 * mode, AI-driven included, saves it. The server enforces both.
 *
 * @module components/UserAdmin/AiModePanel
 */
import clsx from 'clsx'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { AI_MODES, aiModeApi, readStoredAiMode } from '../../api/aiModeApi'
import type { AiModeName, AiModePatch, StoredAiMode } from '../../api/aiModeApi'
import type { CognitoUser } from '../../api/types'
import { myAiModeKey } from '../../api/queryKeys'
import UserSettingsPanel from './UserSettingsPanel'
import { RADIO_KEYS, rovingIndex } from '../../utils/rovingIndex'

interface ModeKeys {
  readonly label: string
  readonly tooltip: string
  /** Its row of "How the modes differ": the person's PR/FAQs and PRDs, and the automations they enable. */
  readonly documents: string
  readonly automations: string
}

const MODE_KEYS: Record<AiModeName, ModeKeys> = {
  human_driven: {
    label: 'userAdmin.aiMode.humanDriven', tooltip: 'userAdmin.aiMode.humanDrivenTooltip',
    documents: 'userAdmin.aiMode.compare.humanDriven.documents', automations: 'userAdmin.aiMode.compare.humanDriven.automations',
  },
  ai_assisted: {
    label: 'userAdmin.aiMode.aiAssisted', tooltip: 'userAdmin.aiMode.aiAssistedTooltip',
    documents: 'userAdmin.aiMode.compare.aiAssisted.documents', automations: 'userAdmin.aiMode.compare.aiAssisted.automations',
  },
  ai_driven: {
    label: 'userAdmin.aiMode.aiDriven', tooltip: 'userAdmin.aiMode.aiDrivenTooltip',
    documents: 'userAdmin.aiMode.compare.aiDriven.documents', automations: 'userAdmin.aiMode.compare.aiDriven.automations',
  },
}

/** An admin who changed their own row sees it in the editor at once. */
const ALSO_REFRESH = [myAiModeKey()]

export default function AiModePanel({ users }: Readonly<{ users: readonly CognitoUser[] }>) {
  const { t } = useTranslation('components')
  const copy = { title: t('userAdmin.aiMode.title'), description: t('userAdmin.aiMode.description'), saveFailed: t('userAdmin.aiMode.saveFailed') }
  return (
    <UserSettingsPanel icon={Sparkles} copy={copy} save={aiModeApi.save} alsoRefresh={ALSO_REFRESH} users={users}
      lead={<ModesCompared />}
      row={(user, edit) => (
        <AiModeRow key={user.username} who={user.email || user.username} mode={readStoredAiMode(user)} disabled={edit.disabled}
          onChange={edit.change} />
      )} />
  )
}

/** "How the modes differ": one row per mode, what it means for the person's documents and their automations. */
function ModesCompared() {
  const { t } = useTranslation('components')
  return (
    <details className="mb-3 rounded-lg border border-border">
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
                <th scope="row" className="py-1.5 pr-3 font-medium whitespace-nowrap">{t(MODE_KEYS[name].label)}</th>
                <td className="py-1.5 pr-3">{t(MODE_KEYS[name].documents)}</td>
                <td className="py-1.5">{t(MODE_KEYS[name].automations)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}

/** One user's row: who, their stored mode (or none saved), and where a change goes. */
interface RowProps {
  readonly who: string
  readonly mode: StoredAiMode
  readonly disabled: boolean
  readonly onChange: (patch: AiModePatch) => void
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

function AiModeRow({ who, mode, disabled, onChange }: RowProps) {
  const { t } = useTranslation('components')
  const groupId = useId()
  const notSetId = useId()
  // (nothing saved selects no option: the default AI-driven is the documents' alone, so a click on it saves it)
  const selected: AiModeName | null = mode.saved ? mode.mode : null
  const tabStop: AiModeName = selected ?? AI_MODES[0]
  return (
    <li className="flex flex-col lg:flex-row lg:items-center gap-2 py-2">
      <span id={groupId} className="text-sm text-text flex-1 truncate">{who}</span>
      <div className="flex flex-col gap-1 self-start">
        <div className="flex flex-wrap items-center gap-2">
          <div role="radiogroup" aria-labelledby={groupId} aria-describedby={selected === null ? notSetId : undefined}
            className="tabs-track" onKeyDown={onRadioKey}>
            {AI_MODES.map((name) => (
              <button
                key={name}
                type="button"
                role="radio"
                aria-checked={selected === name}
                tabIndex={name === tabStop ? 0 : -1}
                title={t(MODE_KEYS[name].tooltip)}
                disabled={disabled}
                onClick={() => { if (selected !== name) onChange({ ai_mode: name }) }}
                className={clsx('tab', selected === name && 'tab-active')}
              >
                {t(MODE_KEYS[name].label)}
              </button>
            ))}
          </div>
          {selected === null ? <span className="badge badge-warn">{t('userAdmin.aiMode.notSet')}</span> : null}
        </div>
        {selected === null ? <span id={notSetId} className="text-[12px] text-muted">{t('userAdmin.aiMode.notSetEffect')}</span> : null}
      </div>
      {selected === 'human_driven' ? <UnlockBoxes who={who} mode={mode} disabled={disabled} onChange={onChange} /> : null}
    </li>
  )
}

const UNLOCKS = [
  { field: 'ai_writing_prfaq', label: 'userAdmin.aiMode.unlockPrfaq', aria: 'userAdmin.aiMode.unlockPrfaqFor' },
  { field: 'ai_writing_prd', label: 'userAdmin.aiMode.unlockPrd', aria: 'userAdmin.aiMode.unlockPrdFor' },
] as const

function UnlockBoxes({ who, mode, disabled, onChange }: RowProps) {
  const { t } = useTranslation('components')
  return (
    <div className="flex items-center gap-3" title={t('userAdmin.aiMode.unlockTooltip')}>
      {UNLOCKS.map(({ field, label, aria }) => (
        <label key={field} className="flex items-center gap-2 text-[13px] text-text">
          <input
            type="checkbox"
            className="accent-accent"
            checked={mode[field]}
            disabled={disabled}
            onChange={(e) => onChange({ [field]: e.target.checked })}
            aria-label={t(aria, { user: who })}
          />
          {t(label)}
        </label>
      ))}
    </div>
  )
}
