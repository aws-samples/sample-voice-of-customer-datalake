/**
 * What the Documents tab says about a prototype link, and what it does when the
 * link is re-signed.
 *
 * A prototype URL is a signed, session-scoped credential the app replaces before it
 * expires. Two regressions are cheap to introduce and invisible in review, so both
 * are pinned here:
 *
 * 1. Feeding the re-signed URL to the iframe. That reloads it, resetting a reviewer
 *    several screens into the prototype — hourly, silently. The frame must keep the
 *    URL it loaded with while the anchors take the fresh one.
 * 2. Saying nothing about the lifetime, which is what let users treat a
 *    session-scoped credential as a share link in the first place.
 *
 * Deliberately no fake timers: the expiry branch is chosen by putting `Expires`
 * either side of the real clock, so nothing here depends on timer control (which
 * has leaked across files in this suite — see useProjectData.test.ts).
 */
import { render, screen } from '@testing-library/react'
import { format } from 'date-fns'
import { MemoryRouter } from 'react-router-dom'
import DocumentsTab from './DocumentsTab'
import type { Project, ProjectDocument } from '../../api/types'

const project: Project = {
  project_id: 'proj-1',
  name: 'Test Project',
  description: '',
  status: 'active',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  persona_count: 0,
  document_count: 1,
}

const PROTOTYPE_PATH = 'https://d111.cloudfront.net/prototypes/proj-1/doc-1.html'
const HOUR_MS = 60 * 60_000

/** A signed URL for the same document, with a distinct signature each time. */
const signedUrl = (expiresAtMs: number, signature: string) =>
  `${PROTOTYPE_PATH}?Expires=${Math.floor(expiresAtMs / 1000)}&Signature=${signature}&Key-Pair-Id=K1`

const prototypeDoc = (prototypeUrl?: string): ProjectDocument => ({
  document_id: 'doc-1',
  title: 'My Prototype',
  // New S3-only prototypes carry no inline content — the HTML is behind the URL.
  content: '',
  document_type: 'prototype',
  prototype_format: 'html',
  prototype_url: prototypeUrl,
  created_at: new Date().toISOString(),
})

const proseDoc: ProjectDocument = {
  document_id: 'doc-2',
  title: 'A PRD',
  content: '# Heading',
  document_type: 'prd',
  created_at: new Date().toISOString(),
}

const baseProps = {
  project,
  onSelectDoc: vi.fn(),
  onEditDoc: vi.fn(),
  onDeleteDoc: vi.fn(),
  onCreateDoc: vi.fn(),
  isDeleting: false,
}

const renderTab = (selectedDoc: ProjectDocument) => render(
  <MemoryRouter>
    <DocumentsTab {...baseProps} documents={[selectedDoc]} selectedDoc={selectedDoc} />
  </MemoryRouter>,
)

const frameSrc = () => screen.getByTitle('My Prototype').getAttribute('src')
const linkHref = (name: RegExp) => screen.getByRole('link', { name }).getAttribute('href')

describe('prototype link lifetime', () => {
  it('states when the current link stops working', () => {
    const expiresAt = Date.now() + HOUR_MS
    renderTab(prototypeDoc(signedUrl(expiresAt, 'sig-1')))
    // Computed the same way the component does, so the assertion holds in any
    // timezone rather than only the one the suite happens to run in.
    const expected = format(new Date(Math.floor(expiresAt / 1000) * 1000), 'HH:mm')
    expect(screen.getByText(`Link valid until ${expected}`)).toBeInTheDocument()
  })

  it('says the link is tied to the session rather than presenting it as a share link', () => {
    renderTab(prototypeDoc(signedUrl(Date.now() + HOUR_MS, 'sig-1')))
    expect(screen.getByTitle(/tied to your session/i)).toBeInTheDocument()
  })

  it('reports a lapsed link instead of promising a window it cannot honour', () => {
    renderTab(prototypeDoc(signedUrl(Date.now() - HOUR_MS, 'sig-old')))
    expect(screen.getByText(/Link expired/)).toBeInTheDocument()
    expect(screen.queryByText(/Link valid until/)).not.toBeInTheDocument()
  })

  it('claims no lifetime for a legacy prototype, which has no signature to expire', () => {
    renderTab({ ...prototypeDoc(undefined), content: '<html><body>legacy</body></html>' })
    expect(screen.queryByText(/Link valid until/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Link expired/)).not.toBeInTheDocument()
  })
})

describe('re-signing the same prototype', () => {
  it('does not change the iframe src, so an open prototype is not reloaded underneath the reviewer', () => {
    const first = signedUrl(Date.now() + HOUR_MS, 'sig-1')
    const { rerender } = renderTab(prototypeDoc(first))
    expect(frameSrc()).toBe(first)

    // What the pre-expiry refresh produces: same document, new credential.
    const resigned = signedUrl(Date.now() + 2 * HOUR_MS, 'sig-2')
    const doc = prototypeDoc(resigned)
    rerender(
      <MemoryRouter>
        <DocumentsTab {...baseProps} documents={[doc]} selectedDoc={doc} />
      </MemoryRouter>,
    )

    expect(frameSrc()).toBe(first)
  })

  it('gives the fresh credential to the anchors, which each start a new request', () => {
    const first = signedUrl(Date.now() + HOUR_MS, 'sig-1')
    const { rerender } = renderTab(prototypeDoc(first))

    const resigned = signedUrl(Date.now() + 2 * HOUR_MS, 'sig-2')
    const doc = prototypeDoc(resigned)
    rerender(
      <MemoryRouter>
        <DocumentsTab {...baseProps} documents={[doc]} selectedDoc={doc} />
      </MemoryRouter>,
    )

    expect(linkHref(/Open in new tab/i)).toBe(resigned)
    expect(linkHref(/Download \.html/i)).toBe(resigned)
  })

  it('still loads a genuinely different document, which is a different address', () => {
    const { rerender } = renderTab(prototypeDoc(signedUrl(Date.now() + HOUR_MS, 'sig-1')))

    const otherUrl = 'https://d111.cloudfront.net/prototypes/proj-1/doc-9.html?Expires=99999999999&Signature=s&Key-Pair-Id=K1'
    const other: ProjectDocument = {
      ...prototypeDoc(otherUrl), document_id: 'doc-9', title: 'My Prototype',
    }
    rerender(
      <MemoryRouter>
        <DocumentsTab {...baseProps} documents={[other]} selectedDoc={other} />
      </MemoryRouter>,
    )

    expect(frameSrc()).toBe(otherUrl)
  })
})

describe('document pane height', () => {
  /**
   * U7's remaining acceptance criterion. The pane was a flat `lg:min-h-[500px]`, so a
   * whole generated application previewed in ~430px whether the monitor was 900px or
   * 1440px tall.
   */
  it('gives a prototype the viewport rather than a fixed 500px', () => {
    const { container } = renderTab(prototypeDoc(signedUrl(Date.now() + HOUR_MS, 'sig-1')))
    const pane = container.querySelector('.lg\\:col-span-2')
    expect(pane).toHaveClass('lg:min-h-[70vh]')
  })

  it('leaves prose documents on the shorter pane, where extra height is only whitespace', () => {
    const { container } = renderTab(proseDoc)
    const pane = container.querySelector('.lg\\:col-span-2')
    expect(pane).toHaveClass('lg:min-h-[500px]')
    expect(pane).not.toHaveClass('lg:min-h-[70vh]')
  })
})
