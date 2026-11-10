/**
 * @fileoverview Every field of the persona editor changes exactly its own value:
 * the rest of the persona and of the field's group are kept, list fields take one
 * item per non-blank line, and each control is reachable by its label.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import PersonaEditModal from './PersonaEditModal'
import type { ProjectPersona } from '../../api/projectTypes'

const persona: ProjectPersona = {
  persona_id: 'persona_1',
  name: 'Frequent flyer',
  tagline: 'Flies Example Air every week',
  created_at: '2026-01-01T00:00:00Z',
  identity: { bio: 'Consultant', age_range: '30-40', location: 'Lisbon' },
  goals_motivations: { primary_goal: 'Arrive on time', secondary_goals: ['Lounge access'] },
  pain_points: { current_challenges: ['Delays'], workarounds: ['Earlier flights'] },
  quotes: [{ text: 'Just get me there.' }],
  scenario: { title: 'Monday trip', narrative: 'Early flight' },
}

function renderEditor() {
  const onChange = vi.fn<(p: ProjectPersona) => void>()
  render(<PersonaEditModal persona={persona} onChange={onChange} onSave={() => Promise.resolve()} onClose={vi.fn()} isSaving={false} />)
  return onChange
}

function change(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

describe('PersonaEditModal', () => {
  it('changes a top-level field only', () => {
    const onChange = renderEditor()
    change('Name', 'Business traveller')
    expect(onChange).toHaveBeenLastCalledWith({ ...persona, name: 'Business traveller' })
  })

  it('changes one identity field and keeps the others', () => {
    const onChange = renderEditor()
    change('Occupation', 'Engineer')
    expect(onChange).toHaveBeenLastCalledWith({ ...persona, identity: { ...persona.identity, occupation: 'Engineer' } })
  })

  it('splits list fields into one item per non-blank line', () => {
    const onChange = renderEditor()
    change('Secondary Goals (one per line)', 'Lounge access\n\n  \nFast boarding')
    expect(onChange).toHaveBeenLastCalledWith({
      ...persona,
      goals_motivations: { ...persona.goals_motivations, secondary_goals: ['Lounge access', 'Fast boarding'] },
    })
  })

  it('changes a pain-point list and keeps the other list', () => {
    const onChange = renderEditor()
    change('Workarounds (one per line)', 'Train')
    expect(onChange).toHaveBeenLastCalledWith({ ...persona, pain_points: { ...persona.pain_points, workarounds: ['Train'] } })
  })

  it('changes one scenario field and keeps the others', () => {
    const onChange = renderEditor()
    change('Desired Outcome', 'On time')
    expect(onChange).toHaveBeenLastCalledWith({ ...persona, scenario: { ...persona.scenario, outcome: 'On time' } })
  })

  it('creates a group that was missing', () => {
    const onChange = vi.fn<(p: ProjectPersona) => void>()
    const bare: ProjectPersona = { persona_id: 'p2', name: 'New', tagline: '', created_at: '2026-01-01T00:00:00Z' }
    render(<PersonaEditModal persona={bare} onChange={onChange} onSave={() => Promise.resolve()} onClose={vi.fn()} isSaving={false} />)
    change('Primary Goal', 'Save time')
    expect(onChange).toHaveBeenLastCalledWith({ ...bare, goals_motivations: { primary_goal: 'Save time' } })
  })
})
