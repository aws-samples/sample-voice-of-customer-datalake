/**
 * @fileoverview Settings → Users: each person's way of working with AI (docs/ways-of-working.md).
 *
 * A segmented control per user, with a tooltip for each mode (cumulative, more AI to the
 * right): Human-driven, AI-assisted, AI-driven (the default for everyone, admins
 * included). Inside Human-driven the admin can unlock "PR/FAQ with AI" and "PRD with AI"
 * once the person has learned. Only PR/FAQs and PRDs are affected; the server enforces it.
 *
 * @module components/UserAdmin/AiModePanel
 */
import clsx from 'clsx'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles } from 'lucide-react'
import { AI_MODES, aiModeApi, readAiMode } from '../../api/aiModeApi'
import type { AiMode, AiModeName, AiModePatch } from '../../api/aiModeApi'
import type { CognitoUser } from '../../api/types'
import { myAiModeKey } from '../../api/queryKeys'
import UserSettingsPanel from './UserSettingsPanel'

const MODE_KEYS: Record<AiModeName, { label: string; tooltip: string }> = {
  human_driven: { label: 'userAdmin.aiMode.humanDriven', tooltip: 'userAdmin.aiMode.humanDrivenTooltip' },
  ai_assisted: { label: 'userAdmin.aiMode.aiAssisted', tooltip: 'userAdmin.aiMode.aiAssistedTooltip' },
  ai_driven: { label: 'userAdmin.aiMode.aiDriven', tooltip: 'userAdmin.aiMode.aiDrivenTooltip' },
}

/** An admin who changed their own row sees it in the editor at once. */
const ALSO_REFRESH = [myAiModeKey()]

export default function AiModePanel({ users }: Readonly<{ users: readonly CognitoUser[] }>) {
  const { t } = useTranslation('components')
  const copy = { title: t('userAdmin.aiMode.title'), description: t('userAdmin.aiMode.description'), saveFailed: t('userAdmin.aiMode.saveFailed') }
  return (
    <UserSettingsPanel icon={Sparkles} copy={copy} save={aiModeApi.save} alsoRefresh={ALSO_REFRESH} users={users}
      row={(user, edit) => (
        <AiModeRow key={user.username} who={user.email || user.username} mode={readAiMode(user)} disabled={edit.disabled}
          onChange={edit.change} />
      )} />
  )
}

/** One user's row: who, their current mode, and where a change goes. */
interface RowProps {
  readonly who: string
  readonly mode: AiMode
  readonly disabled: boolean
  readonly onChange: (patch: AiModePatch) => void
}

function AiModeRow({ who, mode, disabled, onChange }: RowProps) {
  const { t } = useTranslation('components')
  const groupId = useId()
  return (
    <li className="flex flex-col lg:flex-row lg:items-center gap-2 py-2">
      <span id={groupId} className="text-sm text-text flex-1 truncate">{who}</span>
      <div role="radiogroup" aria-labelledby={groupId} className="inline-flex rounded-lg border border-border overflow-hidden self-start">
        {AI_MODES.map((name) => (
          <button
            key={name}
            type="button"
            role="radio"
            aria-checked={mode.mode === name}
            title={t(MODE_KEYS[name].tooltip)}
            disabled={disabled}
            onClick={() => { if (mode.mode !== name) onChange({ ai_mode: name }) }}
            className={clsx(
              'px-3 py-1 text-[13px] focus-ring border-r border-border last:border-r-0',
              mode.mode === name ? 'bg-accent-subtle text-accent-text font-medium' : 'bg-card text-text hover:bg-bg-hover',
            )}
          >
            {t(MODE_KEYS[name].label)}
          </button>
        ))}
      </div>
      {mode.mode === 'human_driven' ? <UnlockBoxes who={who} mode={mode} disabled={disabled} onChange={onChange} /> : null}
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
