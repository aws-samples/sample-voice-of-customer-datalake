import { useTranslation } from 'react-i18next'
import { BookOpen, Frown, Globe, Quote, Repeat, Target, User } from 'lucide-react'
import PersonaSection from './PersonaSection'
import { scenarioTriggerOutcome } from '../../components/PersonaExportMenu/scenarioTriggerOutcome'
import type { ProjectPersona } from '../../api/projectTypes'

export function IdentitySection({ persona }: Readonly<{ persona: ProjectPersona }>) {
  const { t } = useTranslation('projectDetail')
  if (!persona.identity) return null

  const {
    bio, ...attributes
  } = persona.identity

  return (
    <PersonaSection title={t('personaSections.identityDemographics')} icon={User} color="aim">
      <div className="space-y-3">
        {bio != null && bio !== '' ? <p className="text-text text-sm leading-relaxed">{bio}</p> : null}
        <div className="flex flex-wrap gap-2">
          {Object.entries(attributes).map(([key, value]) =>
            value === '' ? null : (
              <span key={key} className="px-2 py-1 bg-aim-subtle border border-aim/20 rounded-sm text-xs text-aim">
                {key.replaceAll('_', ' ')}: {String(value)}
              </span>
            ),
          )}
        </div>
      </div>
    </PersonaSection>
  )
}

function GoalsList({
  goals, label,
}: Readonly<{
  goals: string[];
  label: string
}>) {
  if (goals.length === 0) return null
  return (
    <div>
      <p className="text-xs text-muted font-medium mb-2">{label}</p>
      <ul className="list-disc list-inside text-text text-sm space-y-1">
        {goals.map((g: string) => <li key={g}>{g}</li>)}
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
    <PersonaSection title={t('personaSections.goalsMotivations')} icon={Target} color="ok">
      <div className="space-y-3">
        {persona.goals_motivations.primary_goal != null && persona.goals_motivations.primary_goal !== '' ? <div className="p-3 bg-ok-subtle rounded-lg border border-ok/30">
          <p className="text-xs text-ok font-medium mb-1">{t('personaSections.primaryGoal')}</p>
          <p className="text-text text-sm">{persona.goals_motivations.primary_goal}</p>
        </div> : null}
        <GoalsList goals={secondaryGoals} label={t('personaSections.secondaryGoals')} />
        <GoalsList goals={motivations} label={t('personaSections.underlyingMotivations')} />
      </div>
    </PersonaSection>
  )
}

function PainPointsList({
  items, label,
}: Readonly<{
  items: string[];
  label: string
}>) {
  if (items.length === 0) return null
  return (
    <div>
      <p className="text-xs text-muted font-medium mb-2">{label}</p>
      <ul className="list-disc list-inside text-text text-sm space-y-1">
        {items.map((item: string) => <li key={item}>{item}</li>)}
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
    <PersonaSection title={t('personaSections.painPoints')} icon={Frown} color="danger">
      <div className="space-y-3">
        <PainPointsList items={challenges} label={t('personaSections.currentChallenges')} />
        <PainPointsList items={blockers} label={t('personaSections.blockers')} />
        <PainPointsList items={workarounds} label={t('personaSections.currentWorkarounds')} />
      </div>
    </PersonaSection>
  )
}

function BehaviorBadges({ behaviors }: Readonly<{ behaviors: NonNullable<ProjectPersona['behaviors']> }>) {
  return (
    <div className="flex flex-wrap gap-2">
      {behaviors.tech_savviness != null && behaviors.tech_savviness !== '' ? <span className="px-2 py-1 bg-info-subtle border border-info/20 rounded-sm text-xs text-info">
        Tech: {behaviors.tech_savviness}
      </span> : null}
      {behaviors.activity_frequency != null && behaviors.activity_frequency !== '' ? <span className="px-2 py-1 bg-info-subtle border border-info/20 rounded-sm text-xs text-info">
        {behaviors.activity_frequency}
      </span> : null}
      {behaviors.decision_style != null && behaviors.decision_style !== '' ? <span className="px-2 py-1 bg-info-subtle border border-info/20 rounded-sm text-xs text-info">
        {behaviors.decision_style}
      </span> : null}
    </div>
  )
}

