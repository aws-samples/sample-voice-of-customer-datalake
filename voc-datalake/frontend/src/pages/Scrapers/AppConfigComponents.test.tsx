import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AppConfigCard } from './AppConfigComponents'
import type { PluginManifest } from '../../plugins/types'

const plugin: PluginManifest = {
  id: 'app_reviews_android',
  name: 'Android App Reviews',
  icon: 'Android',
  description: 'Collect reviews from Google Play Store',
  category: 'reviews',
  config: [],
  hasIngestor: true,
  hasWebhook: false,
  hasS3Trigger: false,
  version: '1.0.0',
  enabled: true,
}

const app = {
  id: 'app-1',
  app_name: 'Zara',
  package_name: 'com.inditex.zara',
  frequency_minutes: '1440',
  max_reviews_per_run: '500',
}

function renderCard(canManage: boolean) {
  return render(
    <AppConfigCard
      app={app}
      plugin={plugin}
      canManage={canManage}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onRun={vi.fn()}
      isRunning={false}
    />,
  )
}

describe('AppConfigCard', () => {
  it('shows edit and delete actions for admins', () => {
    renderCard(true)
    expect(screen.getByTestId('app-config-edit')).toBeInTheDocument()
    expect(screen.getByTestId('app-config-delete')).toBeInTheDocument()
    expect(screen.getByTestId('app-config-run').getAttribute('aria-label')).toBeTruthy()
  })

  it('hides edit and delete actions for non-admins but keeps Run Now', () => {
    renderCard(false)
    expect(screen.queryByTestId('app-config-edit')).not.toBeInTheDocument()
    expect(screen.queryByTestId('app-config-delete')).not.toBeInTheDocument()
    expect(screen.getByTestId('app-config-run')).toBeInTheDocument()
  })
})
