/**
 * @fileoverview PDF section components for persona export.
 * @module components/PersonaExportMenu/PersonaPDFSections
 */

import type { ProjectPersona } from '../../api/projectTypes'
import { Repeat, BookOpen, Earth, Quote, NotebookPen } from 'lucide-react'
import { PdfIcon, PdfSectionHeading } from '../PdfParts/pdfParts'
import { scenarioTriggerOutcome } from './scenarioTriggerOutcome'

interface PersonaPDFContentProps { readonly persona: ProjectPersona }

interface ListSectionProps {
  readonly items: string[]
  readonly title: string
  readonly isLast?: boolean
}

export function ListSection({
  items, title, isLast,
}: ListSectionProps) {
  if (items.length === 0) return null
  return (
    <div data-pdf-section style={{ marginBottom: isLast === true ? 0 : '12px' }}>
      <p style={{
        fontSize: '14px',
        fontWeight: '500',
        color: '#5e5966',
        marginBottom: '8px',
      }}>{title}</p>
      <ul style={{
        margin: 0,
        paddingLeft: '20px',
        color: '#4a464f',
      }}>
        {items.map((item) => <li key={item} style={{ marginBottom: '4px' }}>{item}</li>)}
      </ul>
    </div>
  )
}

function BehaviorBadge({ label }: Readonly<{ label: string }>) {
  return (
    <span style={{
      padding: '4px 10px',
      backgroundColor: '#f1e9ff',
      color: '#723acc',
      borderRadius: '6px',
      fontSize: '12px',
    }}>
      {label}
    </span>
  )
}

function BehaviorBadges({ behaviors }: Readonly<{ behaviors: NonNullable<ProjectPersona['behaviors']> }>) {
  return (
    <div data-pdf-section style={{
      display: 'flex',
      flexWrap: 'wrap',
      gap: '8px',
      marginBottom: '12px',
    }}>
      {behaviors.tech_savviness != null && behaviors.tech_savviness !== '' ? <BehaviorBadge label={`Tech: ${behaviors.tech_savviness}`} /> : null}
      {behaviors.activity_frequency != null && behaviors.activity_frequency !== '' ? <BehaviorBadge label={behaviors.activity_frequency} /> : null}
      {behaviors.decision_style != null && behaviors.decision_style !== '' ? <BehaviorBadge label={behaviors.decision_style} /> : null}
    </div>
  )
}

