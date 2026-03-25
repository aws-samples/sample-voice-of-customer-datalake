import type { ProjectPersona } from '../../api/client'
import { useTranslation } from 'react-i18next'
import PersonaSection from './PersonaSection'

export function IdentitySection({ persona }: Readonly<{ persona: ProjectPersona }>) {
  const { t } = useTranslation('projectDetail')
  if (!persona.identity) return null

  const { bio, ...attributes } = persona.identity

  return (
    <PersonaSection title={t('personaSections.identityDemographics')} icon="👤" color="purple">
      <div className="space-y-3">
        {bio && <p className="text-gray-700 text-sm leading-relaxed">{bio}</p>}
        <div className="flex flex-wrap gap-2">
          {Object.entries(attributes).map(([key, value]) =>
            value ? (
              <span key={key} className="px-2 py-1 bg-purple-50 border border-purple-100 rounded text-xs text-purple-700">
                {key.replace(/_/g, ' ')}: {String(value)}
              </span>
            ) : null
          )}
        </div>
      </div>
    </PersonaSection>
  )
}

function GoalsList({ goals, label }: Readonly<{ goals: string[]; label: string }>) {
  if (goals.length === 0) return null
  return (
    <div>
      <p className="text-xs text-gray-500 font-medium mb-2">{label}</p>
      <ul className="list-disc list-inside text-gray-600 text-sm space-y-1">
        {goals.map((g: string, i: number) => <li key={i}>{g}</li>)}
      </ul>
    </div>
  )
}

export function GoalsSection({ persona }: Readonly<{ persona: ProjectPersona }>) {
  const { t } = useTranslation('projectDetail')
  if (!persona.goals_motivations) return null

  const secondaryGoals = persona.goals_motivations.secondary_goals ?? []
  const motivations = persona.goals_motivations.underlying_motivations ?? []

  return (
    <PersonaSection title={t('personaSections.goalsMotivations')} icon="🎯" color="green">
      <div className="space-y-3">
        {persona.goals_motivations.primary_goal && (
          <div className="p-3 bg-green-50 rounded-lg border border-green-100">
            <p className="text-xs text-green-600 font-medium mb-1">{t('personaSections.primaryGoal')}</p>
            <p className="text-gray-700 text-sm">{persona.goals_motivations.primary_goal}</p>
          </div>
        )}
        <GoalsList goals={secondaryGoals} label={t('personaSections.secondaryGoals')} />
        <GoalsList goals={motivations} label={t('personaSections.underlyingMotivations')} />
      </div>
    </PersonaSection>
  )
}

function PainPointsList({ items, label }: Readonly<{ items: string[]; label: string }>) {
  if (items.length === 0) return null
  return (
    <div>
      <p className="text-xs text-gray-500 font-medium mb-2">{label}</p>
      <ul className="list-disc list-inside text-gray-600 text-sm space-y-1">
        {items.map((item: string, i: number) => <li key={i}>{item}</li>)}
      </ul>
    </div>
  )
}

export function PainPointsSection({ persona }: Readonly<{ persona: ProjectPersona }>) {
  const { t } = useTranslation('projectDetail')
  if (!persona.pain_points) return null

  const challenges = persona.pain_points.current_challenges ?? []
  const blockers = persona.pain_points.blockers ?? []
  const workarounds = persona.pain_points.workarounds ?? []

  return (
    <PersonaSection title={t('personaSections.painPoints')} icon="😤" color="red">
      <div className="space-y-3">
        <PainPointsList items={challenges} label={t('personaSections.currentChallenges')} />
        <PainPointsList items={blockers} label={t('personaSections.blockers')} />
        <PainPointsList items={workarounds} label={t('personaSections.currentWorkarounds')} />
      </div>
    </PersonaSection>
  )
}

