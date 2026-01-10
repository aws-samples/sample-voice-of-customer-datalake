/**
 * @fileoverview Tests for PersonaPDFContent component
 * @module components/PersonaExportMenu/PersonaPDFContent.test
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import PersonaPDFContent from './PersonaPDFContent'
import type { ProjectPersona } from '../../api/client'

const createMinimalPersona = (overrides: Partial<ProjectPersona> = {}): ProjectPersona => ({
  persona_id: 'persona-1',
  name: 'Test User',
  tagline: 'A test persona',
  created_at: '2025-01-01T00:00:00Z',
  ...overrides,
})

describe('PersonaPDFContent', () => {
  describe('Header Section', () => {
    it('renders persona name and tagline', () => {
      const persona = createMinimalPersona({ name: 'John Doe', tagline: 'Power user' })
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.getByText('John Doe')).toBeInTheDocument()
      expect(screen.getByText('Power user')).toBeInTheDocument()
    })

    it('renders avatar image when URL provided', () => {
      const persona = createMinimalPersona({ avatar_url: 'https://example.com/avatar.png' })
      render(<PersonaPDFContent persona={persona} />)

      const img = screen.getByRole('img', { name: 'Test User' })
      expect(img).toHaveAttribute('src', 'https://example.com/avatar.png')
    })

    it('renders initial fallback when no avatar URL', () => {
      const persona = createMinimalPersona({ name: 'Alice Smith' })
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.getByText('A')).toBeInTheDocument()
    })

    it('renders high confidence badge', () => {
      const persona = createMinimalPersona({ confidence: 'high', feedback_count: 50 })
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.getByText('high confidence • 50 reviews')).toBeInTheDocument()
    })

    it('renders medium confidence badge', () => {
      const persona = createMinimalPersona({ confidence: 'medium' })
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.getByText('medium confidence')).toBeInTheDocument()
    })

    it('renders low confidence badge', () => {
      const persona = createMinimalPersona({ confidence: 'low' })
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.getByText('low confidence')).toBeInTheDocument()
    })
  })

  describe('Identity Section', () => {
    it('renders identity bio', () => {
      const persona = createMinimalPersona({
        identity: { bio: 'A busy professional who values efficiency' },
      })
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.getByText('👤 Identity & Demographics')).toBeInTheDocument()
      expect(screen.getByText('A busy professional who values efficiency')).toBeInTheDocument()
    })

    it('renders identity attributes as tags', () => {
      const persona = createMinimalPersona({
        identity: {
          age_range: '25-34',
          occupation: 'Software Engineer',
          location: 'San Francisco',
        },
      })
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.getByText('age range: 25-34')).toBeInTheDocument()
      expect(screen.getByText('occupation: Software Engineer')).toBeInTheDocument()
      expect(screen.getByText('location: San Francisco')).toBeInTheDocument()
    })

    it('does not render section when identity is not present', () => {
      const persona: ProjectPersona = {
        persona_id: 'minimal',
        name: 'Minimal',
        tagline: 'Minimal persona',
        created_at: '2025-01-01T00:00:00Z',
      }
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.queryByText('👤 Identity & Demographics')).not.toBeInTheDocument()
    })
  })

  describe('Goals Section', () => {
    it('renders primary goal', () => {
      const persona = createMinimalPersona({
        goals_motivations: { primary_goal: 'Increase productivity by 50%' },
      })
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.getByText('🎯 Goals & Motivations')).toBeInTheDocument()
      expect(screen.getByText('Primary Goal')).toBeInTheDocument()
      expect(screen.getByText('Increase productivity by 50%')).toBeInTheDocument()
    })

    it('renders secondary goals', () => {
      const persona = createMinimalPersona({
        goals_motivations: { secondary_goals: ['Save time', 'Reduce errors'] },
      })
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.getByText('Secondary Goals')).toBeInTheDocument()
      expect(screen.getByText('Save time')).toBeInTheDocument()
      expect(screen.getByText('Reduce errors')).toBeInTheDocument()
    })

    it('renders underlying motivations', () => {
      const persona = createMinimalPersona({
        goals_motivations: { underlying_motivations: ['Career growth', 'Work-life balance'] },
      })
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.getByText('Underlying Motivations')).toBeInTheDocument()
      expect(screen.getByText('Career growth')).toBeInTheDocument()
    })

    it('renders secondary goals from goals_motivations', () => {
      const persona = createMinimalPersona({
        goals_motivations: { secondary_goals: ['Goal 1', 'Goal 2'] },
      })
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.getByText('Goal 1')).toBeInTheDocument()
      expect(screen.getByText('Goal 2')).toBeInTheDocument()
    })
  })

  describe('Pain Points Section', () => {
    it('renders current challenges', () => {
      const persona = createMinimalPersona({
        pain_points: { current_challenges: ['Too many manual steps', 'Slow performance'] },
      })
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.getByText('😤 Pain Points & Frustrations')).toBeInTheDocument()
      expect(screen.getByText('Current Challenges')).toBeInTheDocument()
      expect(screen.getByText('Too many manual steps')).toBeInTheDocument()
    })

    it('renders blockers', () => {
      const persona = createMinimalPersona({
        pain_points: { blockers: ['Budget constraints', 'Lack of training'] },
      })
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.getByText('Blockers')).toBeInTheDocument()
      expect(screen.getByText('Budget constraints')).toBeInTheDocument()
    })

    it('renders workarounds', () => {
      const persona = createMinimalPersona({
        pain_points: { workarounds: ['Using spreadsheets', 'Manual tracking'] },
      })
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.getByText('Current Workarounds')).toBeInTheDocument()
      expect(screen.getByText('Using spreadsheets')).toBeInTheDocument()
    })

    it('renders current challenges from pain_points', () => {
      const persona = createMinimalPersona({ 
        pain_points: { current_challenges: ['Challenge 1', 'Challenge 2'] } 
      })
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.getByText('Challenge 1')).toBeInTheDocument()
    })
  })

  describe('Behaviors Section', () => {
    it('renders behaviors object with current solutions', () => {
      const persona = createMinimalPersona({
        behaviors: {
          current_solutions: ['Competitor A', 'Manual process'],
          tech_savviness: 'High',
          activity_frequency: 'Daily',
          decision_style: 'Data-driven',
        },
      })
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.getByText('🔄 Behaviors & Habits')).toBeInTheDocument()
      expect(screen.getByText('Current Solutions')).toBeInTheDocument()
      expect(screen.getByText('Competitor A')).toBeInTheDocument()
      expect(screen.getByText('Tech: High')).toBeInTheDocument()
      expect(screen.getByText('Daily')).toBeInTheDocument()
      expect(screen.getByText('Data-driven')).toBeInTheDocument()
    })

    it('renders tools used', () => {
      const persona = createMinimalPersona({
        behaviors: { tools_used: ['Slack', 'Notion', 'Figma'] },
      })
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.getByText('Tools Used')).toBeInTheDocument()
      expect(screen.getByText('Slack')).toBeInTheDocument()
      expect(screen.getByText('Notion')).toBeInTheDocument()
    })
  })

  describe('Context Section', () => {
    it('renders usage context', () => {
      const persona = createMinimalPersona({
        context_environment: { usage_context: 'Works from home office' },
      })
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.getByText('🌍 Context & Environment')).toBeInTheDocument()
      expect(screen.getByText('Works from home office')).toBeInTheDocument()
    })

    it('renders devices', () => {
      const persona = createMinimalPersona({
        context_environment: { devices: ['MacBook Pro', 'iPhone', 'iPad'] },
      })
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.getByText('MacBook Pro')).toBeInTheDocument()
      expect(screen.getByText('iPhone')).toBeInTheDocument()
    })

    it('renders time constraints', () => {
      const persona = createMinimalPersona({
        context_environment: { time_constraints: 'Limited to 30 min sessions' },
      })
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.getByText(/Limited to 30 min sessions/)).toBeInTheDocument()
    })
  })

  describe('Quotes Section', () => {
    it('renders quotes array', () => {
      const persona = createMinimalPersona({
        quotes: [
          { text: 'I need this to be faster', context: 'During user interview' },
          { text: 'The old system was better' },
        ],
      })
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.getByText('💬 Representative Quotes')).toBeInTheDocument()
      expect(screen.getByText('"I need this to be faster"')).toBeInTheDocument()
      expect(screen.getByText('— During user interview')).toBeInTheDocument()
      expect(screen.getByText('"The old system was better"')).toBeInTheDocument()
    })

    it('renders quotes from quotes array', () => {
      const persona = createMinimalPersona({ quotes: [{ text: 'This is my favorite feature' }] })
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.getByText('"This is my favorite feature"')).toBeInTheDocument()
    })
  })

  describe('Scenario Section', () => {
    it('renders scenario object', () => {
      const persona = createMinimalPersona({
        scenario: {
          title: 'Morning Routine',
          narrative: 'User starts their day by checking notifications.',
          trigger: 'Alarm goes off',
          outcome: 'All tasks reviewed',
        },
      })
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.getByText('📖 Scenario')).toBeInTheDocument()
      expect(screen.getByText('Morning Routine')).toBeInTheDocument()
      expect(screen.getByText('User starts their day by checking notifications.')).toBeInTheDocument()
      expect(screen.getByText('Trigger')).toBeInTheDocument()
      expect(screen.getByText('Alarm goes off')).toBeInTheDocument()
      expect(screen.getByText('Desired Outcome')).toBeInTheDocument()
      expect(screen.getByText('All tasks reviewed')).toBeInTheDocument()
    })
  })

  describe('Research Notes Section', () => {
    it('renders research notes as strings', () => {
      const persona = createMinimalPersona({
        research_notes: ['Note 1', 'Note 2', 'Note 3'],
      })
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.getByText('📝 Research Notes')).toBeInTheDocument()
      expect(screen.getByText('Note 1')).toBeInTheDocument()
      expect(screen.getByText('Note 2')).toBeInTheDocument()
    })

    it('renders research notes as objects', () => {
      const persona = createMinimalPersona({
        research_notes: [
          { text: 'Observation from interview' },
          { note_id: '1', text: 'Survey response insight' },
        ],
      })
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.getByText('Observation from interview')).toBeInTheDocument()
      expect(screen.getByText('Survey response insight')).toBeInTheDocument()
    })
  })

  describe('Footer', () => {
    it('renders generation date', () => {
      const persona = createMinimalPersona()
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.getByText(/Generated on/)).toBeInTheDocument()
      expect(screen.getByText(/VoC Analytics/)).toBeInTheDocument()
    })
  })

  describe('Empty Sections', () => {
    it('does not render goals section when no goals data', () => {
      const persona = createMinimalPersona()
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.queryByText('🎯 Goals & Motivations')).not.toBeInTheDocument()
    })

    it('does not render pain points section when no frustrations', () => {
      const persona = createMinimalPersona()
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.queryByText('😤 Pain Points & Frustrations')).not.toBeInTheDocument()
    })

    it('does not render behaviors section when no behaviors', () => {
      const persona = createMinimalPersona()
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.queryByText('🔄 Behaviors & Habits')).not.toBeInTheDocument()
    })

    it('does not render context section when no context_environment', () => {
      const persona = createMinimalPersona()
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.queryByText('🌍 Context & Environment')).not.toBeInTheDocument()
    })

    it('does not render quotes section when no quotes', () => {
      const persona = createMinimalPersona()
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.queryByText('💬 Representative Quotes')).not.toBeInTheDocument()
    })

    it('does not render scenario section when scenario is empty', () => {
      const persona = createMinimalPersona()
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.queryByText('📖 Scenario')).not.toBeInTheDocument()
    })

    it('does not render research notes section when no notes', () => {
      const persona = createMinimalPersona()
      render(<PersonaPDFContent persona={persona} />)

      expect(screen.queryByText('📝 Research Notes')).not.toBeInTheDocument()
    })
  })
})
