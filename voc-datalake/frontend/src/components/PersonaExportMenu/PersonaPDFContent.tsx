/**
 * @fileoverview PDF content component for persona export.
 * @module components/PersonaExportMenu/PersonaPDFContent
 */

import { User, Target, Frown } from 'lucide-react'
import {
  ListSection, BehaviorsSection, ScenarioSection,
  ContextSection, QuotesSection, ResearchNotesSection,
} from './PersonaPDFSections'
import { PdfIcon, PdfReport, PdfSectionHeading } from '../PdfParts/pdfParts'
import type { ProjectPersona } from '../../api/projectTypes'

interface PersonaPDFContentProps { readonly persona: ProjectPersona }

function getConfidenceStyle(confidence: string): {
  bg: string;
  color: string
} {
  if (confidence === 'high') return {
    bg: '#e0eee7',
    color: '#007038',
  }
  if (confidence === 'medium') return {
    bg: '#f0eee6',
    color: '#6b5900',
  }
  return {
    bg: '#f5f5f5',
    color: '#4a464f',
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
            border: '3px solid #d7bfff',
          }}
          crossOrigin="anonymous"
        />
      ) : (
        <div style={{
          width: '80px',
          height: '80px',
          borderRadius: '50%',
          background: 'linear-gradient(135deg, #8e48ff, #7337d6)',
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
          color: '#19161d',
        }}>{persona.name}</h1>
        <p style={{
          fontSize: '16px',
          color: '#5e5966',
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
      <PdfSectionHeading color="#723acc"><PdfIcon icon={User} />Identity & Demographics</PdfSectionHeading>
      {identity.bio != null && identity.bio !== '' ? <p style={{
        color: '#4a464f',
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
            backgroundColor: '#f1e9ff',
            color: '#723acc',
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
      <PdfSectionHeading color="#007038"><PdfIcon icon={Target} />Goals & Motivations</PdfSectionHeading>
      {goals.primary_goal != null && goals.primary_goal !== '' ? <div data-pdf-section style={{
        padding: '12px',
        backgroundColor: '#e0eee7',
        borderRadius: '8px',
        marginBottom: '12px',
      }}>
        <p style={{
          fontSize: '12px',
          color: '#007038',
          fontWeight: '500',
          marginBottom: '4px',
        }}>Primary Goal</p>
        <p style={{
          color: '#4a464f',
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
      <PdfSectionHeading color="#bd1c3a"><PdfIcon icon={Frown} />Pain Points & Frustrations</PdfSectionHeading>
      <ListSection items={challenges} title="Current Challenges" />
      <ListSection items={blockers} title="Blockers" />
      <ListSection items={workarounds} title="Current Workarounds" isLast />
    </div>
  )
}

export default function PersonaPDFContent({ persona }: PersonaPDFContentProps) {
  return (
    <PdfReport
      header={<HeaderSection persona={persona} />}
      footer={<>Generated on {new Date().toLocaleDateString()} • VoC Analytics</>}
    >
      <IdentitySection persona={persona} />
      <GoalsSection persona={persona} />
      <PainPointsSection persona={persona} />
      <BehaviorsSection persona={persona} />
      <ContextSection persona={persona} />
      <QuotesSection persona={persona} />
      <ScenarioSection persona={persona} />
      <ResearchNotesSection persona={persona} />
    </PdfReport>
  )
}
