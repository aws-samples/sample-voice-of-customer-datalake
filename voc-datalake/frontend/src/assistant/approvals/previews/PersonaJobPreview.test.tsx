/**
 * #353: the `generate_personas` approval card says what the run does to the project's
 * personas. Adding (absent / true) keeps them; `keep_existing_personas: false` deletes
 * them and the card says so with the count, before anyone approves.
 */
import { screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderWithQueryClient } from '../../../test/query-client'
import { PersonaJobPreview } from './PersonaJobPreview'

const getProject = vi.hoisted(() => vi.fn())
vi.mock('../../../api/projectsApi', () => ({ projectsApi: { getProject } }))

const P = 'proj_1'
const persona = (id: string) => ({ persona_id: id, name: `Persona ${id}` })

function show(args: Record<string, unknown>) {
  renderWithQueryClient(<PersonaJobPreview args={{ project_id: P, persona_count: 3, ...args }} />)
}

describe('the generate_personas card', () => {
  beforeEach(() => {
    getProject.mockReset()
    getProject.mockResolvedValue({ project: { project_id: P, name: 'Checkout' }, personas: [persona('a'), persona('b')], documents: [] })
  })

  it('says the existing personas are kept when the tool adds (the default)', async () => {
    show({})
    expect(await screen.findByText('Adds to the 2 personas the project has; they are kept.')).toBeInTheDocument()
  })

  it('warns with the count that a replace deletes the existing personas', async () => {
    show({ keep_existing_personas: false })
    expect(await screen.findByText(/Deletes the project's 2 existing personas/)).toBeInTheDocument()
  })

  it('does not list the raw flag next to the other arguments', async () => {
    show({ keep_existing_personas: false })
    await screen.findByText(/Deletes the project's 2 existing personas/)
    expect(screen.queryByText(/keep_existing_personas|Keep existing personas/i)).not.toBeInTheDocument()
  })

  it('says nothing about existing personas when the project has none', async () => {
    getProject.mockResolvedValue({ project: { project_id: P, name: 'Checkout' }, personas: [], documents: [] })
    show({ keep_existing_personas: false })
    await waitFor(() => expect(screen.queryByTestId('persona-mode')).not.toBeInTheDocument())
    expect(getProject).toHaveBeenCalledWith(P)
  })

  it('still warns before the project has loaded', () => {
    getProject.mockReturnValue(new Promise(() => {}))
    show({ keep_existing_personas: false })
    expect(screen.getByTestId('persona-mode')).toHaveTextContent("Deletes the project's existing personas")
  })

  it('claims no existing personas for an add before the project has loaded', () => {
    getProject.mockReturnValue(new Promise(() => {}))
    show({})
    expect(screen.queryByTestId('persona-mode')).not.toBeInTheDocument()
  })
})
