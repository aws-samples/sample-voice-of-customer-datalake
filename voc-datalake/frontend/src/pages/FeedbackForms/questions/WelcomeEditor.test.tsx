/**
 * The welcome card's editor (UX §4.5): Show a welcome screen turns it on; then its title (required: a problem until
 * written), description and button label (its placeholder the widget's own "Start"), all written into the draft in the
 * form's language; the title takes the focus when the card was just asked for.
 */
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithDraft, sampleForm } from '../test/draftHarness'
import { requestFocus } from './focusRequest'
import WelcomeEditor from './WelcomeEditor'

const shown = (title = '') => sampleForm({ welcome: { enabled: true, title: title === '' ? {} : { en: title } } })

describe('WelcomeEditor', () => {
  it('turns the welcome screen on, and only then offers its texts', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<WelcomeEditor />)
    expect(screen.getByRole('heading', { name: 'Welcome screen' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /Title/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('switch', { name: /Show a welcome screen/ }))
    expect([harness.probe.current?.form.welcome.enabled, screen.getByRole('textbox', { name: /Title/ })]).toStrictEqual([true, expect.anything()])
  })

  it('writes the title, description and button label in the form\'s language', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<WelcomeEditor />, shown())
    await user.type(screen.getByRole('textbox', { name: /Title/ }), 'Hello')
    await user.type(screen.getByRole('textbox', { name: 'Description' }), 'Two minutes')
    await user.type(screen.getByRole('textbox', { name: 'Button label' }), 'Go')
    expect(harness.probe.current?.form.welcome).toMatchObject({
      enabled: true, title: { en: 'Hello' }, description: { en: 'Two minutes' }, button_label: { en: 'Go' },
    })
  })

  it('shows the widget\'s own Start as the button\'s placeholder', () => {
    renderWithDraft(<WelcomeEditor />, shown('Hello'))
    expect(screen.getByRole('textbox', { name: 'Button label' })).toHaveAttribute('placeholder', 'Start')
  })

  it('focuses the title when the welcome card was just asked for', () => {
    requestFocus('welcome')
    renderWithDraft(<WelcomeEditor />, shown('Hello'))
    expect(screen.getByRole('textbox', { name: /Title/ })).toHaveFocus()
  })
})
