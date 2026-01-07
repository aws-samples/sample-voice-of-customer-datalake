/**
 * @fileoverview PDF content component for persona export.
 * @module components/PersonaExportMenu/PersonaPDFContent
 */

import type { ProjectPersona } from '../../api/client'

interface PersonaPDFContentProps {
  readonly persona: ProjectPersona
}

function getConfidenceStyle(confidence: string): { bg: string; color: string } {
  if (confidence === 'high') return { bg: '#dcfce7', color: '#166534' }
  if (confidence === 'medium') return { bg: '#fef9c3', color: '#854d0e' }
  return { bg: '#f3f4f6', color: '#374151' }
}

function HeaderSection({ persona }: PersonaPDFContentProps) {
  const confidenceStyle = persona.confidence ? getConfidenceStyle(persona.confidence) : null
  const feedbackText = persona.feedback_count ? ` • ${persona.feedback_count} reviews` : ''

  return (
    <div data-pdf-section style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '24px' }}>
      {persona.avatar_url ? (
        <img
          src={persona.avatar_url}
          alt={persona.name}
          style={{
            width: '80px', height: '80px', borderRadius: '50%',
            objectFit: 'cover', border: '3px solid #e9d5ff'
          }}
          crossOrigin="anonymous"
        />
      ) : (
        <div style={{
          width: '80px', height: '80px', borderRadius: '50%',
          background: 'linear-gradient(135deg, #8b5cf6, #ec4899)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'white', fontSize: '32px', fontWeight: 'bold'
        }}>
          {persona.name.charAt(0)}
        </div>
      )}
      <div>
        <h1 style={{ fontSize: '28px', fontWeight: 'bold', margin: 0, color: '#111827' }}>{persona.name}</h1>
        <p style={{ fontSize: '16px', color: '#6b7280', margin: '4px 0 0 0' }}>{persona.tagline}</p>
        {confidenceStyle && (
          <span style={{
            display: 'inline-block', marginTop: '8px', padding: '4px 12px',
            backgroundColor: confidenceStyle.bg, color: confidenceStyle.color,
            borderRadius: '12px', fontSize: '12px', fontWeight: '500'
          }}>
            {persona.confidence} confidence{feedbackText}
          </span>
        )}
      </div>
    </div>
  )
}

