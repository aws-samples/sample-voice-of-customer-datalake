/**
 * **Talk** on a persona (7.69.00): offered for a project's persona to an editor on a deployment with `features.voice`
 * only (never in the company library, never to a viewer, never with the flag off); it opens the consent, and once the
 * person starts, the live session in its place.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { fakeAudio, stubWebSocket } from '@test/voiceDoubles'
import { COMPANY_PERSONA_SCOPE, projectPersonaScope } from '../personaScope'
import type { PersonaScope } from '../personaScope'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../../store/authStore', (importOriginal) =>
  import('@test/fetchApiRoutes').then((m) => m.authStoreWithOriginal(importOriginal)))
const voice = { available: true }
vi.mock('../../../runtimeConfig', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../runtimeConfig')>(),
  isVoiceAvailable: () => voice.available,
}))
vi.mock('./voiceAudio', () => ({ openVoiceAudio: () => Promise.resolve(fakeAudio()) }))

const { default: PersonaDetailView } = await import('../PersonaDetailView')

const PATH = '/projects/proj_1/personas/persona_1/voice-sessions'
const OFFER = {
  enabled: true, voice_id: 'matthew', voice_gender: 'masculine', languages: { supported: ['en'], unsupported: [] },
  session_minutes: 15, minutes_left: 200, sessions_left_today: 5, estimated_cents_per_minute: 2,
}

function renderDetail({ scope = projectPersonaScope('proj_1'), canEdit = true }: { scope?: PersonaScope; canEdit?: boolean } = {}) {
  renderWithQueryClient(
    <MemoryRouter>
      <PersonaDetailView scope={scope} persona={{ persona_id: 'persona_1', name: 'Dana', tagline: '', created_at: '' }} canEdit={canEdit}
        onEdit={vi.fn()} onDelete={vi.fn()} onSaveNotes={vi.fn()} isDeleting={false} isSavingNotes={false} />
    </MemoryRouter>,
  )
}

const talk = () => screen.queryByRole('button', { name: 'Talk to Dana by voice' })

beforeEach(() => {
  resetFetchApi()
  stubWebSocket()
  voice.available = true
  routeFetchApi({ [`GET ${PATH}`]: () => OFFER, [`POST ${PATH}`]: () => ({ ...OFFER, session_id: 's1', connect_url: 'wss://x.example/ws', expires_in: 60 }) })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Talk on a persona', () => {
  it.each([
    ['in the company library', { scope: COMPANY_PERSONA_SCOPE }],
    ['to a viewer', { canEdit: false }],
  ])('is not offered %s', (_label, options) => {
    renderDetail(options)
    expect(talk()).not.toBeInTheDocument()
  })

  it('is not offered when the deployment has no voice', () => {
    voice.available = false
    renderDetail()
    expect(talk()).not.toBeInTheDocument()
  })

  it('opens the consent, then the live session once started, and Cancel goes back', async () => {
    const user = userEvent.setup()
    renderDetail()
    await user.click(talk() ?? document.body)
    expect(await screen.findByRole('heading', { name: 'Talk to Dana' })).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Start talking' }))
    expect(await screen.findByRole('heading', { name: 'Talking with Dana' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Talk to Dana' })).not.toBeInTheDocument()
  })

  it('closes the consent on Cancel', async () => {
    const user = userEvent.setup()
    renderDetail()
    await user.click(talk() ?? document.body)
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
