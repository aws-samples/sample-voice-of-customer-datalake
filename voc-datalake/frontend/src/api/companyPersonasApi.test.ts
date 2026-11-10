/**
 * @fileoverview The company persona library client (5.60): every call reaches its own route with
 * its own method, ids are encoded once, the jobs list hides assist jobs, and the avatar
 * regeneration polls the library's job route.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchApi, resetFetchApi, routeFetchApi as route } from '@test/fetchApiRoutes'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { companyPersonasApi } = await import('./companyPersonasApi')

const START = { success: true, job_id: 'job_1', status: 'running', message: 'started' }

function sent(path: string, method: string): unknown {
  const call = fetchApi.mock.calls.find(([endpoint, options]) => endpoint === path && (options?.method ?? 'GET') === method)
  expect(call, `${method} ${path} was not called`).toBeDefined()
  const body = call?.[1]?.body
  return typeof body === 'string' ? JSON.parse(body) : undefined
}

beforeEach(() => {
  resetFetchApi()
})

describe('companyPersonasApi', () => {
  it('starts a generation with the date basis and the body it was given', async () => {
    route({ 'POST /company-personas/generate': () => START })

    await expect(companyPersonasApi.generate({ persona_count: 2, days: 30 })).resolves.toStrictEqual(START)

    expect(sent('/company-personas/generate', 'POST')).toMatchObject({ persona_count: 2, days: 30 })
  })

  it('starts an import on the library route', async () => {
    route({ 'POST /company-personas/import': () => START })

    await companyPersonasApi.importPersona({ input_type: 'text', content: 'A frequent flyer' })

    expect(sent('/company-personas/import', 'POST')).toStrictEqual({ input_type: 'text', content: 'A frequent flyer' })
  })

  it('lists the background jobs without the assist jobs', async () => {
    route({
      'GET /company-personas/jobs': () => ({
        jobs: [{ job_id: 'job_1', job_type: 'generate_personas' }, { job_id: 'job_2', job_type: 'assist_persona_avatar' }],
      }),
    })

    const { jobs } = await companyPersonasApi.getJobs()

    expect(jobs.map((job) => job.job_id)).toStrictEqual(['job_1'])
  })

  it('reads a jobs answer without a list as no jobs', async () => {
    route({ 'GET /company-personas/jobs': () => ({}) })

    await expect(companyPersonasApi.getJobs()).resolves.toStrictEqual({ jobs: [] })
  })

  it('updates and deletes a persona by its encoded id', async () => {
    route({
      'PUT /company-personas/p%2F1': () => ({ success: true }),
      'DELETE /company-personas/p%2F1': () => ({ success: true }),
    })

    await companyPersonasApi.updatePersona('p/1', { name: 'Farah' })
    await companyPersonasApi.deletePersona('p/1')

    expect(sent('/company-personas/p%2F1', 'PUT')).toStrictEqual({ name: 'Farah' })
    sent('/company-personas/p%2F1', 'DELETE')
  })

  it('regenerates an avatar as an assist job polled on the library job route', async () => {
    route({
      'POST /company-personas/p1/regenerate-avatar': () => ({ success: true, job_id: 'assist_1', status: 'pending' }),
      'GET /company-personas/jobs/assist_1': () => ({
        job_id: 'assist_1', status: 'completed', result: { avatar_url: 'https://cdn.example/a.png' },
      }),
    })

    await expect(companyPersonasApi.regeneratePersonaAvatar('p1')).resolves.toStrictEqual({ avatar_url: 'https://cdn.example/a.png' })
  })

  it('promotes a project persona and copies personas into a project', async () => {
    route({
      'POST /projects/proj_1/personas/p%201/promote': () => ({ success: true, persona: {} }),
      'POST /projects/proj_1/personas/copy': () => ({ success: true, personas: [{ persona_id: 'p9', name: 'Farah' }] }),
    })

    await companyPersonasApi.promotePersona('proj_1', 'p 1')
    const answer = await companyPersonasApi.copyPersonas('proj_1', { source: { scope: 'company' }, persona_ids: ['c1'] })

    sent('/projects/proj_1/personas/p%201/promote', 'POST')
    expect(sent('/projects/proj_1/personas/copy', 'POST')).toStrictEqual({ source: { scope: 'company' }, persona_ids: ['c1'] })
    expect(answer.personas.map((persona) => persona.persona_id)).toStrictEqual(['p9'])
  })

  it('encodes the project id, so it cannot reshape the project-side paths', async () => {
    route({
      'POST /projects/a%2F..%2Fb/personas/p1/promote': () => ({ success: true }),
      'GET /projects/a%2F..%2Fb/personas/copy-sources': () => ({ company: [], projects: [] }),
      'POST /projects/a%2F..%2Fb/personas/copy': () => ({ success: true, personas: [] }),
    })

    await companyPersonasApi.promotePersona('a/../b', 'p1')
    await companyPersonasApi.getPersonaCopySources('a/../b')
    await companyPersonasApi.copyPersonas('a/../b', { source: { scope: 'company' }, persona_ids: ['c1'] })

    expect(fetchApi.mock.calls.map(([endpoint]) => endpoint)).toStrictEqual([
      '/projects/a%2F..%2Fb/personas/p1/promote',
      '/projects/a%2F..%2Fb/personas/copy-sources',
      '/projects/a%2F..%2Fb/personas/copy',
    ])
  })
})
