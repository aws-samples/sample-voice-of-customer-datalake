/**
 * The Radar note on a source profile: "Radar source" is no longer offered on a profile
 * (brands live in Administration → Sources → Radar); a legacy profile that names a brand
 * shows it read-only with a link there, and the wire keeps its fields.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { defaultSourceProfile, normalizeSourceProfiles } from '../../api/sourceProfilesApi'
import RadarSourceField from './RadarSourceField'
import { draftProblem, toDraft, toWire } from './sourceDraft'
import type { SourceProfile } from '../../api/sourceProfilesApi'

const renderField = (profile: SourceProfile) => render(<MemoryRouter><RadarSourceField profile={profile} /></MemoryRouter>)

describe('RadarSourceField', () => {
  it('offers no Radar checkbox on an ordinary profile', () => {
    renderField(defaultSourceProfile('rival'))
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('shows a legacy profile\'s brand read-only, with a link to the Radar settings', () => {
    renderField({ ...defaultSourceProfile('rival'), radar_brand: 'Acme', radar_domains: ['acme.com'] })
    expect(screen.getByRole('note')).toHaveTextContent('Radar source for Acme')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByRole('link', { name: 'Open Radar settings' })).toHaveAttribute('href', '/admin?tab=sources&section=radar')
  })

  it('keeps a legacy profile\'s Radar fields on the wire', () => {
    const [wire] = toWire(toDraft([{ ...defaultSourceProfile('rival'), radar_brand: 'Acme', radar_domains: ['acme.com'] }]))
    expect(wire).toMatchObject({ radar_brand: 'Acme', radar_domains: ['acme.com'] })
  })
})

describe('Radar fields on the wire', () => {
  it('reads a Radar profile and leaves an ordinary one without the fields', () => {
    const [radar, ordinary] = normalizeSourceProfiles({ sources: [
      { id: 'rival', radar_brand: ' Acme ', radar_domains: ['acme.com'] }, { id: 'web' },
    ] })
    expect(radar).toMatchObject({ radar_brand: 'Acme', radar_domains: ['acme.com'] })
    expect(ordinary).not.toHaveProperty('radar_brand')
  })

  it('refuses to save a Radar source without a brand name', () => {
    const problem = draftProblem(toDraft([{ ...defaultSourceProfile('rival'), radar_brand: ' ', radar_domains: [] }]))
    expect(problem?.messageKey).toBe('components:sourcesManager.problems.radarBrand')
  })

  it('trims the brand and drops blank domains on save', () => {
    const [wire] = toWire(toDraft([{ ...defaultSourceProfile('rival'), radar_brand: ' Acme ', radar_domains: ['acme.com', ' '] }]))
    expect(wire).toMatchObject({ radar_brand: 'Acme', radar_domains: ['acme.com'] })
  })
})
