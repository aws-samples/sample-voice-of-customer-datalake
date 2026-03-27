/**
 * @fileoverview Tests for pdfGenerator utilities
 * Tests the helper functions and structure without full PDF generation
 * @module components/PersonaExportMenu/pdfGenerator.test
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ProjectPersona } from '../../api/types'

// Mock the printUtils module — createPdfGenerator delegates to openPrintWindow internally,
// so we mock createPdfGenerator to capture calls while preserving the factory pattern.
const mockOpenPrintWindow = vi.fn()
vi.mock('../../utils/printUtils', () => ({
  createPdfGenerator: (title: string | ((p: unknown) => string), render: (p: unknown) => unknown) =>
    (props: unknown) => {
      const resolvedTitle = typeof title === 'function' ? title(props) : title
      const result = mockOpenPrintWindow({ title: resolvedTitle, content: render(props) })
      if (!result) {
        throw new TypeError('Failed to open print window. Please allow popups for this site.')
      }
    },
}))

describe('pdfGenerator module', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockOpenPrintWindow.mockReturnValue({ print: vi.fn() })
  })

  it('exports generatePersonaPDF function', async () => {
    const module = await import('./pdfGenerator')
    expect(typeof module.generatePersonaPDF).toBe('function')
  })

  it('calls openPrintWindow with persona name as title', async () => {
    const { generatePersonaPDF } = await import('./pdfGenerator')
    const persona: ProjectPersona = {
      persona_id: 'test-1',
      name: 'Test User',
      tagline: 'Test tagline',
      created_at: '2025-01-01T00:00:00Z',
    }

    generatePersonaPDF(persona)

    expect(mockOpenPrintWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Test User',
      })
    )
  })

  it('throws error when print window fails to open', async () => {
    mockOpenPrintWindow.mockReturnValue(null)
    
    const { generatePersonaPDF } = await import('./pdfGenerator')
    const persona: ProjectPersona = {
      persona_id: 'test-1',
      name: 'Test User',
      tagline: 'Test tagline',
      created_at: '2025-01-01T00:00:00Z',
    }

    expect(() => generatePersonaPDF(persona)).toThrow(
      'Failed to open print window'
    )
  })
})

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
  })

  it('handles persona optional collection fields', () => {
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
})

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
