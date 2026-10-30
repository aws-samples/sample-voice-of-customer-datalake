/**
 * The header's context chip: a readable page name for every route the assistant
 * sees, and the generic "This page" (never a raw `pages.*` key) when a label is
 * missing from the catalogue.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { screen } from '@testing-library/react'
import i18n from 'i18next'
import { render } from '@test/test-utils'
import assistantEn from '../../../public/locales/en/assistant.json'
import { pageContextFromLocation } from '../page/pageContext'
import PanelHeader from './PanelHeader'

const noop = () => {}

function renderHeaderAt(pathname: string) {
  render(
    <PanelHeader
      titleId="panel-title"
      page={pageContextFromLocation({ pathname, search: '' })}
      variant="page"
      mode="bubble"
      hasSidebar={false}
      canExport={false}
      onNewChat={noop}
      onToggleSessions={noop}
      onExport={noop}
      onMode={noop}
      onClose={noop}
    />,
  )
}

describe('PanelHeader context chip', () => {
  afterEach(() => {
    i18n.addResourceBundle('en', 'assistant', assistantEn, true, true)
  })

  it.each([
    ['/agents', 'Using: Autonomous agents'],
    ['/agents/ag_1', 'Using: Agent'],
    ['/memory', 'Using: Memory'],
    ['/connect', 'Using: Connect'],
    ['/admin', 'Using: Administration'],
  ])('names %s', (pathname, chip) => {
    renderHeaderAt(pathname)
    expect(screen.getByText(chip)).toBeInTheDocument()
  })

  it('falls back to "This page" when a label is missing, never the raw key', () => {
    const pages = Object.fromEntries(Object.entries(assistantEn.pages).filter(([key]) => key !== 'memory'))
    i18n.removeResourceBundle('en', 'assistant')
    i18n.addResourceBundle('en', 'assistant', { ...assistantEn, pages })
    renderHeaderAt('/memory')
    expect(screen.getByText('Using: This page')).toBeInTheDocument()
    expect(screen.queryByText(/pages\./)).not.toBeInTheDocument()
  })
})
