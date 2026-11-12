/**
 * Administration → General's brand form, read-only: the notice names who may change the brand where the form is,
 * the deployment's administrators outside a workspace, the workspace's admins inside one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { ACME } from '../../test/workspaceFixtures'
import { setCurrentWorkspace } from '../../workspace/currentWorkspace'
import { BrandConfigSection } from './SettingsSections'

function renderReadOnly() {
  const change = vi.fn<(value: string) => void>()
  return render(
    <BrandConfigSection apiEndpoint="https://api.example.com" loadingSettings={false} loadFailed={false} onRetry={vi.fn()}
      brandName="Acme Outfitters" brandHandles="" hashtags="" urlsToTrack="" onBrandNameChange={change}
      onBrandHandlesChange={change} onHashtagsChange={change} onUrlsToTrackChange={change} readOnly />,
  )
}

afterEach(() => setCurrentWorkspace(null))

describe('BrandConfigSection read-only', () => {
  it("names the deployment's administrators outside a workspace", () => {
    renderReadOnly()
    expect(screen.getByText('Only admins can change the brand configuration. You can view it here.')).toBeInTheDocument()
    expect(screen.getByLabelText('Brand Name')).toBeDisabled()
  })

  it("names the workspace's admins inside one", () => {
    act(() => setCurrentWorkspace({ ...ACME, role: 'viewer' }))
    renderReadOnly()
    expect(screen.getByText("Only this workspace's admins can change its brand. You can view it here.")).toBeInTheDocument()
  })
})
