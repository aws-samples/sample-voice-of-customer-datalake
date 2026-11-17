/**
 * The code view: the text exactly as stored in a named, focusable region; decorative line numbers; Wrap lines; Copy
 * writes the text itself. Properties: a flat front-matter as a list, any other as its YAML. SourceEditor: the count
 * against the limit and the prompt note.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import CodeView from './CodeView'
import PropertiesPanel from './PropertiesPanel'
import SourceEditor from './SourceEditor'

describe('CodeView', () => {
  it('shows the text in a named, focusable region, its numbers hidden from screen readers', () => {
    render(<CodeView text={'name: fixer\nrole: x\n'} label="Source of SKILL.md" />)
    const region = screen.getByRole('region', { name: 'Source of SKILL.md' })

    expect(region).toHaveAttribute('tabindex', '0')
    expect([...region.querySelectorAll('.code-view__text')].map((line) => line.textContent)).toStrictEqual(['name: fixer', 'role: x'])
    expect([...region.querySelectorAll('[aria-hidden="true"]')].map((number) => number.textContent)).toStrictEqual(['1', '2'])
    expect(screen.getByText('Lines: 2')).toBeInTheDocument()
  })

  it('wraps lines by default and lets the reader turn it off', async () => {
    const user = userEvent.setup()
    const { container } = render(<CodeView text="a very long line" label="Source" />)
    const wrap = screen.getByRole('button', { name: 'Wrap lines' })

    expect(wrap).toHaveAttribute('aria-pressed', 'true')
    await user.click(wrap)
    expect(wrap).toHaveAttribute('aria-pressed', 'false')
    expect(container.querySelector('.code-view')).not.toHaveAttribute('data-wrap')
  })

  it('copies the text itself, and says so', async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    render(<CodeView text={'one\ntwo'} label="Source" />)

    await user.click(screen.getByRole('button', { name: 'Copy' }))

    expect(writeText).toHaveBeenCalledWith('one\ntwo')
    expect(await screen.findByRole('status')).toHaveTextContent('Copied')
  })
})

describe('PropertiesPanel', () => {
  it('lists a flat front-matter as names and values', () => {
    render(<PropertiesPanel frontMatter={'---\nname: fixer\ndescription: Fixes one bug.\n---\n'} />)
    const panel = screen.getByRole('region', { name: 'Properties' })

    expect([...panel.querySelectorAll('dt, dd')].map((cell) => cell.textContent)).toStrictEqual(['name', 'fixer', 'description', 'Fixes one bug.'])
  })

  it('shows any other front-matter as its YAML, read only', () => {
    render(<PropertiesPanel frontMatter={'---\nmetadata:\n  role: fixer\n---\n'} />)
    const panel = screen.getByRole('region', { name: 'Properties' })

    const yaml = within(panel).getByRole('region', { name: 'Source of Properties' })

    expect([...yaml.querySelectorAll('.code-view__text')].map((line) => line.textContent)).toStrictEqual(['metadata:', '  role: fixer'])
    expect(panel.querySelector('dl')).toBeNull()
  })
})

describe('SourceEditor', () => {
  function Prompt({ initial }: Readonly<{ initial: string }>) {
    const [value, setValue] = useState(initial)
    return <SourceEditor value={value} onChange={setValue} label="Instructions" limits={{ maxChars: 10 }} prompt />
  }

  it('counts against the limit and says a prompt goes to the model as written', async () => {
    const user = userEvent.setup()
    render(<Prompt initial="Hello" />)
    const field = screen.getByRole('textbox', { name: 'Instructions' })

    expect(field).toHaveAccessibleDescription('Characters: 5 of 10 Sent to the model as written.')
    await user.type(field, ' world')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Characters: 11 of 10')).toHaveClass('text-danger')
  })
})
