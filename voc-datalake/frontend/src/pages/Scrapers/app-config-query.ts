import type { PluginManifest } from '../../plugins/types'

export function appConfigsQueryKey(plugins: readonly Pick<PluginManifest, 'id'>[]) {
  return ['all-app-configs', plugins.map((p) => p.id).join(',')] as const
}