export function BehaviorsSection({ persona }: Readonly<{ persona: ProjectPersona }>) {
  const { t } = useTranslation('projectDetail')
  if (!persona.behaviors) return null

  const solutions = persona.behaviors.current_solutions ?? []
  const tools = persona.behaviors.tools_used ?? []

  return (
    <PersonaSection title={t('personaSections.behaviorsHabits')} icon="🔄" color="blue">
      <div className="space-y-3">
        {solutions.length > 0 && (
          <div>
            <p className="text-xs text-gray-500 font-medium mb-2">{t('personaSections.currentSolutions')}</p>
            <ul className="list-disc list-inside text-gray-600 text-sm space-y-1">
              {solutions.map((s: string, i: number) => <li key={i}>{s}</li>)}
            </ul>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {persona.behaviors.tech_savviness && (
            <span className="px-2 py-1 bg-blue-50 border border-blue-100 rounded text-xs text-blue-700">
              Tech: {persona.behaviors.tech_savviness}
            </span>
          )}
          {persona.behaviors.activity_frequency && (
            <span className="px-2 py-1 bg-blue-50 border border-blue-100 rounded text-xs text-blue-700">
              {persona.behaviors.activity_frequency}
            </span>
          )}
          {persona.behaviors.decision_style && (
            <span className="px-2 py-1 bg-blue-50 border border-blue-100 rounded text-xs text-blue-700">
              {persona.behaviors.decision_style}
            </span>
          )}
        </div>
        {tools.length > 0 && (
          <div>
            <p className="text-xs text-gray-500 font-medium mb-2">{t('personaSections.toolsUsed')}</p>
            <div className="flex flex-wrap gap-1">
              {tools.map((t: string, i: number) => (
                <span key={i} className="px-2 py-0.5 bg-gray-100 rounded text-xs text-gray-600">{t}</span>
              ))}
            </div>
          </div>
        )}
      </div>
    </PersonaSection>
  )
}

export function ContextSection({ persona }: Readonly<{ persona: ProjectPersona }>) {
  const { t } = useTranslation('projectDetail')
  if (!persona.context_environment) return null

  return (
    <PersonaSection title={t('personaSections.contextEnvironment')} icon="🌍" color="amber">
      <div className="space-y-3">
        {persona.context_environment.usage_context && (
          <p className="text-gray-700 text-sm">{persona.context_environment.usage_context}</p>
        )}
        <div className="flex flex-wrap gap-2">
          {persona.context_environment.devices?.map((d: string, i: number) => (
            <span key={i} className="px-2 py-1 bg-amber-50 border border-amber-100 rounded text-xs text-amber-700">{d}</span>
          ))}
        </div>
        {persona.context_environment.time_constraints && (
          <p className="text-gray-600 text-sm">
            <span className="font-medium">{t('personaSections.timeConstraints')}</span> {persona.context_environment.time_constraints}
          </p>
        )}
      </div>
    </PersonaSection>
  )
}

function QuoteBlock({ text, context }: Readonly<{ text: string; context?: string }>) {
  return (
    <blockquote className="border-l-4 border-indigo-300 pl-4 py-1">
      <p className="text-gray-700 text-sm italic">"{text}"</p>
      {context && <p className="text-gray-400 text-xs mt-1">— {context}</p>}
    </blockquote>
  )
}

export function QuotesSection({ persona }: Readonly<{ persona: ProjectPersona }>) {
  const { t } = useTranslation('projectDetail')
  if (!persona.quotes || persona.quotes.length === 0) return null

  return (
    <PersonaSection title={t('personaSections.representativeQuotes')} icon="💬" color="indigo">
      <div className="space-y-3">
        {persona.quotes.map((q: { text: string; context?: string }, i: number) => (
          <QuoteBlock key={i} text={q.text} context={q.context} />
        ))}
      </div>
    </PersonaSection>
  )
}

export function ScenarioSection({ persona }: Readonly<{ persona: ProjectPersona }>) {
  const { t } = useTranslation('projectDetail')
  if (!persona.scenario) return null

  return (
    <PersonaSection title={t('personaSections.scenario')} icon="📖" color="teal">
      <div className="space-y-3">
        {persona.scenario.title && <h5 className="font-medium text-gray-900">{persona.scenario.title}</h5>}
        {persona.scenario.narrative && <p className="text-gray-700 text-sm leading-relaxed">{persona.scenario.narrative}</p>}
        {(persona.scenario.trigger || persona.scenario.outcome) && (
          <div className="flex gap-4 text-sm">
            {persona.scenario.trigger && (
              <div className="flex-1 p-2 bg-teal-50 rounded">
                <p className="text-xs text-teal-600 font-medium">{t('personaSections.trigger')}</p>
                <p className="text-gray-600">{persona.scenario.trigger}</p>
              </div>
            )}
            {persona.scenario.outcome && (
              <div className="flex-1 p-2 bg-teal-50 rounded">
                <p className="text-xs text-teal-600 font-medium">{t('personaSections.desiredOutcome')}</p>
                <p className="text-gray-600">{persona.scenario.outcome}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </PersonaSection>
  )
}
