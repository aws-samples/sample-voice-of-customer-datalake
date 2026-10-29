/**
 * Add-or-replace for persona generation (#353).
 *
 * A project that already has personas is asked what the new run does to them: `add`
 * (the default, non-destructive) keeps them and writes different ones next to them;
 * `replace` deletes them first, so its confirmation is a danger dialog that counts
 * what goes. A project with no personas sees neither the choice nor the warning.
 */
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import RadioCard from '../../components/RadioCard/RadioCard'
import type { PersonaGenerationMode } from './types'

const MODES: ReadonlyArray<{ value: PersonaGenerationMode; titleKey: string; hintKey: string }> = [
  { value: 'add', titleKey: 'projectDetail:wizards.personaModeAdd', hintKey: 'projectDetail:wizards.personaModeAddHint' },
  { value: 'replace', titleKey: 'projectDetail:wizards.personaModeReplace', hintKey: 'projectDetail:wizards.personaModeReplaceHint' },
]

interface PersonaModeChoiceProps {
  /** How many personas the project has now; 0 renders nothing. */
  readonly existingCount: number
  readonly mode: PersonaGenerationMode
  readonly onChange: (mode: PersonaGenerationMode) => void
}

export function PersonaModeChoice({ existingCount, mode, onChange }: PersonaModeChoiceProps) {
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
          hint={t(m.hintKey, { count: existingCount })}
        />
      ))}
    </fieldset>
  )
}

interface PersonaGenerateConfirmProps {
  readonly isOpen: boolean
  readonly existingCount: number
  readonly mode: PersonaGenerationMode
  /** How many personas the run writes. */
  readonly personaCount: number
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

/** The ask before a generation starts; a replace that deletes personas is a danger dialog. */
export function PersonaGenerateConfirm({
  isOpen, existingCount, mode, personaCount, onConfirm, onCancel,
}: PersonaGenerateConfirmProps) {
  const { t } = useTranslation('projectDetail')
  const replacing = mode === 'replace' && existingCount > 0
  return (
    <ConfirmModal
      isOpen={isOpen}
      variant={replacing ? 'danger' : 'info'}
      title={t(replacing ? 'wizards.personaReplaceConfirmTitle' : 'wizards.personaConfirmTitle')}
      message={replacing
        ? t('wizards.personaReplaceConfirmMessage', { count: existingCount, n: personaCount })
        : t('wizards.personaConfirmMessage', { n: personaCount })}
      confirmLabel={t(replacing ? 'wizards.submitReplacePersonas' : 'wizards.submitGeneratePersonas')}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}
