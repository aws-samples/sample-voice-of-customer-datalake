import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import PersonaSection from './PersonaSection'

describe('PersonaSection', () => {
  it('renders title with icon', () => {
    render(
      <PersonaSection title="Test Section" icon="🎯" color="purple">
        <p>Content</p>
      </PersonaSection>
    )
    expect(screen.getByText('🎯')).toBeInTheDocument()
    expect(screen.getByText('Test Section')).toBeInTheDocument()
  })

  it('renders children content', () => {
    render(
      <PersonaSection title="Test" icon="📝" color="blue">
        <p>Child content here</p>
      </PersonaSection>
    )
    expect(screen.getByText('Child content here')).toBeInTheDocument()
  })

  it('applies purple color classes', () => {
    const { container } = render(
      <PersonaSection title="Test" icon="🔮" color="purple">
        <p>Content</p>
      </PersonaSection>
    )
    const wrapper = container.firstChild as HTMLElement
    expect(wrapper).toHaveClass('border-purple-200', 'bg-purple-50/50')
  })

  it('applies green color classes', () => {
    const { container } = render(
      <PersonaSection title="Test" icon="✅" color="green">
        <p>Content</p>
      </PersonaSection>
    )
    const wrapper = container.firstChild as HTMLElement
    expect(wrapper).toHaveClass('border-green-200', 'bg-green-50/50')
  })

  it('applies title color class', () => {
    render(
      <PersonaSection title="Blue Title" icon="💙" color="blue">
        <p>Content</p>
      </PersonaSection>
    )
    const title = screen.getByText('Blue Title')
    expect(title).toHaveClass('text-blue-700')
  })
})
