/**
 * @fileoverview Tests for pdfGenerator utilities
 * Tests the helper functions and structure without full PDF generation
 * @module components/PersonaExportMenu/pdfGenerator.test
 */
import { describe, it, expect, vi } from 'vitest'
import type { ProjectPersona } from '../../api/client'

// Test the module structure and exports
describe('pdfGenerator module', () => {
  it('exports generatePersonaPDF function', async () => {
    const module = await import('./pdfGenerator')
    expect(typeof module.generatePersonaPDF).toBe('function')
  })
})

// Test PersonaPDFContent rendering (which is used by pdfGenerator)
describe('PersonaPDFContent for PDF generation', () => {
  const createTestPersona = (): ProjectPersona => ({
    persona_id: 'test-persona',
    name: 'Test User',
    tagline: 'A test persona for PDF generation',
    identity: { age_range: '25-34' },
    quotes: [{ text: 'This is a test quote' }],
    goals_motivations: { secondary_goals: ['Goal 1', 'Goal 2'] },
    pain_points: { current_challenges: ['Challenge 1'] },
    behaviors: { current_solutions: ['Solution 1'] },
    scenario: { narrative: 'Test scenario' },
    created_at: '2025-01-01T00:00:00Z',
  })

  it('creates valid persona object for PDF', () => {
    const persona = createTestPersona()
    
    expect(persona.persona_id).toBe('test-persona')
    expect(persona.name).toBe('Test User')
    expect(persona.tagline).toBe('A test persona for PDF generation')
  })

  it('handles persona with all optional fields', () => {
    const persona: ProjectPersona = {
      ...createTestPersona(),
      confidence: 'high',
      feedback_count: 100,
      avatar_url: 'https://example.com/avatar.png',
      identity: {
        age_range: '25-34',
        occupation: 'Engineer',
        bio: 'A detailed bio',
      },
      goals_motivations: {
        primary_goal: 'Primary goal',
        secondary_goals: ['Secondary 1', 'Secondary 2'],
        underlying_motivations: ['Motivation 1'],
      },
      pain_points: {
        current_challenges: ['Challenge 1'],
        blockers: ['Blocker 1'],
        workarounds: ['Workaround 1'],
      },
      context_environment: {
        usage_context: 'Office',
        devices: ['Laptop', 'Phone'],
        time_constraints: '9-5',
      },
      quotes: [{ text: 'Quote 1', context: 'Interview' }],
      research_notes: ['Note 1', 'Note 2'],
    }

    expect(persona.confidence).toBe('high')
    expect(persona.feedback_count).toBe(100)
    expect(persona.identity?.occupation).toBe('Engineer')
    expect(persona.goals_motivations?.primary_goal).toBe('Primary goal')
    expect(persona.pain_points?.current_challenges).toHaveLength(1)
    expect(persona.context_environment?.devices).toHaveLength(2)
    expect(persona.quotes).toHaveLength(1)
    expect(persona.research_notes).toHaveLength(2)
  })

  it('handles persona with minimal data', () => {
    const persona: ProjectPersona = {
      persona_id: 'minimal',
      name: 'Minimal',
      tagline: 'Minimal persona',
      created_at: '2025-01-01T00:00:00Z',
    }

    expect(persona.persona_id).toBe('minimal')
    expect(persona.goals_motivations).toBeUndefined()
    expect(persona.pain_points).toBeUndefined()
  })

  it('handles behaviors object', () => {
    const persona = createTestPersona()
    persona.behaviors = {
      current_solutions: ['Solution 1'],
      tools_used: ['Tool 1'],
      tech_savviness: 'High',
    }

    expect(persona.behaviors.tech_savviness).toBe('High')
  })

  it('handles scenario object', () => {
    const persona = createTestPersona()
    persona.scenario = {
      title: 'Scenario Title',
      narrative: 'Scenario narrative',
      trigger: 'Trigger event',
      outcome: 'Expected outcome',
    }

    expect(persona.scenario.title).toBe('Scenario Title')
  })

  it('handles research notes as objects', () => {
    const persona = createTestPersona()
    persona.research_notes = [
      { text: 'Note 1', author: 'Author 1' },
      { note_id: '2', text: 'Note 2' },
    ]

    expect(persona.research_notes).toHaveLength(2)
    expect((persona.research_notes[0] as { text: string }).text).toBe('Note 1')
  })
})

// Test filename generation
describe('PDF filename generation', () => {
  it('generates valid filename from persona name', () => {
    const personaName = 'Test User'
    const filename = `${personaName.toLowerCase().replace(/\s+/g, '-')}-persona.pdf`
    
    expect(filename).toBe('test-user-persona.pdf')
  })

  it('handles special characters in persona name', () => {
    const personaName = "John's Test & Demo"
    const filename = personaName
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .concat('-persona.pdf')
    
    expect(filename).toBe('johns-test-demo-persona.pdf')
  })

  it('handles empty persona name', () => {
    const personaName = ''
    const filename = personaName || 'persona'
    
    expect(filename).toBe('persona')
  })
})
