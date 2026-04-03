import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import PersonaAvatar from './PersonaAvatar'
import type { ProjectPersona } from '../../api/types'

const mockPersona: ProjectPersona = {
  persona_id: '1',
  name: 'Test User',
  description: 'A test persona',
  avatar_url: 'https://example.com/avatar.png',
}

describe('PersonaAvatar', () => {
  it('renders image when avatar_url is provided', () => {
    render(<PersonaAvatar persona={mockPersona} />)
    const img = screen.getByRole('img', { name: 'Test User' })
    expect(img).toHaveAttribute('src', 'https://example.com/avatar.png')
  })

  it('renders fallback with first letter when no avatar_url', () => {
    const persona = { ...mockPersona, avatar_url: undefined }
    render(<PersonaAvatar persona={persona} />)
    expect(screen.getByText('T')).toBeInTheDocument()
  })

  it('renders fallback on image error', () => {
    render(<PersonaAvatar persona={mockPersona} />)
    const img = screen.getByRole('img')
    fireEvent.error(img)
    expect(screen.getByText('T')).toBeInTheDocument()
  })

  it('applies small size class', () => {
    const persona = { ...mockPersona, avatar_url: undefined }
    render(<PersonaAvatar persona={persona} size="sm" />)
    const avatar = screen.getByText('T')
    expect(avatar).toHaveClass('w-10', 'h-10')
  })

  it('applies medium size class by default', () => {
    const persona = { ...mockPersona, avatar_url: undefined }
    render(<PersonaAvatar persona={persona} />)
    const avatar = screen.getByText('T')
    expect(avatar).toHaveClass('w-12', 'h-12')
  })

  it('applies large size class', () => {
    const persona = { ...mockPersona, avatar_url: undefined }
    render(<PersonaAvatar persona={persona} size="lg" />)
    const avatar = screen.getByText('T')
    expect(avatar).toHaveClass('w-24', 'h-24')
  })

  it('renders gradient background for fallback', () => {
    const persona = { ...mockPersona, avatar_url: undefined }
    render(<PersonaAvatar persona={persona} />)
    const avatar = screen.getByText('T')
    expect(avatar).toHaveClass('bg-gradient-to-br', 'from-purple-500', 'to-pink-500')
  })
})
