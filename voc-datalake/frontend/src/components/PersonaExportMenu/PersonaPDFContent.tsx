/**
 * @fileoverview PDF content component for persona export.
 * @module components/PersonaExportMenu/PersonaPDFContent
 */

import { User, Target, Frown } from 'lucide-react'
import {
  ListSection, BehaviorsSection, ScenarioSection,
  ContextSection, QuotesSection, ResearchNotesSection,
} from './PersonaPDFSections'
import { PDF_REPORT_LOCALE, PdfIcon, PdfReport, PdfSectionHeading } from '../PdfParts/pdfParts'
import { PDF_TONES, type PdfTone } from '../PdfParts/pdfTones'
import { formatDate } from '../../utils/dateUtils'
import { formatCount } from '../../utils/numberFormat'
import { humanizeId } from '../../utils/displayLabels'
import type { ProjectPersona } from '../../api/projectTypes'

interface PersonaPDFContentProps { readonly persona: ProjectPersona }

/** High confidence prints ok, medium warn, anything else muted. */
function confidenceTone(confidence: string): PdfTone {
  if (confidence === 'high') return 'ok'
  if (confidence === 'medium') return 'warn'
  return 'muted'
}

function HeaderSection({ persona }: PersonaPDFContentProps) {
  const confidenceStyle = persona.confidence == null ? null : PDF_TONES[confidenceTone(persona.confidence)]
  const feedbackText = persona.feedback_count == null ? '' : ` • ${formatCount(persona.feedback_count, PDF_REPORT_LOCALE)} reviews`

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
            {humanizeId(k)}: {String(v)}
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
      <PdfSectionHeading color={PDF_TONES.ok.color}><PdfIcon icon={Target} />Goals & Motivations</PdfSectionHeading>
      {goals.primary_goal != null && goals.primary_goal !== '' ? <div data-pdf-section style={{
        padding: '12px',
        backgroundColor: PDF_TONES.ok.bg,
        borderRadius: '8px',
        marginBottom: '12px',
      }}>
        <p style={{
          fontSize: '12px',
          color: PDF_TONES.ok.color,
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
      <PdfSectionHeading color={PDF_TONES.danger.color}><PdfIcon icon={Frown} />Pain Points & Frustrations</PdfSectionHeading>
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
      footer={<>Generated on {formatDate(new Date(), PDF_REPORT_LOCALE)} • VoC Analytics</>}
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
