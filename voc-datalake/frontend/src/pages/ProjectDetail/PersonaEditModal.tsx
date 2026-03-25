/**
 * PersonaEditModal - Modal for editing persona details
 */
import { X, Loader2, Pencil } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ProjectPersona } from '../../api/client'

interface PersonaEditModalProps {
  readonly persona: ProjectPersona
  readonly onChange: (persona: ProjectPersona) => void
  readonly onSave: () => void
  readonly onClose: () => void
  readonly isSaving: boolean
}

// Sub-component props
interface InputFieldProps {
  readonly label: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly placeholder?: string
  readonly className?: string
}

interface TextAreaFieldProps extends InputFieldProps {
  readonly rows?: number
}

// Reusable input field
function InputField({ label, value, onChange, placeholder, className = 'w-full px-3 py-2 border rounded-lg' }: InputFieldProps) {
  return (
    <div>
      <label className="block text-sm font-medium mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        className={className}
        placeholder={placeholder}
      />
    </div>
  )
}

// Reusable textarea field
function TextAreaField({ label, value, onChange, placeholder, rows = 2, className = 'w-full px-3 py-2 border rounded-lg' }: TextAreaFieldProps) {
  return (
    <div>
      <label className="block text-sm font-medium mb-1">{label}</label>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={rows}
        className={className}
        placeholder={placeholder}
      />
    </div>
  )
}

// Small input field for demographics
function SmallInputField({ label, value, onChange, placeholder }: InputFieldProps) {
  return (
    <div>
      <label className="block text-xs font-medium mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full px-2 py-1.5 border rounded text-sm"
        placeholder={placeholder}
      />
    </div>
  )
}

// Section header component
function SectionHeader({ emoji, title }: Readonly<{ emoji: string; title: string }>) {
  return (
    <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
      {emoji} {title}
    </h3>
  )
}

// Basic Info Section
function BasicInfoSection({ persona, onChange }: Readonly<{ persona: ProjectPersona; onChange: (p: ProjectPersona) => void }>) {
  return (
    <div>
      <SectionHeader emoji="👤" title="Basic Info" />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <InputField
          label="Name"
          value={persona.name}
          onChange={value => onChange({ ...persona, name: value })}
        />
        <InputField
          label="Tagline"
          value={persona.tagline}
          onChange={value => onChange({ ...persona, tagline: value })}
        />
      </div>
    </div>
  )
}

// Identity & Demographics Section
function IdentitySection({ persona, onChange }: Readonly<{ persona: ProjectPersona; onChange: (p: ProjectPersona) => void }>) {
  const bio = persona.identity?.bio ?? ''
  
  return (
    <div>
      <SectionHeader emoji="🪪" title="Identity & Demographics" />
      <TextAreaField
        label="Bio"
        value={bio}
        onChange={value => onChange({ ...persona, identity: { ...persona.identity, bio: value } })}
        placeholder="Brief background story..."
      />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
        <SmallInputField
          label="Age Range"
          value={persona.identity?.age_range ?? ''}
          onChange={value => onChange({ ...persona, identity: { ...persona.identity, age_range: value } })}
          placeholder="25-35"
        />
        <SmallInputField
          label="Location"
          value={persona.identity?.location ?? ''}
          onChange={value => onChange({ ...persona, identity: { ...persona.identity, location: value } })}
          placeholder="Urban, US"
        />
        <SmallInputField
          label="Occupation"
          value={persona.identity?.occupation ?? ''}
          onChange={value => onChange({ ...persona, identity: { ...persona.identity, occupation: value } })}
          placeholder="Product Manager"
        />
      </div>
    </div>
  )
}

// Goals & Motivations Section
function GoalsSection({ persona, onChange }: Readonly<{ persona: ProjectPersona; onChange: (p: ProjectPersona) => void }>) {
  const secondaryGoals = persona.goals_motivations?.secondary_goals ?? []
  
  const handleGoalsChange = (value: string) => {
    const goals = value.split('\n').filter(g => g.trim())
    onChange({
      ...persona,
      goals_motivations: { ...persona.goals_motivations, secondary_goals: goals },
    })
  }
  
  return (
    <div>
      <SectionHeader emoji="🎯" title="Goals & Motivations" />
      <InputField
        label="Primary Goal"
        value={persona.goals_motivations?.primary_goal ?? ''}
        onChange={value => onChange({ ...persona, goals_motivations: { ...persona.goals_motivations, primary_goal: value } })}
        placeholder="Main objective..."
      />
      <div className="mt-3">
        <TextAreaField
          label="Secondary Goals (one per line)"
          value={secondaryGoals.join('\n')}
          onChange={handleGoalsChange}
          className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
        />
      </div>
    </div>
  )
}

