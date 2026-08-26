/**
 * Direct coverage for the cross-document focus regressions from #384.
 *
 * Each assertion pins arithmetic that was previously reached only through a
 * rendered dialog and a synthetic keydown. A revert of the guarded behaviour
 * makes its matching test fail without needing to reproduce all of the shell
 * wiring here.
 */
import { describe, expect, it } from 'vitest'
import {
  asFrame,
  tabOutOfFrame,
  tabWouldLeave,
} from './frameFocus'

describe('frameFocus', () => {
  it('reads a document whose visible candidates are all hidden as leaving', () => {
    // Reverting to `candidates.length === 0` sees two raw controls and answers
    // false, allowing Tab to escape even though neither control is reachable.
    const doc = document.implementation.createHTMLDocument('hidden candidates')
    doc.body.innerHTML = [
      '<div style="display: none">',
      '<button>hidden first</button>',
      '<button>hidden last</button>',
      '</div>',
    ].join('')

    expect(tabWouldLeave(doc, false)).toBe(true)
  })

  it('resolves a frame constructed in another realm', () => {
    // Reverting to a page-global `instanceof HTMLIFrameElement` compares against
    // the wrong constructor and silently reports this frame as a non-frame.
    class ForeignFrame {}
    const frame = Object.defineProperties(
      new ForeignFrame() as unknown as HTMLIFrameElement,
      {
        ownerDocument: {
          value: {
            defaultView: { HTMLIFrameElement: ForeignFrame },
          },
        },
      },
    )

    expect(asFrame(frame)).toBe(frame)
  })

  it('resumes in the frame\'s own document instead of the panel\'s order', () => {
    // Treating the nested frame as a single panel stop wraps to `panel last`;
    // walking outward from its own document must find `nested next` first.
    const panelDocument = document.implementation.createHTMLDocument('panel')
    panelDocument.body.innerHTML = '<button>panel first</button><button>panel last</button>'

    const nestedDocument = panelDocument.implementation.createHTMLDocument('nested')
    nestedDocument.body.innerHTML = [
      '<iframe title="nested"></iframe>',
      '<button>nested next</button>',
    ].join('')

    const panelItems = [...panelDocument.body.querySelectorAll<HTMLElement>('button')]
    const nestedFrame = nestedDocument.querySelector<HTMLIFrameElement>('iframe')!

    expect(tabOutOfFrame(nestedFrame, panelItems, false)).toBe(
      nestedDocument.querySelector('button'),
    )
  })
})
