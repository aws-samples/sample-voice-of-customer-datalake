/**
 * Administration → Integrations setup help: one accessible disclosure per
 * token, collapsed by default, with official provider links that open in a new
 * tab, and failure reasons that match what the backend actually stores.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TestRouter } from '@test/TestRouter'
import IntegrationSetupGuide from './IntegrationSetupGuide'
import { INTEGRATION_GUIDES } from './integrationGuides'

function renderGuide() {
  return render(<TestRouter><IntegrationSetupGuide /></TestRouter>)
}

const FIGMA = /figma personal access token/i
const GITHUB = /github fine-grained personal access token/i

describe('IntegrationSetupGuide', () => {
  it('renders one collapsed disclosure per integration', () => {
    renderGuide()
    for (const name of [FIGMA, GITHUB]) {
      const button = screen.getByRole('button', { name })
      expect(button).toHaveAttribute('aria-expanded', 'false')
      // A hidden region is still in the DOM, so aria-controls always points at an element.
      expect(document.getElementById(button.getAttribute('aria-controls') ?? '')).not.toBeVisible()
    }
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
  })

  it('points data-source credentials to the Data Sources tab', () => {
    renderGuide()
    expect(screen.getByText(/each source card in the data sources tab/i)).toBeInTheDocument()
  })

  it('opens a labelled region with the steps, leaving the other provider collapsed', async () => {
    renderGuide()
    const button = screen.getByRole('button', { name: FIGMA })
    await userEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    const region = screen.getByRole('region', { name: FIGMA })
    expect(region).toHaveAttribute('id', button.getAttribute('aria-controls'))
    expect(within(region).getByText(/set "file content" to read-only \(file_content:read\)/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: GITHUB })).toHaveAttribute('aria-expanded', 'false')
  })

  it('closes the region again on a second click', async () => {
    renderGuide()
    const button = screen.getByRole('button', { name: GITHUB })
    await userEvent.click(button)
    expect(within(screen.getByRole('region', { name: GITHUB })).getByText(/aws secrets manager/i)).toBeInTheDocument()
    await userEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
  })

  it('interpolates the app labels into the save and check steps', async () => {
    renderGuide()
    await userEvent.click(screen.getByRole('button', { name: GITHUB }))
    const region = screen.getByRole('region', { name: GITHUB })
    expect(within(region).getByText(/paste the token into the "github token" field above and click "save tokens"/i)).toBeInTheDocument()
    expect(within(region).getByText(/choose the type "github repository"/i)).toBeInTheDocument()
    expect(within(region).getByRole('link', { name: 'Open Company → Design system' })).toHaveAttribute('href', '/company?tab=design')
  })

  it('links each provider to its official pages in a new tab, without an opener', async () => {
    renderGuide()
    await userEvent.click(screen.getByRole('button', { name: FIGMA }))
    await userEvent.click(screen.getByRole('button', { name: GITHUB }))
    const expected: Record<string, string> = {
      'Figma: personal access tokens': 'https://developers.figma.com/docs/rest-api/personal-access-tokens/',
      'Figma: token scopes': 'https://developers.figma.com/docs/rest-api/scopes/',
      'Create the token on GitHub (pre-filled: Contents read-only)':
        'https://github.com/settings/personal-access-tokens/new?name=VoC+design+system&description=Read-only+design+references+for+VoC&contents=read',
      'GitHub: managing personal access tokens':
        'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
    }
    for (const [label, href] of Object.entries(expected)) {
      const link = screen.getByRole('link', { name: new RegExp(`^${label.replace(/[()]/g, '\\$&')}`) })
      expect(link).toHaveAttribute('href', href)
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    }
  })

  it('asks for read-only least privilege on GitHub (pre-filled Contents read, nothing writable)', () => {
    const github = INTEGRATION_GUIDES.find((g) => g.provider === 'github')
    const newToken = new URL(github?.links[0]?.href ?? 'https://invalid.example')
    expect(newToken.searchParams.get('contents')).toBe('read')
    expect([...newToken.searchParams.values()]).not.toContain('write')
    expect((newToken.searchParams.get('name') ?? '').length).toBeLessThanOrEqual(40)
  })
})

describe('integration guide failure reasons', () => {
  // The reasons are quoted verbatim from the backend; a reworded message there must fail here.
  const backend = readFileSync(resolve(__dirname, '../../../../lambda/shared/design_references.py'), 'utf-8')

  it.each(INTEGRATION_GUIDES.flatMap((g) => g.failures.map((f) => [g.provider, f.message])))(
    '%s: "%s" is a message design_references.py can store',
    (_provider, message) => {
      const template = message.replace(/^(Figma|GitHub) /, '{what} ')
      expect(backend.includes(message) || backend.includes(template)).toBe(true)
    },
  )
})
