/**
 * A proposal's examples edited as a list (SkillProposeSheet.tsx): none yet said so, one added empty, each half typed
 * into its own example, one removed by its number, and Add refused (still focusable, its reason beside it) at the
 * twenty a skill may have.
 */
import { describe, expect, it } from 'vitest'
import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { at } from '@test/defined'
import { SkillExamplesField } from './SkillExamplesField'
import type { EditedExample } from './SkillExamplesField'

/** The field over its own list, the list shown as JSON to read what it holds. */
function Harness({ initial }: Readonly<{ initial: readonly EditedExample[] }>) {
  const [examples, setExamples] = useState(initial)
  const [next, setNext] = useState(initial.length + 1)
  const nextKey = () => { setNext(next + 1); return next }
  return (
    <>
      <SkillExamplesField examples={examples} onChange={setExamples} nextKey={nextKey} />
      <output aria-label="Examples held">{JSON.stringify(examples.map(({ situation, action }) => [situation, action]))}</output>
    </>
  )
}

const held = () => screen.getByRole('status', { name: 'Examples held' })

describe('SkillExamplesField', () => {
  it('adds an example, types its two halves, and removes another by its number', async () => {
    const user = userEvent.setup()
    render(<Harness initial={[{ key: 1, situation: 'A flaky test', action: 'Quarantine it' }]} />)
    await user.click(screen.getByRole('button', { name: 'Add an example' }))
    await user.type(at(screen.getAllByLabelText('When'), 1), 'A red build')
    await user.type(at(screen.getAllByLabelText('Do'), 1), 'Read the log first')
    await user.click(screen.getByRole('button', { name: 'Remove example 1' }))
    expect(held()).toHaveTextContent('[["A red build","Read the log first"]]')
  })

  it('says when there are none', () => {
    render(<Harness initial={[]} />)
    expect(screen.getByText('No examples.')).toBeInTheDocument()
  })

  it('adds none past the twenty a skill may have, saying why', async () => {
    const full = Array.from({ length: 20 }, (_each, at) => ({ key: at + 1, situation: `When ${at}`, action: `Do ${at}` }))
    render(<Harness initial={full} />)
    const add = screen.getByRole('button', { name: 'Add an example' })
    await userEvent.click(add)
    expect(add).toHaveAccessibleDescription('A skill has at most 20 examples.')
    expect(screen.getAllByLabelText('When')).toHaveLength(20)
  })
})
