/**
 * The local copies a reference keeps (5.48): the sanitised SVG is a download link only (never an image in the
 * page), the copied icons are thumbnails of the server's copies, and a wire shape that is not one of them is
 * dropped by the schema before it renders.
 */
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithQueryClient } from '@test/query-client'
import { normalizeDesignSystem } from '../../api/designSystemApi'
import type { ExtractedDesign } from '../../api/designSystemApi'
import ReferenceDesignPreview from './ReferenceDesignPreview'

const SIGNED = 'https://raw.s3.amazonaws.com/company-context/design/logo_preview_ref_0123456789ab.svg?X-Amz-Signature=s'

function designFrom(extracted: Record<string, unknown>): ExtractedDesign {
  const system = normalizeDesignSystem({ references: [{ id: 'ref_0123456789ab', kind: 'website', status: 'ready',
    extracted_design: extracted }] })
  const design = system.references[0]?.extracted_design
  if (!design) throw new Error('the fixture did not parse')
  return design
}

describe('ReferenceDesignPreview: the local copies', () => {
  it('offers the sanitised SVG as a download link and never loads it as an image', () => {
    renderWithQueryClient(<ReferenceDesignPreview design={designFrom({
      logo: { source_url: 'https://site.example/logo.svg', content_type: 'image/png', rendered: true, svg_preview_url: SIGNED },
    })} />)
    const link = screen.getByRole('link', { name: 'Download SVG' })
    expect(link.getAttribute('href')).toBe(SIGNED)
    expect(link.hasAttribute('download')).toBe(true)
    expect(document.querySelector(`img[src="${SIGNED}"]`)).toBeNull()
  })

  it('shows no download link without an SVG copy', () => {
    renderWithQueryClient(<ReferenceDesignPreview design={designFrom({
      logo: { source_url: 'https://site.example/logo.png', content_type: 'image/png' },
    })} />)
    expect(screen.queryByRole('link', { name: 'Download SVG' })).toBeNull()
  })

  it('lists one thumbnail per copied icon and drops entries that are not local copies', () => {
    renderWithQueryClient(<ReferenceDesignPreview design={designFrom({
      colors: [{ name: 'primary', value: '#7c3aed' }],
      icons: [
        { kind: 'icon', sizes: '32x32', content_type: 'image/png', url: '/mock-design-logo/preview/kirocrew.png' },
        { kind: 'touch-icon', url: 'javascript:alert(1)' },
        { kind: 'favicon' },
        'nope',
      ],
    })} />)
    const strip = screen.getByRole('list', { name: 'Site icons' })
    expect(strip.querySelectorAll('li')).toHaveLength(1)
    expect(strip.querySelector('li')?.getAttribute('title')).toBe('32x32')
  })

  it('renders no icon strip for a reference without icons', () => {
    renderWithQueryClient(<ReferenceDesignPreview design={designFrom({ colors: [{ name: 'primary', value: '#7c3aed' }] })} />)
    expect(screen.queryByTestId('reference-icons')).toBeNull()
  })
})
