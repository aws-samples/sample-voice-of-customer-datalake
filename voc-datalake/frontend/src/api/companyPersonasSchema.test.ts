/**
 * @fileoverview The company persona boundaries (5.60) are lenient: a persona without an
 * id is dropped, a malformed `copied_from` reads as "not a copy", a missing envelope is
 * empty, and `can_edit` is false unless the API says true.
 */
import { describe, it, expect } from 'vitest'
import {
  normalizeCompanyPersonas, normalizeCopyAnswer, normalizeCopySources,
} from './companyPersonasSchema'

const COPIED = { scope: 'project', project_id: 'proj_2', project_name: 'Mobile App Redesign', persona_id: 'persona_3', copied_at: '2026-10-18T09:00:00Z', copied_by: 'sub-a' }

describe('normalizeCompanyPersonas', () => {
  it('keeps personas with an id and the admin flag', () => {
    const out = normalizeCompanyPersonas({ personas: [{ persona_id: 'c1', name: 'Farah' }, { name: 'no id' }], can_edit: true })
    expect(out.personas.map((p) => p.persona_id)).toStrictEqual(['c1'])
    expect(out.canEdit).toBe(true)
  })

  it('reads a missing or malformed answer as an empty, read-only library', () => {
    expect(normalizeCompanyPersonas(null)).toStrictEqual({ personas: [], canEdit: false })
    expect(normalizeCompanyPersonas({ personas: 'x', can_edit: 'yes' })).toStrictEqual({ personas: [], canEdit: false })
  })

  it('keeps a well-formed copied_from and drops a malformed one', () => {
    const out = normalizeCompanyPersonas({ personas: [
      { persona_id: 'c1', copied_from: COPIED },
      { persona_id: 'c2', copied_from: { scope: 'elsewhere' } },
    ] })
    expect(out.personas[0]?.copied_from).toStrictEqual(COPIED)
    expect(out.personas[1]?.copied_from).toBeUndefined()
  })
})

describe('normalizeCopySources', () => {
  it('keeps usable summaries and projects, defaulting their fields', () => {
    const out = normalizeCopySources({
      company: [{ persona_id: 'c1', name: 'Farah' }, { name: 'no id' }],
      projects: [{ project_id: 'proj_3', name: 'Pricing', persona_count: 'two' }, {}],
    })
    expect(out.company).toStrictEqual([{ persona_id: 'c1', name: 'Farah', tagline: '', avatar_url: null }])
    expect(out.projects).toStrictEqual([{ project_id: 'proj_3', name: 'Pricing', persona_count: 0 }])
  })

  it('reads a missing answer as no sources', () => {
    expect(normalizeCopySources(undefined)).toStrictEqual({ company: [], projects: [] })
  })
})

describe('normalizeCopyAnswer', () => {
  it('reads the copies written', () => {
    expect(normalizeCopyAnswer({ personas: [{ persona_id: 'p9' }, 'junk'] }).personas.map((p) => p.persona_id)).toStrictEqual(['p9'])
    expect(normalizeCopyAnswer('nope').personas).toStrictEqual([])
  })
})
