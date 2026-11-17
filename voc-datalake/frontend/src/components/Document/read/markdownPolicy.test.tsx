/**
 * The safe-Markdown policy against an XSS corpus, through every policy of the light reader and through the canvas
 * (read only): no element carries an unsafe href or src, no event attribute survives, and raw HTML is never an
 * element (it shows as its inert source, or not at all).
 */
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { headlessEditor } from '../edit/editor/headless-editor-fixtures'
import MarkdownRead from './MarkdownRead'
import { markdownPolicy } from './markdownPolicy'

const CORPUS = [
  '[js](javascript:alert(1))',
  '[tab](java\tscript:alert(1))',
  '[entity](jav&#x09;ascript:alert(1))',
  '[upper](JAVASCRIPT:alert(1))',
  '[vb](vbscript:msgbox(1))',
  '[data](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '[protocol-relative](//evil.example/x)',
  '[backslash](/\\evil.example)',
  '![pixel](data:image/png;base64,iVBORw0KGgo=)',
  '![script](javascript:alert(1))',
  '<img src=x onerror="alert(1)">',
  '<script>alert(1)</script>',
  '<iframe src="https://evil.example"></iframe>',
  '<a href="javascript:alert(1)" onclick="alert(1)">raw link</a>',
  '<div onmouseover="alert(1)">hover</div>',
  '<javascript:alert(1)>',
  '<https://safe.example/autolink>',
  'www.safe.example/literal',
].join('\n\n')

const UNSAFE_URL = /^\s*(?:javascript|vbscript|data):|^\s*\/\/|^\s*\/\\/iu

/** Every way the corpus could have become live: a raw element, an event attribute, an unsafe href or src. */
function liveVectors(root: HTMLElement): string[] {
  const elements = [...root.querySelectorAll('*')]
  return [
    ...elements.filter((element) => ['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED'].includes(element.tagName)).map((element) => element.tagName),
    ...elements.flatMap((element) => [...element.attributes].filter((attribute) => /^on/iu.test(attribute.name))
      .map((attribute) => `${element.tagName}[${attribute.name}]`)),
    ...elements.flatMap((element) => ['href', 'src'].flatMap((name) => {
      const value = element.getAttribute(name)
      return value !== null && UNSAFE_URL.test(value.replace(/[\s\p{Cc}]/gu, '')) ? [`${element.tagName}[${name}=${value}]`] : []
    })),
  ]
}

function read(policy: keyof typeof markdownPolicy): HTMLElement {
  const { container } = render(<MemoryRouter><MarkdownRead source={CORPUS} policy={markdownPolicy[policy]} /></MemoryRouter>)
  return container
}

describe('the safe-Markdown policy', () => {
  it.each(['stored', 'model'] as const)('renders nothing live from the corpus (%s)', (policy) => {
    expect(liveVectors(read(policy))).toStrictEqual([])
  })

  it('renders nothing live from the corpus on the canvas either', () => {
    expect(liveVectors(headlessEditor(CORPUS).view.dom)).toStrictEqual([])
  })

  it.each(['stored', 'model'] as const)('shows raw HTML as its source, never as an element (%s)', (policy) => {
    const container = read(policy)

    expect(container.querySelector('img[onerror], div[onmouseover], a[onclick]')).toBeNull()
    expect([...container.querySelectorAll('.canvas-raw, .canvas-raw-inline')].map((node) => node.textContent))
      .toContain('<script>alert(1)</script>')
  })

  it('keeps the safe links of stored text working, external ones in a new tab without opener', () => {
    const container = read('stored')
    const external = [...container.querySelectorAll('a')].find((anchor) => anchor.textContent.includes('safe.example/autolink'))

    expect(external?.getAttribute('href')).toBe('https://safe.example/autolink')
    expect(external?.getAttribute('rel')).toBe('noopener noreferrer nofollow')
  })

  it('fetches no image from model text, and none from a data: address in stored text', () => {
    const model = read('model')
    const stored = read('stored')

    expect(model.querySelector('img')).toBeNull()
    expect(stored.querySelector('img')).toBeNull()
    expect(stored).toHaveTextContent('pixel')
  })
})
