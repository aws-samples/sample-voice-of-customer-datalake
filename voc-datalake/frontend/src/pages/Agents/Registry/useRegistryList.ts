/**
 * @fileoverview The Registry's cards of one scope (`GET /agents/engineering/registry[?connection=]`, '' for the shared
 * skills), read once the API endpoint is set: the read the Registry page, Skills' roles table and Administration →
 * Engineering agents' Roles' models share (one key, so one call).
 *
 * @module pages/Agents/Registry/useRegistryList
 */
import { useQuery } from '@tanstack/react-query'
import { engineeringRegistryApi, engineeringRegistryKeys } from '../../../api/engineeringRegistryApi'
import { useConfigStore } from '../../../store/configStore'

export function useRegistryList(connection: string) {
  const configured = useConfigStore((s) => s.config.apiEndpoint) !== ''
  return useQuery({
    queryKey: engineeringRegistryKeys.list(connection), queryFn: () => engineeringRegistryApi.list(connection), enabled: configured,
  })
}
