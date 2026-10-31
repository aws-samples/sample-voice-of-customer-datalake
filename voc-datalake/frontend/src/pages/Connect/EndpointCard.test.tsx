/**
 * EndpointCard's skill download (docs/mcp.md): the static skill is fetched,
 * the endpoint filled in and saved as a file, and its object URL revoked once
 * the link was clicked; a failed fetch says so.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EndpointCard } from './EndpointCard'
import { ENDPOINT_PLACEHOLDER, SKILL_FILE_NAME, SKILL_PATH } from './connectSnippets'

const ENDPOINT = 'https://api.example.com/v1/mcp/global'
const fetchMock = vi.fn<(input: string) => Promise<Response>>()

/** jsdom's Blob has no text(); FileReader reads it. */
function blobText(blob: Blob | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!blob) { reject(new Error('no blob saved')); return }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('not read as text'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsText(blob)
  })
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('EndpointCard skill download', () => {
  it('saves the skill with this deployment\u2019s endpoint filled in', async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValue(new Response(`Endpoint: ${ENDPOINT_PLACEHOLDER}`, { status: 200 }))
    const saved: { download: string; blobs: Blob[] } = { download: '', blobs: [] }
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      if (blob instanceof Blob) saved.blobs.push(blob)
      return 'blob:skill'
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function record(this: HTMLAnchorElement) {
      saved.download = this.download
    })
    render(<EndpointCard endpointUrl={ENDPOINT} />)

    await user.click(screen.getByRole('button', { name: 'Download skill' }))

    await waitFor(() => expect(saved.download).toBe(SKILL_FILE_NAME))
    expect(fetchMock).toHaveBeenCalledWith(SKILL_PATH)
    expect(await blobText(saved.blobs[0])).toBe(`Endpoint: ${ENDPOINT}`)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('revokes the object URL once the link was clicked', async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValue(new Response(`Endpoint: ${ENDPOINT_PLACEHOLDER}`, { status: 200 }))
    const events: string[] = []
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:skill')
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function record(this: HTMLAnchorElement) {
      events.push(`click ${this.href}`)
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => { events.push(`revoke ${url}`) })
    render(<EndpointCard endpointUrl={ENDPOINT} />)

    await user.click(screen.getByRole('button', { name: 'Download skill' }))

    await waitFor(() => expect(events).toStrictEqual(['click blob:skill', 'revoke blob:skill']))
  })

  it('says the download failed when the skill cannot be fetched', async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValue(new Response('', { status: 404 }))
    render(<EndpointCard endpointUrl={ENDPOINT} />)

    await user.click(screen.getByRole('button', { name: 'Download skill' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not download the skill. Try again.')
  })
})
