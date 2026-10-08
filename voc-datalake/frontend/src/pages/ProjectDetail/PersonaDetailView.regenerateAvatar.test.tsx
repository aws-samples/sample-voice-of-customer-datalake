/**
 * QA s3 F3: "Regenerate avatar" existed only as an API route. The persona detail
 * now has the control: it shows progress while the image model runs, swaps in the
 * NEW image URL from the answer, and reports a failure. Viewers do not get it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import PersonaDetailView from './PersonaDetailView'
import type { ProjectPersona } from '../../api/projectTypes'

const regeneratePersonaAvatar = vi.hoisted(() => vi.fn<(projectId: string, personaId: string) => Promise<{ avatar_url: string | null }>>())
vi.mock('../../api/projectsApi', () => ({ projectsApi: { regeneratePersonaAvatar } }))

const persona: ProjectPersona = {
  persona_id: 'persona_1', name: 'Ada', tagline: 'Ships on Fridays', created_at: '',
  avatar_url: 'https://cdn.example/avatars/persona_1/old.jpeg?Signature=a',
}

function renderDetail(canEdit = true) {
  return renderWithQueryClient(
    <PersonaDetailView projectId="proj_1" persona={persona} canEdit={canEdit}
      onEdit={vi.fn()} onDelete={vi.fn()} onSaveNotes={vi.fn()} isDeleting={false} isSavingNotes={false} />,
  )
}

describe('Regenerate avatar', () => {
  beforeEach(() => { regeneratePersonaAvatar.mockReset() })

  it('shows progress, then the new image from the answer', async () => {
    type Answer = { avatar_url: string | null }
    const answer = { resolve: (_value: Answer): void => undefined }
    regeneratePersonaAvatar.mockReturnValue(new Promise<Answer>((resolve) => { answer.resolve = resolve }))
    const user = userEvent.setup()
    renderDetail()

    await user.click(screen.getByRole('button', { name: 'Regenerate avatar' }))

    expect(regeneratePersonaAvatar).toHaveBeenCalledWith('proj_1', 'persona_1')
    expect(await screen.findByRole('status')).toHaveTextContent('Generating a new avatar…')
    expect(screen.getByRole('button', { name: 'Regenerate avatar' })).toBeDisabled()

    answer.resolve({ avatar_url: 'https://cdn.example/avatars/persona_1/new.jpeg?Signature=b' })

    expect(await screen.findByRole('img', { name: 'Ada' })).toHaveAttribute(
      'src', 'https://cdn.example/avatars/persona_1/new.jpeg?Signature=b')
  })

  it('reports a failure and keeps the current image', async () => {
    regeneratePersonaAvatar.mockRejectedValue(new Error('API Error: 500'))
    const user = userEvent.setup()
    renderDetail()

    await user.click(screen.getByRole('button', { name: 'Regenerate avatar' }))

    expect(await screen.findByRole('alert')).toHaveTextContent("The avatar couldn't be regenerated. Try again.")
    expect(screen.getByRole('img', { name: 'Ada' })).toHaveAttribute('src', persona.avatar_url)
  })

  it('is not offered to a viewer', () => {
    renderDetail(false)
    expect(screen.queryByRole('button', { name: 'Regenerate avatar' })).not.toBeInTheDocument()
  })
})
