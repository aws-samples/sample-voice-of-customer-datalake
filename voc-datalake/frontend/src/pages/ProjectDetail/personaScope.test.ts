/**
 * @fileoverview The persona scope adapter (5.60): a project scope calls the project
 * routes exactly as before; the company scope
 * calls `/company-personas` only, so library personas never go through `/projects/...`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchApi, resetFetchApi } from '@test/fetchApiRoutes'
import { COMPANY_PERSONA_SCOPE, personaScopeApi, personaScopeJobsKey, personaScopeKey, projectPersonaScope } from './personaScope'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const lastCall = () => fetchApi.mock.calls.at(-1)

beforeEach(() => {
  resetFetchApi()
  fetchApi.mockResolvedValue({ success: true, job_id: 'j1', status: 'running', message: '' })
})

describe('personaScopeApi', () => {
  it('sends a project update to the project route', async () => {
    await personaScopeApi(projectPersonaScope('proj_1')).updatePersona('persona_1', { tagline: 'x' })
    expect(lastCall()?.[0]).toBe('/projects/proj_1/personas/persona_1')
  })

  it('sends a library update to the company route', async () => {
    await personaScopeApi(COMPANY_PERSONA_SCOPE).updatePersona('cpersona_1', { tagline: 'x' })
    expect(lastCall()?.[0]).toBe('/company-personas/cpersona_1')
  })

  it('imports and deletes in the library on its own routes', async () => {
    await personaScopeApi(COMPANY_PERSONA_SCOPE).importPersona({ input_type: 'text', content: 'x' })
    expect(lastCall()?.[0]).toBe('/company-personas/import')
    await personaScopeApi(COMPANY_PERSONA_SCOPE).deletePersona('cpersona_1')
    expect(lastCall()).toStrictEqual(['/company-personas/cpersona_1', expect.objectContaining({ method: 'DELETE' })])
  })
})

describe('scope query keys', () => {
  it('reuse the project page keys for a project', () => {
    expect(personaScopeKey(projectPersonaScope('proj_1'))).toStrictEqual(['project', 'proj_1'])
    expect(personaScopeJobsKey(projectPersonaScope('proj_1'))).toStrictEqual(['project-jobs', 'proj_1'])
  })

  it('give the library its own keys', () => {
    expect(personaScopeKey(COMPANY_PERSONA_SCOPE)).toStrictEqual(['company-personas'])
    expect(personaScopeJobsKey(COMPANY_PERSONA_SCOPE)).toStrictEqual(['company-persona-jobs'])
  })
})
