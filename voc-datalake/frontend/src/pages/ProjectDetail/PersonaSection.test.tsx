import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CheckCircle2, Heart, Sparkles, StickyNote, Target } from 'lucide-react'
import PersonaSection from './PersonaSection'

describe('PersonaSection', () => {
  it('renders title with a 16px muted lucide icon (never an emoji glyph)', () => {
    render(
      <PersonaSection title="Test Section" icon={Target} color="aim">
        <p>Content</p>
      </PersonaSection>
    )
    const icon = screen.getByTestId('persona-section-icon')
    expect(icon).toHaveClass('lucide-target', 'text-muted')
    expect({
      tag: icon.tagName, width: icon.getAttribute('width'), ariaHidden: icon.getAttribute('aria-hidden'),
    }).toStrictEqual({ tag: 'svg', width: '16', ariaHidden: 'true' })
    expect(screen.getByText('Test Section')).toBeInTheDocument()
  })

  it('renders children content', () => {
    render(
      <PersonaSection title="Test" icon={StickyNote} color="info">
        <p>Child content here</p>
      </PersonaSection>
    )
    expect(screen.getByText('Child content here')).toBeInTheDocument()
  })

  it('applies purple color classes', () => {
    const { container } = render(
      <PersonaSection title="Test" icon={Sparkles} color="aim">
        <p>Content</p>
      </PersonaSection>
    )
    const wrapper = container.firstElementChild
    expect(wrapper).toHaveClass('border-aim/30', 'bg-aim-subtle')
  })

  it('applies green color classes', () => {
    const { container } = render(
      <PersonaSection title="Test" icon={CheckCircle2} color="ok">
        <p>Content</p>
      </PersonaSection>
    )
    const wrapper = container.firstElementChild
    expect(wrapper).toHaveClass('border-ok/30', 'bg-ok-subtle')
  })

  it('applies title color class', () => {
    render(
      <PersonaSection title="Blue Title" icon={Heart} color="info">
        <p>Content</p>
      </PersonaSection>
    )
    const title = screen.getByText('Blue Title')
    expect(title).toHaveClass('text-info')
  })
})
