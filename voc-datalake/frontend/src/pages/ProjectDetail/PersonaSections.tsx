import type { ProjectPersona } from '../../api/client'
import PersonaSection from './PersonaSection'

export function IdentitySection({ persona }: Readonly<{ persona: ProjectPersona }>) {
  const data = persona.identity ?? persona.demographics
  if (!data) return null

  const bio = persona.identity?.bio ?? persona.demographics?.bio

  return (
    <PersonaSection title="Identity & Demographics" icon="👤" color="purple">
      <div className="space-y-3">
        {bio && <p className="text-gray-700 text-sm leading-relaxed">{bio}</p>}
        <div className="flex flex-wrap gap-2">
          {Object.entries(data).map(([key, value]) =>
            value && key !== 'bio' ? (
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
  const hasGoals = persona.goals_motivations ?? (persona.goals && persona.goals.length > 0)
  if (!hasGoals) return null

  const secondaryGoals = persona.goals_motivations?.secondary_goals ?? persona.goals ?? []
  const motivations = persona.goals_motivations?.underlying_motivations ?? []

  return (
    <PersonaSection title="Goals & Motivations" icon="🎯" color="green">
      <div className="space-y-3">
        {persona.goals_motivations?.primary_goal && (
          <div className="p-3 bg-green-50 rounded-lg border border-green-100">
            <p className="text-xs text-green-600 font-medium mb-1">Primary Goal</p>
            <p className="text-gray-700 text-sm">{persona.goals_motivations.primary_goal}</p>
          </div>
        )}
        <GoalsList goals={secondaryGoals} label="Secondary Goals" />
        <GoalsList goals={motivations} label="Underlying Motivations" />
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
  const hasPainPoints = persona.pain_points ?? (persona.frustrations && persona.frustrations.length > 0)
  if (!hasPainPoints) return null

  const challenges = persona.pain_points?.current_challenges ?? persona.frustrations ?? []
  const blockers = persona.pain_points?.blockers ?? []
  const workarounds = persona.pain_points?.workarounds ?? []

  return (
    <PersonaSection title="Pain Points & Frustrations" icon="😤" color="red">
      <div className="space-y-3">
        <PainPointsList items={challenges} label="Current Challenges" />
        <PainPointsList items={blockers} label="Blockers" />
        <PainPointsList items={workarounds} label="Current Workarounds" />
      </div>
    </PersonaSection>
  )
}

interface BehaviorsObject {
  current_solutions?: string[]
  tech_savviness?: string
  activity_frequency?: string
  decision_style?: string
  tools_used?: string[]
}

function isBehaviorsObject(b: unknown): b is BehaviorsObject {
  return typeof b === 'object' && b !== null && !Array.isArray(b)
}

export function BehaviorsSection({ persona }: Readonly<{ persona: ProjectPersona }>) {
  if (!persona.behaviors) return null

  if (Array.isArray(persona.behaviors) && persona.behaviors.length > 0) {
    return (
      <PersonaSection title="Behaviors" icon="🔄" color="blue">
        <ul className="list-disc list-inside text-gray-600 text-sm space-y-1">
          {persona.behaviors.map((b: string, i: number) => <li key={i}>{b}</li>)}
        </ul>
      </PersonaSection>
    )
  }

  if (!isBehaviorsObject(persona.behaviors)) return null

  const behaviors = persona.behaviors
  const solutions = behaviors.current_solutions ?? []
  const tools = behaviors.tools_used ?? []

  return (
    <PersonaSection title="Behaviors & Habits" icon="🔄" color="blue">
      <div className="space-y-3">
        {solutions.length > 0 && (
          <div>
            <p className="text-xs text-gray-500 font-medium mb-2">Current Solutions</p>
            <ul className="list-disc list-inside text-gray-600 text-sm space-y-1">
              {solutions.map((s: string, i: number) => <li key={i}>{s}</li>)}
            </ul>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {behaviors.tech_savviness && (
            <span className="px-2 py-1 bg-blue-50 border border-blue-100 rounded text-xs text-blue-700">
              Tech: {behaviors.tech_savviness}
            </span>
          )}
          {behaviors.activity_frequency && (
            <span className="px-2 py-1 bg-blue-50 border border-blue-100 rounded text-xs text-blue-700">
              {behaviors.activity_frequency}
            </span>
          )}
          {behaviors.decision_style && (
            <span className="px-2 py-1 bg-blue-50 border border-blue-100 rounded text-xs text-blue-700">
              {behaviors.decision_style}
            </span>
          )}
        </div>
        {tools.length > 0 && (
          <div>
            <p className="text-xs text-gray-500 font-medium mb-2">Tools Used</p>
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
  if (!persona.context_environment) return null

  return (
    <PersonaSection title="Context & Environment" icon="🌍" color="amber">
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
            <span className="font-medium">Time constraints:</span> {persona.context_environment.time_constraints}
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
  const hasQuotes = (persona.quotes?.length ?? 0) > 0 || persona.quote
  if (!hasQuotes) return null

  const quotes = persona.quotes ?? (persona.quote ? [{ text: persona.quote }] : [])

  return (
    <PersonaSection title="Representative Quotes" icon="💬" color="indigo">
      <div className="space-y-3">
        {quotes.map((q: { text: string; context?: string }, i: number) => (
          <QuoteBlock key={i} text={q.text} context={q.context} />
        ))}
      </div>
    </PersonaSection>
  )
}

export function ScenarioSection({ persona }: Readonly<{ persona: ProjectPersona }>) {
  if (!persona.scenario) return null

  if (typeof persona.scenario === 'string') {
    return (
      <PersonaSection title="Scenario" icon="📖" color="teal">
        <p className="text-gray-700 text-sm leading-relaxed">{persona.scenario}</p>
      </PersonaSection>
    )
  }

  return (
    <PersonaSection title="Scenario" icon="📖" color="teal">
      <div className="space-y-3">
        {persona.scenario.title && <h5 className="font-medium text-gray-900">{persona.scenario.title}</h5>}
        {persona.scenario.narrative && <p className="text-gray-700 text-sm leading-relaxed">{persona.scenario.narrative}</p>}
        {(persona.scenario.trigger || persona.scenario.outcome) && (
          <div className="flex gap-4 text-sm">
            {persona.scenario.trigger && (
              <div className="flex-1 p-2 bg-teal-50 rounded">
                <p className="text-xs text-teal-600 font-medium">Trigger</p>
                <p className="text-gray-600">{persona.scenario.trigger}</p>
              </div>
            )}
            {persona.scenario.outcome && (
              <div className="flex-1 p-2 bg-teal-50 rounded">
                <p className="text-xs text-teal-600 font-medium">Desired Outcome</p>
                <p className="text-gray-600">{persona.scenario.outcome}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </PersonaSection>
  )
}

export function NeedsSection({ persona }: Readonly<{ persona: ProjectPersona }>) {
  if (!persona.needs || persona.needs.length === 0 || persona.goals_motivations) return null

  return (
    <PersonaSection title="Needs" icon="✨" color="emerald">
      <ul className="list-disc list-inside text-gray-600 text-sm space-y-1">
        {persona.needs.map((n: string, i: number) => <li key={i}>{n}</li>)}
      </ul>
    </PersonaSection>
  )
}
