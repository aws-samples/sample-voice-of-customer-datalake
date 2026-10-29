/**
 * PersonaEditModal - Modal for editing persona details
 *
 * Every label comes from the `personaEdit.*` catalogue and is tied to its
 * control with a generated id, so each field has an accessible name (axe
 * `label`) and the dialog reads in the user's language. The shell is
 * `ModalShell` for dialog semantics and the focus trap (deliberately not
 * dismissable — see the shell props below).
 */
import { BookOpen, Frown, IdCard, Loader2, Pencil, Quote, Target, User, type LucideIcon } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProjectPersona } from '../../api/projectTypes'
import DialogClose from '../../components/DialogClose/DialogClose'
import ModalShell from '../../components/ModalShell/ModalShell'
import { saveIgnoringFailure, useSnapshotGuard } from '../../components/UnsavedChangesGuard/useSnapshotGuard'

interface PersonaEditModalProps {
  readonly persona: ProjectPersona
  readonly onChange: (persona: ProjectPersona) => void
  /** Resolves once saved, rejects on failure (the unsaved-changes guard waits for it). */
  readonly onSave: () => Promise<unknown>
  readonly onClose: () => void
  readonly isSaving: boolean
}

// Sub-component props
interface InputFieldProps {
  readonly label: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly placeholder?: string
}

interface TextAreaFieldProps extends InputFieldProps { readonly rows?: number; readonly className?: string }

// Reusable input field
function InputField({
  label, value, onChange, placeholder,
}: InputFieldProps) {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-text mb-1">{label}</label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="input"
        placeholder={placeholder}
      />
    </div>
  )
}

// Reusable textarea field
function TextAreaField({
  label, value, onChange, placeholder, rows = 2, className = 'input',
}: TextAreaFieldProps) {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-text mb-1">{label}</label>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className={className}
        placeholder={placeholder}
      />
    </div>
  )
}

// Section header component
function SectionHeader({
  icon: Icon, title,
}: Readonly<{
  /** A lucide icon (KiroCrew rule: lucide only, never an emoji glyph). */
  icon: LucideIcon;
  title: string
}>) {
  return (
    <h3 className="text-sm font-semibold tracking-tight text-text-strong mb-3 flex items-center gap-2">
      <Icon size={16} className="text-muted shrink-0" aria-hidden="true" />
      {title}
    </h3>
  )
}

/** What every section receives: the persona being edited and the one way to change it. */
type SectionProps = Readonly<{
  persona: ProjectPersona
  onChange: (p: ProjectPersona) => void
}>

/** The persona's nested groups a section edits field by field. */
type PersonaGroup = 'identity' | 'goals_motivations' | 'pain_points' | 'scenario'

/**
 * `setField(group, field)` → a change handler that replaces one field of one
 * nested group, keeping the rest of the persona and of the group as they are.
 */
function fieldSetter({ persona, onChange }: SectionProps) {
  return <G extends PersonaGroup, F extends keyof NonNullable<ProjectPersona[G]>>(group: G, field: F) =>
    (value: NonNullable<ProjectPersona[G]>[F]) => onChange({ ...persona, [group]: { ...persona[group], [field]: value } })
}

/** One list item per non-blank line of a textarea. */
function toLines(value: string): string[] {
  return value.split('\n').filter((line) => line.trim() !== '')
}

// Basic Info Section
function BasicInfoSection({ persona, onChange }: SectionProps) {
  const { t } = useTranslation('projectDetail')
  return (
    <div>
      <SectionHeader icon={User} title={t('personaEdit.basicInfo')} />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <InputField
          label={t('personaEdit.name')}
          value={persona.name}
          onChange={(value) => onChange({ ...persona, name: value })}
        />
        <InputField
          label={t('personaEdit.tagline')}
          value={persona.tagline}
          onChange={(value) => onChange({ ...persona, tagline: value })}
        />
      </div>
    </div>
  )
}

// Identity & Demographics Section
function IdentitySection(props: SectionProps) {
  const { t } = useTranslation('projectDetail')
  const setField = fieldSetter(props)
  const identity = props.persona.identity
  return (
    <div>
      <SectionHeader icon={IdCard} title={t('personaEdit.identityDemographics')} />
      <TextAreaField
        label={t('personaEdit.bio')}
        value={identity?.bio ?? ''}
        onChange={setField('identity', 'bio')}
        placeholder={t('personaEdit.bioPlaceholder')}
      />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
        <InputField
          label={t('personaEdit.ageRange')}
          value={identity?.age_range ?? ''}
          onChange={setField('identity', 'age_range')}
          placeholder="25-35"
        />
        <InputField
          label={t('personaEdit.location')}
          value={identity?.location ?? ''}
          onChange={setField('identity', 'location')}
          placeholder={t('personaEdit.locationPlaceholder')}
        />
        <InputField
          label={t('personaEdit.occupation')}
          value={identity?.occupation ?? ''}
          onChange={setField('identity', 'occupation')}
          placeholder={t('personaEdit.occupationPlaceholder')}
        />
      </div>
    </div>
  )
}

// Goals & Motivations Section
function GoalsSection(props: SectionProps) {
  const { t } = useTranslation('projectDetail')
  const setField = fieldSetter(props)
  const goals = props.persona.goals_motivations
  const setSecondaryGoals = setField('goals_motivations', 'secondary_goals')
  return (
    <div>
      <SectionHeader icon={Target} title={t('personaEdit.goalsMotivations')} />
      <InputField
        label={t('personaEdit.primaryGoal')}
        value={goals?.primary_goal ?? ''}
        onChange={setField('goals_motivations', 'primary_goal')}
        placeholder={t('personaEdit.primaryGoalPlaceholder')}
      />
      <div className="mt-3">
        <TextAreaField
          label={t('personaEdit.secondaryGoals')}
          value={(goals?.secondary_goals ?? []).join('\n')}
          onChange={(value) => setSecondaryGoals(toLines(value))}
          className="input font-mono text-sm"
        />
      </div>
    </div>
  )
}

