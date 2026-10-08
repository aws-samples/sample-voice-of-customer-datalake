import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { GhostIdle, GhostThinking } from './GhostPoses'
import type { ReactElement } from 'react'

function svgOf(ui: ReactElement): SVGSVGElement {
  const svg = render(ui).container.querySelector('svg')
  if (svg === null) throw new Error('no svg rendered')
  return svg
}

describe.each([
  ['GhostIdle', <GhostIdle key="idle" className="h-4" />],
  ['GhostThinking', <GhostThinking key="thinking" className="h-4" />],
])('%s', (_name, ui) => {
  it('is decorative: hidden from assistive tech and not focusable', () => {
    const svg = svgOf(ui)
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).toHaveAttribute('focusable', 'false')
    expect(svg.querySelector('title')).toBeNull()
  })

  it('uses theme tokens only: card-surface body, currentColor outline and eyes', () => {
    const paths = [...svgOf(ui).querySelectorAll('path')]
    expect(paths.map((p) => [p.getAttribute('fill'), p.getAttribute('stroke')])).toStrictEqual([
      ['var(--color-card)', 'currentColor'],
      ['currentColor', null],
      ['currentColor', null],
    ])
  })

  it('passes the caller class through', () => {
    expect(svgOf(ui)).toHaveClass('h-4')
  })
})

describe('GhostThinking motion', () => {
  it('bobs with the shared float animation, off under prefers-reduced-motion', () => {
    expect(svgOf(<GhostThinking />)).toHaveClass('animate-float', 'motion-reduce:animate-none')
  })

  it('GhostIdle stays still', () => {
    expect(svgOf(<GhostIdle />).getAttribute('class') ?? '').not.toContain('animate')
  })
})
