/**
 * @fileoverview PDF content component for persona export.
 * @module components/PersonaExportMenu/PersonaPDFContent
 */

import {
  ListSection, BehaviorsSection, ScenarioSection,
  ContextSection, QuotesSection, ResearchNotesSection,
} from './PersonaPDFSections'
import type { ProjectPersona } from '../../api/types'

interface PersonaPDFContentProps { readonly persona: ProjectPersona }

function getConfidenceStyle(confidence: string): {
  bg: string;
  color: string
} {
  if (confidence === 'high') return {
    bg: '#dcfce7',
    color: '#166534',
  }
  if (confidence === 'medium') return {
    bg: '#fef9c3',
    color: '#854d0e',
  }
  return {
    bg: '#f3f4f6',
    color: '#374151',
  }
}

function HeaderSection({ persona }: PersonaPDFContentProps) {
  const confidenceStyle = persona.confidence == null ? null : getConfidenceStyle(persona.confidence)
  const feedbackText = persona.feedback_count == null ? '' : ` • ${persona.feedback_count} reviews`

  return (
    <div data-pdf-section style={{
      display: 'flex',
      alignItems: 'center',
      gap: '16px',
      marginBottom: '24px',
    }}>
      {persona.avatar_url != null && persona.avatar_url !== '' ? (
        <img
          src={persona.avatar_url}
          alt={persona.name}
          style={{
            width: '80px',
            height: '80px',
            borderRadius: '50%',
            objectFit: 'cover',
            border: '3px solid #e9d5ff',
          }}
          crossOrigin="anonymous"
        />
      ) : (
        <div style={{
          width: '80px',
          height: '80px',
          borderRadius: '50%',
          background: 'linear-gradient(135deg, #8b5cf6, #ec4899)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'white',
          fontSize: '32px',
          fontWeight: 'bold',
        }}>
          {persona.name.charAt(0)}
        </div>
      )}
      <div>
        <h1 style={{
          fontSize: '28px',
          fontWeight: 'bold',
          margin: 0,
          color: '#111827',
        }}>{persona.name}</h1>
        <p style={{
          fontSize: '16px',
          color: '#6b7280',
          margin: '4px 0 0 0',
        }}>{persona.tagline}</p>
        {confidenceStyle ? <span style={{
          display: 'inline-block',
          marginTop: '8px',
          padding: '4px 12px',
          backgroundColor: confidenceStyle.bg,
          color: confidenceStyle.color,
          borderRadius: '12px',
          fontSize: '12px',
          fontWeight: '500',
        }}>
          {persona.confidence} confidence{feedbackText}
        </span> : null}
      </div>
    </div>
  )
}

function IdentitySection({ persona }: PersonaPDFContentProps) {
  const identity = persona.identity
  if (!identity) return null

  const attrs = Object.entries(identity).filter(([k, v]) => k !== 'bio' && Boolean(v))

  return (
    <div data-pdf-section style={{ marginBottom: '24px' }}>
      <h2 style={{
        fontSize: '18px',
        fontWeight: '600',
        color: '#7c3aed',
        marginBottom: '12px',
      }}>👤 Identity & Demographics</h2>
      {identity.bio != null && identity.bio !== '' ? <p style={{
        color: '#374151',
        marginBottom: '12px',
        lineHeight: '1.6',
      }}>{identity.bio}</p> : null}
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '8px',
      }}>
        {attrs.map(([k, v]) => (
          <span key={k} style={{
            padding: '4px 10px',
            backgroundColor: '#f3e8ff',
            color: '#7c3aed',
            borderRadius: '6px',
            fontSize: '12px',
          }}>
            {k.replaceAll('_', ' ')}: {String(v)}
          </span>
        ))}
      </div>
    </div>
  )
}

function GoalsSection({ persona }: PersonaPDFContentProps) {
  const goals = persona.goals_motivations
  if (!goals) return null

  const secondaryGoals = goals.secondary_goals ?? []
  const motivations = goals.underlying_motivations ?? []

  return (
    <div data-pdf-section style={{ marginBottom: '24px' }}>
      <h2 style={{
        fontSize: '18px',
        fontWeight: '600',
        color: '#16a34a',
        marginBottom: '12px',
      }}>🎯 Goals & Motivations</h2>
      {goals.primary_goal != null && goals.primary_goal !== '' ? <div data-pdf-section style={{
        padding: '12px',
        backgroundColor: '#f0fdf4',
        borderRadius: '8px',
        marginBottom: '12px',
      }}>
        <p style={{
          fontSize: '12px',
          color: '#16a34a',
          fontWeight: '500',
          marginBottom: '4px',
        }}>Primary Goal</p>
        <p style={{
          color: '#374151',
          margin: 0,
        }}>{goals.primary_goal}</p>
      </div> : null}
      <ListSection items={secondaryGoals} title="Secondary Goals" />
      <ListSection items={motivations} title="Underlying Motivations" isLast />
    </div>
  )
}

function PainPointsSection({ persona }: PersonaPDFContentProps) {
  const painPoints = persona.pain_points
  if (!painPoints) return null

  const challenges = painPoints.current_challenges ?? []
  const blockers = painPoints.blockers ?? []
  const workarounds = painPoints.workarounds ?? []

  return (
    <div data-pdf-section style={{ marginBottom: '24px' }}>
      <h2 style={{
        fontSize: '18px',
        fontWeight: '600',
        color: '#dc2626',
        marginBottom: '12px',
      }}>😤 Pain Points & Frustrations</h2>
      <ListSection items={challenges} title="Current Challenges" />
      <ListSection items={blockers} title="Blockers" />
      <ListSection items={workarounds} title="Current Workarounds" isLast />
    </div>
  )
}

export default function PersonaPDFContent({ persona }: PersonaPDFContentProps) {
  return (
    <div style={{
      padding: '40px',
      backgroundColor: 'white',
    }}>
      <HeaderSection persona={persona} />
      <hr style={{
        border: 'none',
        borderTop: '2px solid #e5e7eb',
        marginBottom: '24px',
      }} />
      <IdentitySection persona={persona} />
      <GoalsSection persona={persona} />
      <PainPointsSection persona={persona} />
      <BehaviorsSection persona={persona} />
      <ContextSection persona={persona} />
      <QuotesSection persona={persona} />
      <ScenarioSection persona={persona} />
      <ResearchNotesSection persona={persona} />
      <div data-pdf-section>
        <hr style={{
          border: 'none',
          borderTop: '1px solid #e5e7eb',
          marginTop: '32px',
          marginBottom: '16px',
        }} />
        <p style={{
          fontSize: '11px',
          color: '#9ca3af',
          textAlign: 'center',
        }}>
          Generated on {new Date().toLocaleDateString()} • VoC Analytics
        </p>
      </div>
    </div>
  )
}
