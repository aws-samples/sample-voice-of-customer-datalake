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

function required<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector)
  if (found === null) throw new Error(`missing fixture element: ${selector}`)
  return found
}

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
    const realmHost = document.createElement('iframe')
    document.body.append(realmHost)
    try {
      const foreignWindow = realmHost.contentWindow
      if (foreignWindow === null) throw new Error('jsdom did not provide an iframe realm')
      const frame = foreignWindow.document.createElement('iframe')

      expect(asFrame(frame)).toBe(frame)
    } finally {
      realmHost.remove()
    }
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
    const nestedFrame = required<HTMLIFrameElement>(nestedDocument, 'iframe')

    expect(tabOutOfFrame(nestedFrame, panelDocument, panelItems, false)).toBe(
      required(nestedDocument, 'button'),
    )
  })

  it('wraps a panel-document frame through the supplied panel order', () => {
    // Reverting to the page-global `document` makes this isolated panel look
    // like an intermediate document. The extra body control is deliberately
    // absent from the caller's item order, so the two branches must disagree:
    // the panel branch wraps to `first`, while the intermediate branch would
    // step through the iframe in raw DOM order to `outside items`.
    const panelDocument = document.implementation.createHTMLDocument('isolated panel')
    panelDocument.body.innerHTML =
      '<button id="first">first</button>' +
      '<iframe title="panel frame"></iframe>' +
      '<button id="outside-items">outside items</button>'
    const items = [
      required<HTMLIFrameElement>(panelDocument, 'iframe'),
      required(panelDocument, '#first'),
    ]

    expect(tabOutOfFrame(required(panelDocument, 'iframe'), panelDocument, items, false)).toBe(
      required(panelDocument, '#first'),
    )
  })

  it('stays fail-closed when the panel has no focusable items', () => {
    const panelDocument = document.implementation.createHTMLDocument('empty panel')
    panelDocument.body.innerHTML = '<iframe title="panel frame"></iframe>'

    expect(tabOutOfFrame(required(panelDocument, 'iframe'), panelDocument, [], false)).toBeNull()
  })
})
