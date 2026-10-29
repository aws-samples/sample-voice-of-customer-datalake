/**
 * @fileoverview The capacity overview of the Settings AI models card (GET /settings/model/capacity,
 * no model call): every text model's tokens-per-minute quota and the image model's access and
 * requests-per-minute quota. One query shared by the "Test all" table and the image row.
 */
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import { modelCapacityKey } from '../../api/queryKeys'

// The overview reads Service Quotas, which the backend caches for 10 minutes too.
const CAPACITY_STALE_MS = 10 * 60 * 1000

export function useModelCapacity() {
  return useQuery({
    queryKey: modelCapacityKey(),
    queryFn: () => api.getModelCapacity(),
    staleTime: CAPACITY_STALE_MS,
  })
}
