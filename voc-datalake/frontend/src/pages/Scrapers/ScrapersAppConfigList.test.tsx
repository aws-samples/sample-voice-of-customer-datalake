import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppConfigList } from './Scrapers'
import { appConfigsQueryKey } from './app-config-query'
import { useConfigStore } from '../../store/configStore'
import type { PluginManifest } from '../../plugins/types'

const initialConfig = useConfigStore.getState().config

const pluginWithApp = {
  id: 'app_reviews_android',
  name: 'Android reviews',
  description: 'Review importer',
  icon: '📱',
  category: 'reviews',
  enabled: true,
  hasIngestor: true,
  hasWebhook: false,
  hasS3Trigger: false,
  config: [],
  apps: [
    {
      id: 'a1',
      app_name: 'Zara',
      package_name: 'com.inditex.zara',
      country: 'us',
      schedule_enabled: true,
    },
  ],
} satisfies PluginManifest

afterEach(() => {
  useConfigStore.setState({ config: initialConfig })
})

function renderList(isAdmin: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  useConfigStore.setState((state) => ({
    config: { ...state.config, apiEndpoint: 'https://api.example.com' },
  }))
  qc.setQueryData(appConfigsQueryKey([pluginWithApp]), [{
    pluginId: pluginWithApp.id,
    apps: pluginWithApp.apps,
  }])
  render(
    <QueryClientProvider client={qc}>
      <AppConfigList
        plugins={[pluginWithApp]}
        isAdmin={isAdmin}
        onEditPlugin={vi.fn()}
        onDeleteApp={vi.fn()}
        onRunApp={vi.fn()}
      />
    </QueryClientProvider>,
  )
}

describe('AppConfigList admin wiring', () => {
  it('forwards admin access to app cards', () => {
    renderList(true)
    expect(screen.getByTestId('app-config-edit')).toBeTruthy()
    expect(screen.getByTestId('app-config-delete')).toBeTruthy()
    expect(screen.getByTestId('app-config-run')).toBeTruthy()
  })

  it('forwards non-admin read-only access to app cards', () => {
    renderList(false)
    expect(screen.queryByTestId('app-config-edit')).toBeNull()
    expect(screen.queryByTestId('app-config-delete')).toBeNull()
    expect(screen.getByTestId('app-config-run')).toBeTruthy()
  })
})
