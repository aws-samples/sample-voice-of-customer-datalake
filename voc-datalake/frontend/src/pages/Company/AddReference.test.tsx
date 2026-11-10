/**
 * @fileoverview /company → Design system → Add reference: an address the API would refuse is
 * explained beside the field (it used to only grey out the button), an address that is already a
 * reference is named with "Fetch again" on it (it used to be read a second time), and the archive
 * dialog says what is kept for each kind.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { designCalls, registerDesignSectionHooks, renderDesignSection } from '@test/designSectionHarness'
import { ApiError } from '../../lib/errors'
import type { RouteHandler } from '@test/fetchApiRoutes'
import { duplicateReference, normalizeReferenceUrl, referenceUrlProblem } from './referenceUrl'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))

const SITE = { id: 'ref_site', kind: 'website', title: 'Kiro Mail', url: 'https://www.kiromail.dev', status: 'ready' }
const SHOT = { id: 'ref_shot', kind: 'screenshot', title: 'Home screen', s3_key: 'k', status: 'ready' }
const DESIGN = {
  tokens: { colors: [], typography: [], spacing: [], radius: [] }, guidelines: '', references: [SITE, SHOT],
  integrations: { figma: false, github: false },
}

function renderSection(routes: Record<string, RouteHandler> = {}) {
  renderDesignSection({ 'GET /settings/design-system': () => DESIGN, ...routes })
}

const calls = designCalls
const urlField = () => screen.findByRole('textbox', { name: 'Link (https://…)' })

registerDesignSectionHooks()

describe('an address the API would refuse is explained in place', () => {
  it.each([
    ['not a url', 'This is not a web address. Paste the full link, starting with https://'],
    ['http://127.0.0.1/', 'Only https:// addresses can be read; http:// addresses are refused.'],
    ['ftp://example.com', 'Only https:// addresses can be read; ftp:// addresses are refused.'],
    ['FILE:///etc/passwd', 'Only https:// addresses can be read; file:// addresses are refused.'],
    ['https://user:pw@acme.example/', 'Remove the user name or password from the address.'],
    ['https://localhost/', 'Addresses on this computer cannot be read; use a public site.'],
  ])('%s says why while typing, and Add reference stays off', async (typed, message) => {
    renderSection()
    const field = await urlField()
    await userEvent.type(field, typed)
    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field).toHaveAccessibleDescription(message)
    expect(screen.getByRole('button', { name: 'Add reference' })).toBeDisabled()
  })

  it('a bare https:// says the host is missing once the field is left, not while it is being typed', async () => {
    renderSection()
    const field = await urlField()
    await userEvent.type(field, 'https://')
    expect(screen.queryByText(/needs a site name/)).not.toBeInTheDocument()
    await userEvent.tab()
    expect(await screen.findByText('The address needs a site name after https://, for example https://example.com')).toBeInTheDocument()
  })

  it('a valid address has no message', async () => {
    renderSection()
    const field = await urlField()
    await userEvent.type(field, 'https://acme.example/brand')
    await userEvent.tab()
    expect(field).toHaveAttribute('aria-invalid', 'false')
    expect(screen.getByRole('button', { name: 'Add reference' })).toBeEnabled()
  })
})

describe('an address that is already a reference', () => {
  it('names the reference and offers Fetch again on it instead of adding it twice', async () => {
    const refresh = vi.fn(() => ({ reference: { ...SITE, status: 'pending' } }))
    renderSection({ 'POST /settings/design-system/references/ref_site/refresh': refresh })
    await userEvent.type(await urlField(), 'HTTPS://WWW.kiromail.dev/#pricing')
    const message = await screen.findByText(/This address is already a reference: "Kiro Mail"/)
    expect(screen.getByRole('button', { name: 'Add reference' })).toBeDisabled()
    await userEvent.click(within(message).getByRole('button', { name: 'Fetch again' }))
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(calls('POST /settings/design-system/references')).toHaveLength(0)
  })

  it('shows the API 409 and reloads the list when another admin added it first', async () => {
    renderSection({ 'POST /settings/design-system/references': () => { throw new ApiError(409, 'This address is already a design reference: "Brand"') } })
    await userEvent.type(await urlField(), 'https://brand.example')
    await userEvent.click(screen.getByRole('button', { name: 'Add reference' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('already a design reference: "Brand"')
    await waitFor(() => expect(calls('GET /settings/design-system').length).toBeGreaterThan(1))
  })
})

describe('archiving says what is kept', () => {
  it.each([
    ['Kiro Mail', '"Kiro Mail" stops being used for new prototypes. The link and what was read from it are kept.'],
    ['Home screen', '"Home screen" stops being used for new prototypes. The file is kept.'],
  ])('%s', async (title, message) => {
    renderSection()
    await screen.findByText(title)
    const row = screen.getAllByRole('listitem').find((item) => within(item).queryByText(title) !== null)
    await userEvent.click(within(row ?? document.body).getByRole('button', { name: 'Archive' }))
    expect(within(await screen.findByRole('dialog')).getByText(message)).toBeInTheDocument()
  })
})

describe('referenceUrl mirrors the API', () => {
  it.each([
    ['https://www.kiromail.dev', 'https://www.kiromail.dev'], ['HTTPS://WWW.Kiromail.DEV/', 'https://www.kiromail.dev'],
    ['https://www.kiromail.dev:443/a/#x', 'https://www.kiromail.dev/a'], ['https://a.example/A?p=2', 'https://a.example/A?p=2'],
    ['https://a.example:8443/', 'https://a.example:8443'],
  ])('normalises %s', (raw, expected) => {
    expect(normalizeReferenceUrl(raw)).toBe(expected)
  })

  it('checks credentials and localhost only for a live website, like validate_url', () => {
    expect(referenceUrlProblem('https://localhost/', 'website')).toBe('localhost')
    expect(referenceUrlProblem('https://localhost/', 'github')).toBeNull()
    expect(referenceUrlProblem('https://'.padEnd(2049, 'a'), 'figma')).toBe('tooLong')
    expect(referenceUrlProblem('', 'website')).toBeNull()
  })

  it('ignores archived references', () => {
    const archived = { id: 'a', kind: 'website' as const, title: 'Old', url: 'https://www.kiromail.dev', status: 'archived' as const }
    expect(duplicateReference([archived], 'https://www.kiromail.dev')).toBeNull()
  })
})
