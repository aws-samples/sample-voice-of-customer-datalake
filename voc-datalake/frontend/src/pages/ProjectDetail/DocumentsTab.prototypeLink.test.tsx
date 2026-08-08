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
import { render, screen, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import DocumentsTab from './DocumentsTab'
import { formatExpiry } from '../../components/prototypeLinkLifetime'
import type { Project, ProjectDocument } from '../../api/types'

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

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
    // Formatted the same way the component does, so the assertion holds in any timezone
    // and under any locale rather than only the one the suite happens to run in.
    const expected = formatExpiry(Math.floor(expiresAt / 1000) * 1000, Date.now(), 'en')
    expect(screen.getByText(new RegExp(`Link valid until ${escapeRegExp(expected)}`))).toBeInTheDocument()
  })

  /**
   * This warning is the entire point of the label, so it must not be hover-only. A
   * `title` is invisible on touch and announced inconsistently by screen readers.
   */
  it('says the link is session-scoped in VISIBLE text, not a tooltip', () => {
    renderTab(prototypeDoc(signedUrl(Date.now() + HOUR_MS, 'sig-1')))
    expect(screen.getByText(/tied to your session, not a share link/i)).toBeInTheDocument()
    expect(screen.queryByTitle(/tied to your session/i)).not.toBeInTheDocument()
  })

  it('points both link actions at that warning for assistive technology', () => {
    renderTab(prototypeDoc(signedUrl(Date.now() + HOUR_MS, 'sig-1')))
    const noteId = screen.getByText(/tied to your session/i).closest('span[id]')?.getAttribute('id')
    expect(noteId).toBeTruthy()
    expect(screen.getByRole('link', { name: /Open in new tab/i })).toHaveAttribute('aria-describedby', noteId)
    expect(screen.getByRole('link', { name: /Download \.html/i })).toHaveAttribute('aria-describedby', noteId)
  })

  it('does not dangle aria-describedby when there is no readable deadline', () => {
    // An unsigned URL renders no note, so the anchors must not reference a missing id.
    const doc = prototypeDoc('https://d111.cloudfront.net/prototypes/proj-1/doc-1.html')
    renderTab(doc)
    expect(screen.getByRole('link', { name: /Open in new tab/i })).not.toHaveAttribute('aria-describedby')
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

  /**
   * The regression that the first attempt at the fix above introduced: releasing on the
   * loaded URL's DEADLINE rather than on whether it ever worked. A frame that loaded
   * fine at t+0 would swap at t+60m to the replacement delivered at t+55m, reloading the
   * prototype under the reviewer once an hour — the exact behaviour the freeze exists to
   * prevent, five minutes late.
   *
   * Needs timers, because the distinguishing event is a deadline passing on a frame that
   * is working. They are scoped to this test and torn down straight after.
   */
  it('keeps a URL that loaded successfully even after its signature expires', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const live = signedUrl(Date.now() + HOUR_MS, 'sig-live')
      const { rerender } = renderTab(prototypeDoc(live))
      expect(frameSrc()).toBe(live)

      // The pre-expiry refresh lands: same document, later deadline. Frame keeps `live`.
      const resigned = signedUrl(Date.now() + 2 * HOUR_MS, 'sig-next')
      const doc = prototypeDoc(resigned)
      const render2 = () => rerender(
        <MemoryRouter>
          <DocumentsTab {...baseProps} documents={[doc]} selectedDoc={doc} />
        </MemoryRouter>,
      )
      render2()
      expect(frameSrc()).toBe(live)

      // Now push past `live`'s own deadline. The document is already in the browser, so
      // its signature is irrelevant and the frame must not move.
      act(() => {
        vi.advanceTimersByTime(HOUR_MS + 60_000)
      })
      render2()

      expect(frameSrc()).toBe(live)
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * The freeze is a courtesy to a WORKING document, and must not outlive one. Mounting
   * against an expired URL — stale cached project data, a machine resumed from suspend,
   * a refetch that failed once — loads a dead signature and renders CloudFront's 403.
   * If the frame then ignored the replacement, the pane would stay broken until
   * something remounted it, and the Prioritization page would inherit that too.
   */
  it('lets go of an expired URL as soon as a live replacement arrives', () => {
    const dead = signedUrl(Date.now() - HOUR_MS, 'sig-dead')
    const { rerender } = renderTab(prototypeDoc(dead))
    expect(frameSrc()).toBe(dead)

    const fresh = signedUrl(Date.now() + HOUR_MS, 'sig-fresh')
    const doc = prototypeDoc(fresh)
    rerender(
      <MemoryRouter>
        <DocumentsTab {...baseProps} documents={[doc]} selectedDoc={doc} />
      </MemoryRouter>,
    )

    expect(frameSrc()).toBe(fresh)
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
    renderTab(prototypeDoc(signedUrl(Date.now() + HOUR_MS, 'sig-1')))
    expect(screen.getByTestId('document-detail-pane')).toHaveClass('lg:min-h-[70vh]')
  })

  it('leaves prose documents on the shorter pane, where extra height is only whitespace', () => {
    renderTab(proseDoc)
    const pane = screen.getByTestId('document-detail-pane')
    expect(pane).toHaveClass('lg:min-h-[500px]')
    expect(pane).not.toHaveClass('lg:min-h-[70vh]')
  })
})