export function BehaviorsSection({ persona }: Readonly<{ persona: ProjectPersona }>) {
  const { t } = useTranslation('projectDetail')
  if (!persona.behaviors) return null

  const solutions = persona.behaviors.current_solutions ?? []
  const tools = persona.behaviors.tools_used ?? []

  return (
    <PersonaSection title={t('personaSections.behaviorsHabits')} icon={Repeat} color="info">
      <div className="space-y-3">
        {solutions.length > 0 && (
          <div>
            <p className="text-xs text-muted font-medium mb-2">{t('personaSections.currentSolutions')}</p>
            <ul className="list-disc list-inside text-text text-sm space-y-1">
              {solutions.map((s: string) => <li key={s}>{s}</li>)}
            </ul>
          </div>
        )}
        <BehaviorBadges behaviors={persona.behaviors} />
        {tools.length > 0 && (
          <div>
            <p className="text-xs text-muted font-medium mb-2">{t('personaSections.toolsUsed')}</p>
            <div className="flex flex-wrap gap-1">
              {tools.map((tool: string) => (
                <span key={tool} className="px-2 py-0.5 bg-bg-hover rounded-sm text-xs text-text">{tool}</span>
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
    <PersonaSection title={t('personaSections.contextEnvironment')} icon={Globe} color="warn">
      <div className="space-y-3">
        {persona.context_environment.usage_context != null && persona.context_environment.usage_context !== '' ? <p className="text-text text-sm">{persona.context_environment.usage_context}</p> : null}
        <div className="flex flex-wrap gap-2">
          {persona.context_environment.devices?.map((d: string) => (
            <span key={d} className="px-2 py-1 bg-warn-subtle border border-warn/30 rounded-sm text-xs text-warn">{d}</span>
          ))}
        </div>
        {persona.context_environment.time_constraints != null && persona.context_environment.time_constraints !== '' ? <p className="text-text text-sm">
          <span className="font-medium">{t('personaSections.timeConstraints')}</span> {persona.context_environment.time_constraints}
        </p> : null}
      </div>
    </PersonaSection>
  )
}

function QuoteBlock({
  text, context,
}: Readonly<{
  text: string;
  context?: string
}>) {
  return (
    <blockquote className="border-l-4 border-accent/40 pl-4 py-1">
      <p className="text-text text-sm italic">"{text}"</p>
      {context != null && context !== '' ? <p className="text-muted text-xs mt-1">— {context}</p> : null}
    </blockquote>
  )
}

export function QuotesSection({ persona }: Readonly<{ persona: ProjectPersona }>) {
  const { t } = useTranslation('projectDetail')
  if (!persona.quotes || persona.quotes.length === 0) return null

  return (
    <PersonaSection title={t('personaSections.representativeQuotes')} icon={Quote} color="accent">
      <div className="space-y-3">
        {persona.quotes.map((q: {
          text: string;
          context?: string
        }) => (
          <QuoteBlock key={q.text} text={q.text} context={q.context} />
        ))}
      </div>
    </PersonaSection>
  )
}

function ScenarioDetails({ scenario }: Readonly<{ scenario: NonNullable<ProjectPersona['scenario']> }>) {
  const { t } = useTranslation('projectDetail')
  const parts = scenarioTriggerOutcome(scenario)
  if (parts === null) return null

  return (
    <div className="flex gap-4 text-sm">
      {parts.trigger === null ? null : <div className="flex-1 p-2 bg-info-subtle rounded-sm">
        <p className="text-xs text-info font-medium">{t('personaSections.trigger')}</p>
        <p className="text-text">{parts.trigger}</p>
      </div>}
      {parts.outcome === null ? null : <div className="flex-1 p-2 bg-info-subtle rounded-sm">
        <p className="text-xs text-info font-medium">{t('personaSections.desiredOutcome')}</p>
        <p className="text-text">{parts.outcome}</p>
      </div>}
    </div>
  )
}

export function ScenarioSection({ persona }: Readonly<{ persona: ProjectPersona }>) {
  const { t } = useTranslation('projectDetail')
  if (!persona.scenario) return null

  return (
    <PersonaSection title={t('personaSections.scenario')} icon={BookOpen} color="info">
      <div className="space-y-3">
        {persona.scenario.title != null && persona.scenario.title !== '' ? <h4 className="font-medium text-text-strong">{persona.scenario.title}</h4> : null}
        {persona.scenario.narrative != null && persona.scenario.narrative !== '' ? <p className="text-text text-sm leading-relaxed">{persona.scenario.narrative}</p> : null}
        <ScenarioDetails scenario={persona.scenario} />
      </div>
    </PersonaSection>
  )
}
