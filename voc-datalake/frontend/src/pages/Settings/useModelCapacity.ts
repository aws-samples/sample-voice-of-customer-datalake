/**
 * @fileoverview The capacity overview of the Settings AI models card (GET /settings/model/capacity,
 * no model call): every text model's tokens-per-minute quota and the image model's access and
 * requests-per-minute quota. One query shared by the "Test all" table and the image row.
 */
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import { modelCapacityKey } from '../../api/queryKeys'
import type { ImageAccessStatus } from '../../api/imageModelSchema'

// The overview reads Service Quotas, which the backend caches for 10 minutes too.
const CAPACITY_STALE_MS = 10 * 60 * 1000

/** `enabled` false: no read (the Administration home asks only for an administrator; the route is admin-only). */
export function useModelCapacity(enabled = true) {
  return useQuery({
    queryKey: modelCapacityKey(),
    queryFn: () => api.getModelCapacity(),
    staleTime: CAPACITY_STALE_MS,
    enabled,
  })
}

/** The access statuses that mean a model's calls fail; `unknown` (not read) is not one. */
const BLOCKED_STATUSES = ['not_subscribed', 'no_access', 'not_in_region'] as const

export type BlockedAccess = (typeof BLOCKED_STATUSES)[number]

export function isBlockedAccess(status: ImageAccessStatus): status is BlockedAccess {
  return BLOCKED_STATUSES.some((blocked) => blocked === status)
}