export function BehaviorsSection({ persona }: PersonaPDFContentProps) {
  if (!persona.behaviors) return null

  const behaviors = persona.behaviors
  const solutions = behaviors.current_solutions ?? []
  const tools = behaviors.tools_used ?? []

  return (
    <div data-pdf-section style={{ marginBottom: '24px' }}>
      <PdfSectionHeading color="#723acc"><PdfIcon icon={Repeat} />Behaviors & Habits</PdfSectionHeading>
      {solutions.length > 0 && (
        <ListSection items={solutions} title="Current Solutions" />
      )}
      <BehaviorBadges behaviors={behaviors} />
      {tools.length > 0 && (
        <div data-pdf-section>
          <p style={{
            fontSize: '14px',
            fontWeight: '500',
            color: '#5e5966',
            marginBottom: '8px',
          }}>Tools Used</p>
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '6px',
          }}>
            {tools.map((tool) => (
              <span key={tool} style={{
                padding: '2px 8px',
                backgroundColor: '#f5f5f5',
                color: '#4a464f',
                borderRadius: '4px',
                fontSize: '12px',
              }}>{tool}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

interface ScenarioDetailProps {
  readonly label: string
  readonly text: string
}

function ScenarioDetail({
  label, text,
}: ScenarioDetailProps) {
  return (
    <div style={{
      flex: 1,
      padding: '12px',
      backgroundColor: '#e0eee7',
      borderRadius: '8px',
    }}>
      <p style={{
        fontSize: '12px',
        color: '#007038',
        fontWeight: '500',
        marginBottom: '4px',
      }}>{label}</p>
      <p style={{
        color: '#4a464f',
        margin: 0,
        fontSize: '14px',
      }}>{text}</p>
    </div>
  )
}

function TriggerOutcome({ scenario }: Readonly<{ scenario: NonNullable<ProjectPersona['scenario']> }>) {
  const parts = scenarioTriggerOutcome(scenario)
  if (parts === null) return null

  return (
    <div data-pdf-section style={{
      display: 'flex',
      gap: '16px',
      pageBreakInside: 'avoid',
    }}>
      {parts.trigger === null ? null : <ScenarioDetail label="Trigger" text={parts.trigger} />}
      {parts.outcome === null ? null : <ScenarioDetail label="Desired Outcome" text={parts.outcome} />}
    </div>
  )
}

function ScenarioBody({ scenario }: Readonly<{ scenario: NonNullable<ProjectPersona['scenario']> }>) {
  return (
    <>
      {scenario.title != null && scenario.title !== '' ? <h3 data-pdf-section style={{
        fontSize: '16px',
        fontWeight: '500',
        marginBottom: '8px',
      }}>{scenario.title}</h3> : null}
      {scenario.narrative != null && scenario.narrative !== '' ? <p data-pdf-section style={{
        color: '#4a464f',
        lineHeight: '1.6',
        marginBottom: '12px',
      }}>{scenario.narrative}</p> : null}
      <TriggerOutcome scenario={scenario} />
    </>
  )
}

export function ScenarioSection({ persona }: PersonaPDFContentProps) {
  if (!persona.scenario) return null

  return (
    <div data-pdf-section style={{
      marginBottom: '24px',
      pageBreakInside: 'avoid',
    }}>
      <PdfSectionHeading color="#007038"><PdfIcon icon={BookOpen} />Scenario</PdfSectionHeading>
      <ScenarioBody scenario={persona.scenario} />
    </div>
  )
}

export function ContextSection({ persona }: PersonaPDFContentProps) {
  if (!persona.context_environment) return null

  const devices = persona.context_environment.devices ?? []

  return (
    <div data-pdf-section style={{ marginBottom: '24px' }}>
      <PdfSectionHeading color="#6b5900"><PdfIcon icon={Earth} />Context & Environment</PdfSectionHeading>
      {persona.context_environment.usage_context != null && persona.context_environment.usage_context !== '' ? <p style={{
        color: '#4a464f',
        marginBottom: '12px',
        lineHeight: '1.6',
      }}>{persona.context_environment.usage_context}</p> : null}
      {devices.length > 0 && (
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '8px',
          marginBottom: '12px',
        }}>
          {devices.map((d) => (
            <span key={d} style={{
              padding: '4px 10px',
              backgroundColor: '#f0eee6',
              color: '#6b5900',
              borderRadius: '6px',
              fontSize: '12px',
            }}>{d}</span>
          ))}
        </div>
      )}
      {persona.context_environment.time_constraints != null && persona.context_environment.time_constraints !== '' ? <p style={{
        color: '#4a464f',
        fontSize: '14px',
      }}><strong>Time constraints:</strong> {persona.context_environment.time_constraints}</p> : null}
    </div>
  )
}

export function QuotesSection({ persona }: PersonaPDFContentProps) {
  if (persona.quotes == null || persona.quotes.length === 0) return null

  return (
    <div data-pdf-section style={{ marginBottom: '24px' }}>
      <PdfSectionHeading color="#8e48ff"><PdfIcon icon={Quote} />Representative Quotes</PdfSectionHeading>
      {persona.quotes.map((q) => (
        <blockquote key={q.text} data-pdf-section style={{
          borderLeft: '4px solid #d7bfff',
          paddingLeft: '16px',
          margin: '0 0 12px 0',
          fontStyle: 'italic',
          color: '#4a464f',
        }}>
          &quot;{q.text}&quot;
          {q.context != null && q.context !== '' ? <p style={{
            fontSize: '12px',
            color: '#5e5966',
            marginTop: '4px',
          }}>— {q.context}</p> : null}
        </blockquote>
      ))}
    </div>
  )
}

export function ResearchNotesSection({ persona }: PersonaPDFContentProps) {
  if (persona.research_notes == null || persona.research_notes.length === 0) return null

  return (
    <div data-pdf-section style={{ marginBottom: '24px' }}>
      <PdfSectionHeading color="#5e5966"><PdfIcon icon={NotebookPen} />Research Notes</PdfSectionHeading>
      <ul style={{
        margin: 0,
        paddingLeft: '20px',
        color: '#4a464f',
      }}>
        {persona.research_notes.map((note) => {
          const text = typeof note === 'string' ? note : note.text
          return <li key={text} style={{ marginBottom: '4px' }}>{text}</li>
        })}
      </ul>
    </div>
  )
}