// Pain Points Section
function PainPointsSection(props: SectionProps) {
  const { t } = useTranslation('projectDetail')
  const setField = fieldSetter(props)
  const painPoints = props.persona.pain_points
  const setChallenges = setField('pain_points', 'current_challenges')
  const setWorkarounds = setField('pain_points', 'workarounds')
  return (
    <div>
      <SectionHeader icon={Frown} title={t('personaEdit.painPoints')} />
      <TextAreaField
        label={t('personaEdit.currentChallenges')}
        value={(painPoints?.current_challenges ?? []).join('\n')}
        onChange={(value) => setChallenges(toLines(value))}
        rows={3}
        className="input font-mono text-sm"
      />
      <div className="mt-3">
        <TextAreaField
          label={t('personaEdit.workarounds')}
          value={(painPoints?.workarounds ?? []).join('\n')}
          onChange={(value) => setWorkarounds(toLines(value))}
          placeholder={t('personaEdit.workaroundsPlaceholder')}
          className="input font-mono text-sm"
        />
      </div>
    </div>
  )
}

// Quote Section
function QuoteSection({ persona, onChange }: SectionProps) {
  const { t } = useTranslation('projectDetail')
  const quote = persona.quotes?.[0]?.text ?? ''

  const handleQuoteChange = (value: string) => {
    const existingQuotes = persona.quotes ?? []
    const updatedQuotes = existingQuotes.length > 0
      ? [{
        ...existingQuotes[0],
        text: value,
      }, ...existingQuotes.slice(1)]
      : [{ text: value }]
    onChange({
      ...persona,
      quotes: updatedQuotes,
    })
  }

  return (
    <div>
      <SectionHeader icon={Quote} title={t('personaEdit.representativeQuote')} />
      <textarea
        value={quote}
        onChange={(e) => handleQuoteChange(e.target.value)}
        rows={2}
        className="input"
        aria-label={t('personaEdit.representativeQuote')}
        placeholder={t('personaEdit.quotePlaceholder')}
      />
    </div>
  )
}

// Scenario Section
function ScenarioSection(props: SectionProps) {
  const { t } = useTranslation('projectDetail')
  const setField = fieldSetter(props)
  const scenario = props.persona.scenario ?? {}
  return (
    <div>
      <SectionHeader icon={BookOpen} title={t('personaEdit.scenario')} />
      <InputField
        label={t('personaEdit.scenarioTitle')}
        value={scenario.title ?? ''}
        onChange={setField('scenario', 'title')}
        placeholder={t('personaEdit.scenarioTitlePlaceholder')}
      />
      <div className="mt-3">
        <TextAreaField
          label={t('personaEdit.narrative')}
          value={scenario.narrative ?? ''}
          onChange={setField('scenario', 'narrative')}
          rows={3}
          placeholder={t('personaEdit.narrativePlaceholder')}
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
        <InputField
          label={t('personaEdit.triggerLabel')}
          value={scenario.trigger ?? ''}
          onChange={setField('scenario', 'trigger')}
          placeholder={t('personaEdit.triggerPlaceholder')}
        />
        <InputField
          label={t('personaEdit.desiredOutcome')}
          value={scenario.outcome ?? ''}
          onChange={setField('scenario', 'outcome')}
          placeholder={t('personaEdit.desiredOutcomePlaceholder')}
        />
      </div>
    </div>
  )
}

export default function PersonaEditModal({
  persona,
  onChange,
  onSave,
  onClose,
  isSaving,
}: PersonaEditModalProps) {
  const { t } = useTranslation('projectDetail')
  const titleId = useId()
  // Every exit (the X, Cancel, Escape, the backdrop) asks first when a field changed (E2E F6).
  const { close, dialog: guardDialog } = useSnapshotGuard({ value: persona, onSave, onClose })
  return (
    <ModalShell
      isOpen
      onClose={close}
      ariaLabelledBy={titleId}
      panelClassName="max-w-3xl max-h-[90vh]"
      // Escape/backdrop go through the guard; off only while a save is in flight.
      dismissable={!isSaving}
    >
        <div className="dialog-header justify-between">
          <h2 id={titleId} className="dialog-title">{t('personaEdit.title')}</h2>
          <DialogClose onClick={close} disabled={isSaving} />
        </div>
        <div className="dialog-body space-y-6">
          <BasicInfoSection persona={persona} onChange={onChange} />
          <IdentitySection persona={persona} onChange={onChange} />
          <GoalsSection persona={persona} onChange={onChange} />
          <PainPointsSection persona={persona} onChange={onChange} />
          <QuoteSection persona={persona} onChange={onChange} />
          <ScenarioSection persona={persona} onChange={onChange} />
        </div>
        <div className="dialog-footer flex-col-reverse sm:flex-row">
          <button type="button" onClick={close} disabled={isSaving} className="btn btn-secondary w-full sm:w-auto">{t('personaEdit.cancel')}</button>
          <button
            type="button"
            onClick={() => saveIgnoringFailure(onSave)}
            disabled={isSaving}
            className="btn btn-primary w-full sm:w-auto"
          >
            {isSaving ? (
              <><Loader2 size={16} className="animate-spin" aria-hidden />{t('personaEdit.saving')}</>
            ) : (
              <><Pencil size={16} aria-hidden />{t('personaEdit.saveChanges')}</>
            )}
          </button>
        </div>
        {guardDialog}
    </ModalShell>
  )
}
