/**
 * @fileoverview Agents → Skills → Library (7.56.00): the Roles and Library views as paths, each library skill with its
 * description, source, licence, what was adapted and the roles that use it, its empty and failed states, and a skill's
 * page reading its SKILL.md (front matter as Properties) and a reference file through the document component, the file
 * in the address.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import Where from '@test/LocationWhere'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { EngineeringSkills } = await import('./EngineeringSkills')

const LIBRARY = 'GET /agents/engineering/skill-library'
const TDD = {
  name: 'tdd', description: 'Test first: a failing test, the smallest change, then refactor.',
  source: 'ai-skill-factory 2.0.0 (Amit Deol), skills/tdd', license: 'MIT',
  adapted: 'Cross-references name the read_skill tool.', path: 'skills/tdd/SKILL.md', digest: 'sha256:t', bytes: 7000,
  roles: ['fixer', 'builder'], references: [{ path: 'references/sources.md', digest: 'sha256:r', bytes: 600 }],
}
const UNUSED = { ...TDD, name: 'skill-audit', roles: [], references: [], adapted: '' }
const SKILL_MD = { name: 'tdd', reference: null, path: 'skills/tdd/SKILL.md', digest: 'sha256:t', bytes: 60,
  text: '---\nname: tdd\nlicense: MIT\n---\n## Red first\n\nWrite the failing test.\n' }
const SOURCES_MD = { name: 'tdd', reference: 'references/sources.md', path: 'skills/tdd/references/sources.md', digest: 'sha256:r',
  bytes: 30, text: '## Sources\n\nThe test-sizing note.\n' }

/** The library's routes, the connections beside them for the roles' scope picker; anything else fails (500). */
const route = (routes: Record<string, RouteHandler>) => {
  routeFetchApi({ ...routes, 'GET /agents/engineering/connections': () => ({ connections: [], limit: 20 }) }, { missStatus: 500 })
}

const renderSkills = (entry: string) => renderWithQueryClient(
  <TestRouter initialEntries={[entry]}>
    <Routes><Route path="/agents/skills/*" element={<><EngineeringSkills /><Where /></>} /></Routes>
  </TestRouter>,
)

beforeEach(() => { resetFetchApi() })

describe('Agents → Skills → Library: the list', () => {
  it('shows each skill with its description, source, licence, what was adapted and the roles that use it', async () => {
    route({ [LIBRARY]: () => ({ skills: [TDD, UNUSED] }) })
    renderSkills('/agents/skills/library')
    const item = await screen.findByRole('listitem', { name: 'tdd' })
    expect(within(item).getByText('From ai-skill-factory 2.0.0 (Amit Deol), skills/tdd · licence MIT')).toBeInTheDocument()
    expect(within(item).getByText('Adapted: Cross-references name the read_skill tool.')).toBeInTheDocument()
    expect(within(item).getByRole('link', { name: 'Feature builder' })).toHaveAttribute('href', '/agents/registry/builder')
    expect(screen.getByText('No role uses it')).toBeInTheDocument()
  })

  it('says a release with no library skills ships none, and a failed read failed, with a retry', async () => {
    route({ [LIBRARY]: () => ({ skills: [] }) })
    const { unmount } = renderSkills('/agents/skills/library')
    expect(await screen.findByText('This release ships no library skills.')).toBeInTheDocument()
    unmount()
    route({})
    renderSkills('/agents/skills/library')
    expect(await screen.findByRole('alert')).toHaveTextContent('The skills library could not be loaded. Try again in a moment.')
    expect(screen.queryByText('This release ships no library skills.')).not.toBeInTheDocument()
  })

  it('switches between the roles and the library, each a path, the library with no scope picker', async () => {
    route({ [LIBRARY]: () => ({ skills: [TDD] }), 'GET /agents/engineering/skills?connection=': () => ({ connection: '', roles: [] }) })
    renderSkills('/agents/skills')
    await userEvent.click(within(screen.getByRole('group', { name: 'Show' })).getByRole('button', { name: 'Library' }))
    expect(await screen.findByRole('link', { name: 'Open the skill tdd' })).toBeInTheDocument()
    expect(screen.getByTestId('where')).toHaveTextContent('/agents/skills/library')
    expect(screen.queryByRole('combobox', { name: 'Skills of' })).not.toBeInTheDocument()
  })
})

describe('Agents → Skills → Library: a skill', () => {
  const routes = {
    [LIBRARY]: () => ({ skills: [TDD] }),
    'GET /agents/engineering/skill-library/tdd': () => SKILL_MD,
    'GET /agents/engineering/skill-library/tdd?reference=references%2Fsources.md': () => SOURCES_MD,
  }

  it('reads its SKILL.md on the document component, its front matter as Properties', async () => {
    route(routes)
    renderSkills('/agents/skills/library/tdd')
    expect(await screen.findByRole('heading', { name: 'Red first' })).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Properties' })).getByText('MIT')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'SKILL.md' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('opens a reference file, the file in the address, and goes back to the library', async () => {
    route(routes)
    renderSkills('/agents/skills/library/tdd')
    await userEvent.click(await screen.findByRole('button', { name: 'references/sources.md' }))
    expect(await screen.findByRole('heading', { name: 'Sources' })).toBeInTheDocument()
    expect(screen.getByTestId('where')).toHaveTextContent('/agents/skills/library/tdd/references/sources.md')
    await userEvent.click(screen.getByRole('link', { name: 'All library skills' }))
    await waitFor(() => { expect(screen.getByTestId('where')).toHaveTextContent(/^\/agents\/skills\/library$/) })
  })

  it('says a skill the library has not is missing, and a file it has not too', async () => {
    route({ [LIBRARY]: () => ({ skills: [TDD] }) })
    const { unmount } = renderSkills('/agents/skills/library/no-such')
    expect(await screen.findByText('The library has no skill no-such. Go back to the library and pick another.')).toBeInTheDocument()
    unmount()
    routeFetchApi({ [LIBRARY]: () => ({ skills: [TDD] }) }, { missStatus: 404 })
    renderSkills('/agents/skills/library/tdd/references/gone.md')
    expect(await screen.findByText('This skill has no file references/gone.md. Pick another of its files.')).toBeInTheDocument()
  })
})