function IdentitySection({ persona }: PersonaPDFContentProps) {
  const identity = persona.identity ?? persona.demographics
  if (!identity) return null

  const attrs = Object.entries(identity).filter(([k, v]) => k !== 'bio' && v)

  return (
    <div data-pdf-section style={{ marginBottom: '24px' }}>
      <h2 style={{ fontSize: '18px', fontWeight: '600', color: '#7c3aed', marginBottom: '12px' }}>👤 Identity & Demographics</h2>
      {identity.bio && <p style={{ color: '#374151', marginBottom: '12px', lineHeight: '1.6' }}>{identity.bio}</p>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        {attrs.map(([k, v]) => (
          <span key={k} style={{ padding: '4px 10px', backgroundColor: '#f3e8ff', color: '#7c3aed', borderRadius: '6px', fontSize: '12px' }}>
            {k.replace(/_/g, ' ')}: {String(v)}
          </span>
        ))}
      </div>
    </div>
  )
}

interface ListSectionProps {
  readonly items: string[]
  readonly title: string
  readonly isLast?: boolean
}

function ListSection({ items, title, isLast }: ListSectionProps) {
  if (items.length === 0) return null
  return (
    <div data-pdf-section style={{ marginBottom: isLast ? 0 : '12px' }}>
      <p style={{ fontSize: '14px', fontWeight: '500', color: '#6b7280', marginBottom: '8px' }}>{title}</p>
      <ul style={{ margin: 0, paddingLeft: '20px', color: '#374151' }}>
        {items.map((item, i) => <li key={i} style={{ marginBottom: '4px' }}>{item}</li>)}
      </ul>
    </div>
  )
}

function GoalsSection({ persona }: PersonaPDFContentProps) {
  const goals = persona.goals_motivations
  if (!goals && !persona.goals?.length) return null

  const secondaryGoals = goals?.secondary_goals ?? persona.goals ?? []
  const motivations = goals?.underlying_motivations ?? []

  return (
    <div data-pdf-section style={{ marginBottom: '24px' }}>
      <h2 style={{ fontSize: '18px', fontWeight: '600', color: '#16a34a', marginBottom: '12px' }}>🎯 Goals & Motivations</h2>
      {goals?.primary_goal && (
        <div data-pdf-section style={{ padding: '12px', backgroundColor: '#f0fdf4', borderRadius: '8px', marginBottom: '12px' }}>
          <p style={{ fontSize: '12px', color: '#16a34a', fontWeight: '500', marginBottom: '4px' }}>Primary Goal</p>
          <p style={{ color: '#374151', margin: 0 }}>{goals.primary_goal}</p>
        </div>
      )}
      <ListSection items={secondaryGoals} title="Secondary Goals" />
      <ListSection items={motivations} title="Underlying Motivations" isLast />
    </div>
  )
}

function PainPointsSection({ persona }: PersonaPDFContentProps) {
  const painPoints = persona.pain_points
  if (!painPoints && !persona.frustrations?.length) return null

  const challenges = painPoints?.current_challenges ?? persona.frustrations ?? []
  const blockers = painPoints?.blockers ?? []
  const workarounds = painPoints?.workarounds ?? []

  return (
    <div data-pdf-section style={{ marginBottom: '24px' }}>
      <h2 style={{ fontSize: '18px', fontWeight: '600', color: '#dc2626', marginBottom: '12px' }}>😤 Pain Points & Frustrations</h2>
      <ListSection items={challenges} title="Current Challenges" />
      <ListSection items={blockers} title="Blockers" />
      <ListSection items={workarounds} title="Current Workarounds" isLast />
    </div>
  )
}

interface BehaviorsObject {
  current_solutions?: string[]
  tech_savviness?: string
  activity_frequency?: string
  decision_style?: string
  tools_used?: string[]
}

function BehaviorsSection({ persona }: PersonaPDFContentProps) {
  if (!persona.behaviors) return null

  if (Array.isArray(persona.behaviors)) {
    return (
      <div data-pdf-section style={{ marginBottom: '24px' }}>
        <h2 style={{ fontSize: '18px', fontWeight: '600', color: '#2563eb', marginBottom: '12px' }}>🔄 Behaviors & Habits</h2>
        <ul style={{ margin: 0, paddingLeft: '20px', color: '#374151' }}>
          {persona.behaviors.map((b, i) => <li key={i} style={{ marginBottom: '4px' }}>{b}</li>)}
        </ul>
      </div>
    )
  }

  const behaviors: BehaviorsObject = persona.behaviors
  const solutions = behaviors.current_solutions ?? []
  const tools = behaviors.tools_used ?? []

  return (
    <div data-pdf-section style={{ marginBottom: '24px' }}>
      <h2 style={{ fontSize: '18px', fontWeight: '600', color: '#2563eb', marginBottom: '12px' }}>🔄 Behaviors & Habits</h2>
      {solutions.length > 0 && (
        <div data-pdf-section style={{ marginBottom: '12px' }}>
          <p style={{ fontSize: '14px', fontWeight: '500', color: '#6b7280', marginBottom: '8px' }}>Current Solutions</p>
          <ul style={{ margin: 0, paddingLeft: '20px', color: '#374151' }}>
            {solutions.map((s, i) => <li key={i} style={{ marginBottom: '4px' }}>{s}</li>)}
          </ul>
        </div>
      )}
      <div data-pdf-section style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
        {behaviors.tech_savviness && (
          <span style={{ padding: '4px 10px', backgroundColor: '#dbeafe', color: '#1d4ed8', borderRadius: '6px', fontSize: '12px' }}>
            Tech: {behaviors.tech_savviness}
          </span>
        )}
        {behaviors.activity_frequency && (
          <span style={{ padding: '4px 10px', backgroundColor: '#dbeafe', color: '#1d4ed8', borderRadius: '6px', fontSize: '12px' }}>
            {behaviors.activity_frequency}
          </span>
        )}
        {behaviors.decision_style && (
          <span style={{ padding: '4px 10px', backgroundColor: '#dbeafe', color: '#1d4ed8', borderRadius: '6px', fontSize: '12px' }}>
            {behaviors.decision_style}
          </span>
        )}
      </div>
      {tools.length > 0 && (
        <div data-pdf-section>
          <p style={{ fontSize: '14px', fontWeight: '500', color: '#6b7280', marginBottom: '8px' }}>Tools Used</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {tools.map((t, i) => (
              <span key={i} style={{ padding: '2px 8px', backgroundColor: '#f3f4f6', color: '#4b5563', borderRadius: '4px', fontSize: '12px' }}>{t}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function ContextSection({ persona }: PersonaPDFContentProps) {
  if (!persona.context_environment) return null

  const devices = persona.context_environment.devices ?? []

  return (
    <div data-pdf-section style={{ marginBottom: '24px' }}>
      <h2 style={{ fontSize: '18px', fontWeight: '600', color: '#d97706', marginBottom: '12px' }}>🌍 Context & Environment</h2>
      {persona.context_environment.usage_context && (
        <p style={{ color: '#374151', marginBottom: '12px', lineHeight: '1.6' }}>{persona.context_environment.usage_context}</p>
      )}
      {devices.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
          {devices.map((d, i) => (
            <span key={i} style={{ padding: '4px 10px', backgroundColor: '#fef3c7', color: '#92400e', borderRadius: '6px', fontSize: '12px' }}>{d}</span>
          ))}
        </div>
      )}
      {persona.context_environment.time_constraints && (
        <p style={{ color: '#374151', fontSize: '14px' }}><strong>Time constraints:</strong> {persona.context_environment.time_constraints}</p>
      )}
    </div>
  )
}

function QuotesSection({ persona }: PersonaPDFContentProps) {
  if (!persona.quotes?.length && !persona.quote) return null

  return (
    <div data-pdf-section style={{ marginBottom: '24px' }}>
      <h2 style={{ fontSize: '18px', fontWeight: '600', color: '#6366f1', marginBottom: '12px' }}>💬 Representative Quotes</h2>
      {persona.quotes?.length ? persona.quotes.map((q, i) => (
        <blockquote key={i} data-pdf-section style={{ borderLeft: '4px solid #a5b4fc', paddingLeft: '16px', margin: '0 0 12px 0', fontStyle: 'italic', color: '#374151' }}>
          &quot;{q.text}&quot;
          {q.context && <p style={{ fontSize: '12px', color: '#9ca3af', marginTop: '4px' }}>— {q.context}</p>}
        </blockquote>
      )) : persona.quote && (
        <blockquote style={{ borderLeft: '4px solid #a5b4fc', paddingLeft: '16px', margin: 0, fontStyle: 'italic', color: '#374151' }}>
          &quot;{persona.quote}&quot;
        </blockquote>
      )}
    </div>
  )
}

function ScenarioSection({ persona }: PersonaPDFContentProps) {
  if (!persona.scenario) return null

  if (typeof persona.scenario === 'string') {
    return (
      <div data-pdf-section style={{ marginBottom: '24px', pageBreakInside: 'avoid' }}>
        <h2 style={{ fontSize: '18px', fontWeight: '600', color: '#0d9488', marginBottom: '12px' }}>📖 Scenario</h2>
        <p data-pdf-section style={{ color: '#374151', lineHeight: '1.6' }}>{persona.scenario}</p>
      </div>
    )
  }

  return (
    <div data-pdf-section style={{ marginBottom: '24px', pageBreakInside: 'avoid' }}>
      <h2 style={{ fontSize: '18px', fontWeight: '600', color: '#0d9488', marginBottom: '12px' }}>📖 Scenario</h2>
      {persona.scenario.title && <h3 data-pdf-section style={{ fontSize: '16px', fontWeight: '500', marginBottom: '8px' }}>{persona.scenario.title}</h3>}
      {persona.scenario.narrative && <p data-pdf-section style={{ color: '#374151', lineHeight: '1.6', marginBottom: '12px' }}>{persona.scenario.narrative}</p>}
      {(persona.scenario.trigger ?? persona.scenario.outcome) && (
        <div data-pdf-section style={{ display: 'flex', gap: '16px', pageBreakInside: 'avoid' }}>
          {persona.scenario.trigger && (
            <div style={{ flex: 1, padding: '12px', backgroundColor: '#f0fdfa', borderRadius: '8px' }}>
              <p style={{ fontSize: '12px', color: '#0d9488', fontWeight: '500', marginBottom: '4px' }}>Trigger</p>
              <p style={{ color: '#374151', margin: 0, fontSize: '14px' }}>{persona.scenario.trigger}</p>
            </div>
          )}
          {persona.scenario.outcome && (
            <div style={{ flex: 1, padding: '12px', backgroundColor: '#f0fdfa', borderRadius: '8px' }}>
              <p style={{ fontSize: '12px', color: '#0d9488', fontWeight: '500', marginBottom: '4px' }}>Desired Outcome</p>
              <p style={{ color: '#374151', margin: 0, fontSize: '14px' }}>{persona.scenario.outcome}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ResearchNotesSection({ persona }: PersonaPDFContentProps) {
  if (!persona.research_notes?.length) return null

  return (
    <div data-pdf-section style={{ marginBottom: '24px' }}>
      <h2 style={{ fontSize: '18px', fontWeight: '600', color: '#6b7280', marginBottom: '12px' }}>📝 Research Notes</h2>
      <ul style={{ margin: 0, paddingLeft: '20px', color: '#374151' }}>
        {persona.research_notes.map((note, i) => (
          <li key={i} style={{ marginBottom: '4px' }}>{typeof note === 'string' ? note : note.text}</li>
        ))}
      </ul>
    </div>
  )
}

export default function PersonaPDFContent({ persona }: PersonaPDFContentProps) {
  return (
    <div style={{ padding: '40px', backgroundColor: 'white' }}>
      <HeaderSection persona={persona} />
      <hr style={{ border: 'none', borderTop: '2px solid #e5e7eb', marginBottom: '24px' }} />
      <IdentitySection persona={persona} />
      <GoalsSection persona={persona} />
      <PainPointsSection persona={persona} />
      <BehaviorsSection persona={persona} />
      <ContextSection persona={persona} />
      <QuotesSection persona={persona} />
      <ScenarioSection persona={persona} />
      <ResearchNotesSection persona={persona} />
      <div data-pdf-section>
        <hr style={{ border: 'none', borderTop: '1px solid #e5e7eb', marginTop: '32px', marginBottom: '16px' }} />
        <p style={{ fontSize: '11px', color: '#9ca3af', textAlign: 'center' }}>
          Generated on {new Date().toLocaleDateString()} • VoC Analytics
        </p>
      </div>
    </div>
  )
}