// Pain Points Section
function PainPointsSection({ persona, onChange }: Readonly<{ persona: ProjectPersona; onChange: (p: ProjectPersona) => void }>) {
  const challenges = persona.pain_points?.current_challenges ?? []
  const workarounds = persona.pain_points?.workarounds ?? []
  
  const handleChallengesChange = (value: string) => {
    const items = value.split('\n').filter(f => f.trim())
    onChange({
      ...persona,
      pain_points: { ...persona.pain_points, current_challenges: items },
    })
  }
  
  const handleWorkaroundsChange = (value: string) => {
    const items = value.split('\n').filter(w => w.trim())
    onChange({
      ...persona,
      pain_points: { ...persona.pain_points, workarounds: items },
    })
  }
  
  return (
    <div>
      <SectionHeader emoji="😤" title="Pain Points & Frustrations" />
      <TextAreaField
        label="Current Challenges (one per line)"
        value={challenges.join('\n')}
        onChange={handleChallengesChange}
        rows={3}
        className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
      />
      <div className="mt-3">
        <TextAreaField
          label="Workarounds (one per line)"
          value={workarounds.join('\n')}
          onChange={handleWorkaroundsChange}
          placeholder="How they currently cope..."
          className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
        />
      </div>
    </div>
  )
}

// Quote Section
function QuoteSection({ persona, onChange }: Readonly<{ persona: ProjectPersona; onChange: (p: ProjectPersona) => void }>) {
  const quote = persona.quotes?.[0]?.text ?? ''
  
  const handleQuoteChange = (value: string) => {
    const existingQuotes = persona.quotes ?? []
    const updatedQuotes = existingQuotes.length > 0
      ? [{ ...existingQuotes[0], text: value }, ...existingQuotes.slice(1)]
      : [{ text: value }]
    onChange({ ...persona, quotes: updatedQuotes })
  }
  
  return (
    <div>
      <SectionHeader emoji="💬" title="Representative Quote" />
      <textarea
        value={quote}
        onChange={e => handleQuoteChange(e.target.value)}
        rows={2}
        className="w-full px-3 py-2 border rounded-lg"
        placeholder="A quote that captures their voice..."
      />
    </div>
  )
}

// Scenario Section
function ScenarioSection({ persona, onChange }: Readonly<{ persona: ProjectPersona; onChange: (p: ProjectPersona) => void }>) {
  const scenario = persona.scenario ?? {}
  
  const updateScenarioField = (field: 'title' | 'narrative' | 'trigger' | 'outcome', value: string) => {
    onChange({
      ...persona,
      scenario: { ...scenario, [field]: value },
    })
  }
  
  return (
    <div>
      <SectionHeader emoji="📖" title="Scenario" />
      <InputField
        label="Title"
        value={scenario.title ?? ''}
        onChange={value => updateScenarioField('title', value)}
        placeholder="Scenario title..."
      />
      <div className="mt-3">
        <TextAreaField
          label="Narrative"
          value={scenario.narrative ?? ''}
          onChange={value => updateScenarioField('narrative', value)}
          rows={3}
          placeholder="A story showing them in action..."
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
        <SmallInputField
          label="Trigger"
          value={scenario.trigger ?? ''}
          onChange={value => updateScenarioField('trigger', value)}
          placeholder="What triggers this scenario"
        />
        <SmallInputField
          label="Desired Outcome"
          value={scenario.outcome ?? ''}
          onChange={value => updateScenarioField('outcome', value)}
          placeholder="What they hope to achieve"
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
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-3xl max-h-[90vh] overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold">{t('personaEdit.title')}</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg"><X size={20} /></button>
        </div>
        <div className="p-4 sm:p-6 space-y-6 overflow-y-auto max-h-[65vh]">
          <BasicInfoSection persona={persona} onChange={onChange} />
          <IdentitySection persona={persona} onChange={onChange} />
          <GoalsSection persona={persona} onChange={onChange} />
          <PainPointsSection persona={persona} onChange={onChange} />
          <QuoteSection persona={persona} onChange={onChange} />
          <ScenarioSection persona={persona} onChange={onChange} />
        </div>
        <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 sm:gap-3 p-4 border-t bg-gray-50">
          <button onClick={onClose} className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg">{t('personaEdit.cancel')}</button>
          <button
            onClick={onSave}
            disabled={isSaving}
            className="flex items-center justify-center gap-2 px-6 py-2 bg-purple-600 text-white rounded-lg disabled:opacity-50"
          >
            {isSaving ? (
              <><Loader2 size={16} className="animate-spin" />{t('personaEdit.saving')}</>
            ) : (
              <><Pencil size={16} />{t('personaEdit.saveChanges')}</>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
