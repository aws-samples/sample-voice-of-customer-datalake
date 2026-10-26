import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Frown, Heart, NotebookPen, StickyNote, Target } from 'lucide-react'
import PersonaSection from './PersonaSection'

describe('PersonaSection', () => {
  it('renders title with a 16px muted lucide icon (never an emoji glyph)', () => {
    render(
      <PersonaSection title="Test Section" icon={Target}>
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
      <PersonaSection title="Test" icon={StickyNote}>
        <p>Child content here</p>
      </PersonaSection>
    )
    expect(screen.getByText('Child content here')).toBeInTheDocument()
  })

  // Labels vs status (design-system rule 15): a section is a KIND, so it is a neutral
  // card and its heading is the strong text colour — never a tone per section.
  it('is a neutral card with a strong heading by default', () => {
    const { container } = render(
      <PersonaSection title="Neutral Title" icon={Heart}>
        <p>Content</p>
      </PersonaSection>
    )
    const wrapper = container.firstElementChild
    expect(wrapper).toHaveClass('border-border', 'bg-card')
    expect(wrapper?.className).not.toMatch(/\b(?:bg|border)-(?:aim|info|ok|warn|accent|danger)/)
    expect(screen.getByText('Neutral Title')).toHaveClass('text-text-strong')
  })

  it('paints the pain-points state danger (negative sentiment is a state, not a kind)', () => {
    const { container } = render(
      <PersonaSection title="Pain points" icon={Frown} color="danger">
        <p>Content</p>
      </PersonaSection>
    )
    expect(container.firstElementChild).toHaveClass('border-danger/30', 'bg-danger-subtle')
    expect(screen.getByText('Pain points')).toHaveClass('text-danger')
  })

  it('keeps the quiet muted panel for research notes', () => {
    const { container } = render(
      <PersonaSection title="Notes" icon={NotebookPen} color="muted">
        <p>Content</p>
      </PersonaSection>
    )
    expect(container.firstElementChild).toHaveClass('border-border', 'bg-bg-accent/50')
    expect(screen.getByText('Notes')).toHaveClass('text-text-strong')
  })
})
