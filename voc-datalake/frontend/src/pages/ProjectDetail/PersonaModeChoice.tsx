/**
 * Add-or-replace for persona generation (#353).
 *
 * A project that already has personas is asked what the new run does to them: `add`
 * (the default, non-destructive) keeps them and writes different ones next to them;
 * `replace` deletes them first, so its confirmation is a danger dialog that counts
 * what goes. A project with no personas sees neither the choice nor the warning.
 *
 * Protected personas (#429) survive a replace: its hint and its confirmation count only the
 * unprotected ones, and say how many protected ones stay.
 */
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import RadioCard from '../../components/RadioCard/RadioCard'
import type { PersonaGenerationMode } from './types'

const MODES: ReadonlyArray<{ value: PersonaGenerationMode; titleKey: string; hintKey: string }> = [
  { value: 'add', titleKey: 'wizards.personaModeAdd', hintKey: 'wizards.personaModeAddHint' },
  { value: 'replace', titleKey: 'wizards.personaModeReplace', hintKey: 'wizards.personaModeReplaceHint' },
]

interface PersonaModeChoiceProps {
  /** How many personas the project has now; 0 renders nothing. */
  readonly existingCount: number
  /** How many of them are protected, which a replace keeps (#429). */
  readonly protectedCount?: number
  readonly mode: PersonaGenerationMode
  readonly onChange: (mode: PersonaGenerationMode) => void
}

/** A replace's hint: what it deletes (the unprotected personas), then what it keeps. */
function replaceHint(t: TFunction, existingCount: number, protectedCount: number): string {
  const deleted = existingCount - protectedCount
  const kept = protectedCount > 0 ? t('wizards.personaReplaceKeepsProtected', { count: protectedCount }) : ''
  if (deleted === 0) return kept
  return [t('wizards.personaModeReplaceHint', { count: deleted }), kept].filter(Boolean).join(' ')
}

export function PersonaModeChoice({ existingCount, protectedCount = 0, mode, onChange }: PersonaModeChoiceProps) {
  const { t } = useTranslation('projectDetail')
  if (existingCount === 0) return null
  return (
    <fieldset className="space-y-2">
      <legend className="font-medium mb-3">{t('wizards.personaModeLabel')}</legend>
      {MODES.map((m) => (
        <RadioCard
          key={m.value}
          name="persona-generation-mode"
          value={m.value}
          checked={mode === m.value}
          onSelect={onChange}
          title={t(m.titleKey)}
          hint={m.value === 'replace' ? replaceHint(t, existingCount, protectedCount) : t(m.hintKey, { count: existingCount })}
        />
      ))}
    </fieldset>
  )
}

interface PersonaGenerateConfirmProps {
  readonly isOpen: boolean
  readonly existingCount: number
  /** How many of them are protected, which a replace keeps (#429). */
  readonly protectedCount?: number
  readonly mode: PersonaGenerationMode
  /** How many personas the run writes. */
  readonly personaCount: number
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

/** The ask before a generation starts; a replace that deletes personas is a danger dialog. */
export function PersonaGenerateConfirm({
  isOpen, existingCount, protectedCount = 0, mode, personaCount, onConfirm, onCancel,
}: PersonaGenerateConfirmProps) {
  const { t } = useTranslation('projectDetail')
  const deleted = existingCount - protectedCount
  const replacing = mode === 'replace' && deleted > 0
  const kept = mode === 'replace' && protectedCount > 0
    ? ` ${t('wizards.personaReplaceKeepsProtected', { count: protectedCount })}`
    : ''
  return (
    <ConfirmModal
      isOpen={isOpen}
      variant={replacing ? 'danger' : 'info'}
      title={t(replacing ? 'wizards.personaReplaceConfirmTitle' : 'wizards.personaConfirmTitle')}
      message={(replacing
        ? t('wizards.personaReplaceConfirmMessage', { count: deleted, n: personaCount })
        : t('wizards.personaConfirmMessage', { n: personaCount })) + kept}
      confirmLabel={t(replacing ? 'wizards.submitReplacePersonas' : 'wizards.submitGeneratePersonas')}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}
