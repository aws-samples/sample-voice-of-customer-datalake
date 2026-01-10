/**
 * @fileoverview Converts persona data to markdown format.
 * @module components/PersonaExportMenu/personaToMarkdown
 */

import type { ProjectPersona } from '../../api/client'

function addIdentitySection(lines: string[], persona: ProjectPersona): void {
  const identity = persona.identity
  if (!identity) return

  lines.push('## Identity & Demographics')
  if (identity.bio) lines.push(identity.bio)
  lines.push('')
  const attrs = Object.entries(identity).filter(([k, v]) => k !== 'bio' && v)
  if (attrs.length > 0) {
    attrs.forEach(([k, v]) => lines.push(`- **${k.replace(/_/g, ' ')}:** ${v}`))
    lines.push('')
  }
}

function addListItems(lines: string[], items: string[], header: string): void {
  if (items.length === 0) return
  lines.push(header)
  items.forEach(item => lines.push(`- ${item}`))
}

function addGoalsSection(lines: string[], persona: ProjectPersona): void {
  const goals = persona.goals_motivations
  if (!goals) return

  lines.push('## Goals & Motivations')
  if (goals.primary_goal) lines.push(`**Primary Goal:** ${goals.primary_goal}`)
  addListItems(lines, goals.secondary_goals ?? [], '**Secondary Goals:**')
  addListItems(lines, goals.underlying_motivations ?? [], '**Underlying Motivations:**')
  lines.push('')
}

function addPainPointsSection(lines: string[], persona: ProjectPersona): void {
  const painPoints = persona.pain_points
  if (!painPoints) return

  lines.push('## Pain Points & Frustrations')
  addListItems(lines, painPoints.current_challenges ?? [], '**Current Challenges:**')
  addListItems(lines, painPoints.blockers ?? [], '**Blockers:**')
  addListItems(lines, painPoints.workarounds ?? [], '**Workarounds:**')
  lines.push('')
}

function addBehaviorsSection(lines: string[], persona: ProjectPersona): void {
  const behaviors = persona.behaviors
  if (!behaviors) return

  lines.push('## Behaviors & Habits')
  if (behaviors.current_solutions?.length) {
    lines.push('**Current Solutions:**')
    behaviors.current_solutions.forEach(s => lines.push(`- ${s}`))
  }
  if (behaviors.tech_savviness) lines.push(`- **Tech Savviness:** ${behaviors.tech_savviness}`)
  if (behaviors.activity_frequency) lines.push(`- **Activity Frequency:** ${behaviors.activity_frequency}`)
  if (behaviors.decision_style) lines.push(`- **Decision Style:** ${behaviors.decision_style}`)
  if (behaviors.tools_used?.length) lines.push(`- **Tools Used:** ${behaviors.tools_used.join(', ')}`)
  lines.push('')
}

function addContextSection(lines: string[], persona: ProjectPersona): void {
  if (!persona.context_environment) return

  lines.push('## Context & Environment')
  if (persona.context_environment.usage_context) lines.push(persona.context_environment.usage_context)
  if (persona.context_environment.devices?.length) {
    lines.push(`**Devices:** ${persona.context_environment.devices.join(', ')}`)
  }
  if (persona.context_environment.time_constraints) {
    lines.push(`**Time Constraints:** ${persona.context_environment.time_constraints}`)
  }
  lines.push('')
}

function addQuotesSection(lines: string[], persona: ProjectPersona): void {
  if (!persona.quotes?.length) return

  lines.push('## Representative Quotes')
  persona.quotes.forEach(q => {
    lines.push(`> "${q.text}"`)
    if (q.context) lines.push(`> — ${q.context}`)
    lines.push('')
  })
}

function addScenarioSection(lines: string[], persona: ProjectPersona): void {
  if (!persona.scenario) return

  lines.push('## Scenario')
  if (persona.scenario.title) lines.push(`### ${persona.scenario.title}`)
  if (persona.scenario.narrative) lines.push(persona.scenario.narrative)
  if (persona.scenario.trigger) lines.push(`**Trigger:** ${persona.scenario.trigger}`)
  if (persona.scenario.outcome) lines.push(`**Desired Outcome:** ${persona.scenario.outcome}`)
  lines.push('')
}

function addResearchNotesSection(lines: string[], persona: ProjectPersona): void {
  if (!persona.research_notes?.length) return

  lines.push('## Research Notes')
  persona.research_notes.forEach(note => {
    const text = typeof note === 'string' ? note : note.text
    lines.push(`- ${text}`)
  })
  lines.push('')
}

export function personaToMarkdown(persona: ProjectPersona): string {
  const lines: string[] = []

  lines.push(`# ${persona.name}`)
  lines.push(`*${persona.tagline}*`)
  lines.push('')

  if (persona.confidence) {
    const feedbackInfo = persona.feedback_count ? ` (${persona.feedback_count} reviews)` : ''
    lines.push(`**Confidence:** ${persona.confidence}${feedbackInfo}`)
    lines.push('')
  }

  addIdentitySection(lines, persona)
  addGoalsSection(lines, persona)
  addPainPointsSection(lines, persona)
  addBehaviorsSection(lines, persona)
  addContextSection(lines, persona)
  addQuotesSection(lines, persona)
  addScenarioSection(lines, persona)
  addResearchNotesSection(lines, persona)

  return lines.join('\n')
}
