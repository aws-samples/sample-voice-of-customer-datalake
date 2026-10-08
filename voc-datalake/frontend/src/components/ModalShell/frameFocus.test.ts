/**
 * Direct unit tests for ModalShell's cross-document focus arithmetic (#385).
 *
 * Each case here was a regression in #384 that was only reachable through a rendered
 * dialog, a written frame body and a dispatched keydown. As arithmetic over real jsdom
 * documents it is one call and one assertion. `ModalShell.test.tsx` keeps the wiring.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { asFrame, tabOutOfFrame, tabWouldLeave } from './frameFocus'
import { required } from '../component-spec-fixtures'

/**
 * A src-less frame appended to `host`'s body, its document filled with `html`.
 * jsdom gives such a frame a loaded about:blank document of its OWN realm, which is
 * the property two of the cases below depend on.
 */
function mountFrame(host: Document, html: string): { readonly frame: HTMLIFrameElement; readonly doc: Document } {
  const frame = host.createElement('iframe')
  host.body.append(frame)
  const doc = required(frame.contentDocument, 'a document in the mounted frame')
  required(doc.body, 'a body in the mounted frame').innerHTML = html
  return { frame, doc }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('tabWouldLeave', () => {
  it('reads a document whose candidates all exist but are hidden as leaving', () => {
    // #384's last regression: with focus on `<body>` (not a candidate), asking the RAW
    // candidate count answered "there is somewhere to go" for a prototype whose only
    // controls sit in a `display:none` screen, so the shell declined to intervene and
    // the browser moved focus out of the dialog. Fails if the branch reverts to
    // `candidates.length === 0`.
    const { doc } = mountFrame(document, '<div style="display:none"><button>one</button><button>two</button></div>')

    expect(doc.activeElement).toBe(doc.body)
    expect(tabWouldLeave(doc, false)).toBe(true)
  })
})

describe('asFrame', () => {
  it('resolves a frame element that belongs to another realm', () => {
    // A frame created inside a frame belongs to THAT frame's realm, whose
    // `HTMLIFrameElement` is a different constructor from this page's. A plain
    // `instanceof HTMLIFrameElement` answers false for it, so the entry guard treated
    // the nested frame as an ordinary element and cancelled the descent. Fails if
    // `asFrame` reverts to the page's constructor.
    const { doc } = mountFrame(document, '')
    const nested = doc.createElement('iframe')

    expect(nested instanceof HTMLIFrameElement).toBe(false)
    expect(asFrame(nested)).toBe(nested)
  })
})

describe('tabOutOfFrame', () => {
  it('resumes after a nested frame in that frame\'s own document, not in the panel', () => {
    // Resolving the exit against the PANEL's items collapsed every depth to the panel's
    // order, so a Tab leaving a frame nested in the prototype skipped whatever followed
    // it inside the prototype. Fails if the walk resolves against `items` regardless of
    // which document owns the frame.
    const panelButton = document.createElement('button')
    document.body.append(panelButton)
    const { doc } = mountFrame(document, '<button>before</button>')
    const { frame: nested } = mountFrame(doc, '')
    const after = doc.createElement('button')
    doc.body.append(after)

    expect(tabOutOfFrame(nested, [panelButton], false)).toBe(after)
  })
})
