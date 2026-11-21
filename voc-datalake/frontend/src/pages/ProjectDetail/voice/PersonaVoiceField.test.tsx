/**
 * The persona's voice in its edit dialog: Default or one of the 16 voices, each named with its gender and what it
 * speaks; a choice is the persona's `voice_id`, Default sends `null` (back to the deterministic pick).
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import PersonaVoiceField from './PersonaVoiceField'
import type { ProjectPersona } from '../../../api/projectTypes'

const PERSONA: ProjectPersona = { persona_id: 'p1', name: 'Ada', tagline: '', created_at: '', voice_id: 'amy' }

describe('PersonaVoiceField', () => {
  it('lists Default and the 16 voices, the polyglot ones as speaking every language', () => {
    render(<PersonaVoiceField persona={PERSONA} onChange={vi.fn()} />)
    const options = screen.getAllByRole('option').map((option) => option.textContent)
    expect(options).toHaveLength(17)
    expect(options.slice(0, 4)).toStrictEqual(['Default (chosen for this persona)', 'Tiffany (feminine, every language)',
      'Matthew (masculine, every language)', 'Amy (feminine, en-GB)'])
    expect(screen.getByRole('combobox', { name: 'Voice when you talk to this persona' })).toHaveValue('amy')
  })

  it('saves a chosen voice as voice_id, and Default as null', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<PersonaVoiceField persona={PERSONA} onChange={onChange} />)
    const select = screen.getByRole('combobox')
    await user.selectOptions(select, 'leo')
    await user.selectOptions(select, '')
    expect(onChange.mock.calls.map(([persona]: unknown[]) => persona)).toStrictEqual([
      { ...PERSONA, voice_id: 'leo' }, { ...PERSONA, voice_id: null }])
  })
})
