/**
 * @fileoverview SystemEnvironment: the collapsible "Environment" block shows the
 * deployment's known fields under translated labels in a fixed order, any other
 * field under its own name, yes/no values as On/Off and lists item by item.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import { normalizeSystemEnvironment } from '../../api/systemDiagnostics'
import SystemEnvironment from './SystemEnvironment'

const mockGetEnvironment = vi.fn<() => Promise<unknown>>()
vi.mock('../../api/client', () => ({
  api: { getSystemEnvironment: () => mockGetEnvironment().then(normalizeSystemEnvironment) },
}))

const ENVIRONMENT = {
  build_commit: 'abc1234',
  alerting: false,
  region: 'us-west-2',
  version: '5.44.0',
  deployment_prefix: '',
  web_search: true,
  enabled_sources: ['webscraper', 'github_issues'],
  image_model: { id: 'stability.stable-image-core-v1:1', region: 'us-west-2' },
  models: {},
}

async function openBlock() {
  const user = userEvent.setup()
  renderWithQueryClient(<SystemEnvironment />)
  const toggle = screen.getByRole('button', { name: 'Environment' })
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await user.click(toggle)
  return toggle
}

describe('SystemEnvironment', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists known fields in order under their labels, then unknown ones by name', async () => {
    mockGetEnvironment.mockResolvedValue(ENVIRONMENT)
    const toggle = await openBlock()

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await screen.findByText('Version')
    const labels = screen.getAllByRole('term').map((term) => term.textContent)
    // The empty prefix is dropped; build_commit is not a known field and comes last.
    expect(labels).toStrictEqual([
      'Version', 'Region', 'Enabled sources', 'Web search', 'Image model', 'Model choices', 'Alerting', 'build_commit',
    ])
    // The version is the SPA's build stamp (vitest.config.ts pins it), not a field of the route.
    expect(screen.getByText('Version').nextElementSibling?.textContent).toBe('3.04.00 (abc1234)')
  })

  it('shows flags as On / Off, lists item by item and an empty map as None', async () => {
    mockGetEnvironment.mockResolvedValue(ENVIRONMENT)
    await openBlock()

    await screen.findByText('Version')
    const values = screen.getAllByRole('definition')
    const texts = values.map((value) => value.textContent)
    expect(['On', 'Off', 'None'].map((text) => texts.includes(text))).toStrictEqual([true, true, true])
    const sources = values.find((value) => value.textContent.includes('webscraper'))
    expect(sources && within(sources).getAllByRole('listitem').map((item) => item.textContent))
      .toStrictEqual(['webscraper', 'github_issues'])
    expect(screen.getByText('id: stability.stable-image-core-v1:1')).toBeInTheDocument()
  })

  it('shows a load error for a non-object answer', async () => {
    mockGetEnvironment.mockResolvedValue(['not', 'an', 'object'])
    await openBlock()

    expect(await screen.findByRole('alert')).toHaveTextContent('The environment could not be loaded.')
  })
})
