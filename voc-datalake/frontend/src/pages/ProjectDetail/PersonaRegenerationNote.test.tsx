/**
 * @fileoverview Tests for the persona wizard's note on what regeneration does
 * to the personas a project already has.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import PersonaRegenerationNote from './PersonaRegenerationNote'
import type { ProjectPersona } from '../../api/types'

function persona(id: string, isProtected?: boolean): ProjectPersona {
  return { persona_id: id, name: id, tagline: '', created_at: '', protected: isProtected }
}

describe('PersonaRegenerationNote', () => {
  it('says nothing when the project has no personas yet', () => {
    const { container } = render(<PersonaRegenerationNote personas={[]} />)

    expect(container).toBeEmptyDOMElement()
  })

  it('warns that every persona will be replaced when none is protected', () => {
    render(<PersonaRegenerationNote personas={[persona('a'), persona('b', false), persona('c')]} />)

    expect(screen.getByText('This replaces all 3 existing personas. Protect any you want to keep first.')).toBeInTheDocument()
  })

  it('uses the singular warning for a single unprotected persona', () => {
    render(<PersonaRegenerationNote personas={[persona('a')]} />)

    expect(screen.getByText('This replaces the existing persona. Protect it first if you want to keep it.')).toBeInTheDocument()
  })

  it('counts the protected personas kept and the others replaced', () => {
    render(<PersonaRegenerationNote personas={[persona('a', true), persona('b'), persona('c')]} />)

    expect(screen.getByText('1 protected persona will be kept. 2 unprotected personas will be replaced.')).toBeInTheDocument()
  })

  it('reports only what is kept when every persona is protected', () => {
    render(<PersonaRegenerationNote personas={[persona('a', true), persona('b', true)]} />)

    expect(screen.getByText('2 protected personas will be kept.')).toBeInTheDocument()
  })
})
