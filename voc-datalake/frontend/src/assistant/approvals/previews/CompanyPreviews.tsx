/**
 * @fileoverview Company-pack approval previews: each replaced document part
 * (vision, objectives, tokens, guidelines, own objectives) before → after,
 * against the current stored value.
 *
 * @module assistant/approvals/previews/CompanyPreviews
 */
import { useQuery } from '@tanstack/react-query'
import { readCompanyContext, readDesignSystem, readMyContext } from '../companyExecutors'
import { companyPreviewKeys } from '../invalidation'
import { FieldChanges } from './FieldChangesPreview'
import type { UpdateCompanyContextArgs, UpdateDesignSystemArgs, UpdateMyContextArgs } from '../companySchemas'

function useCurrent(queryKey: readonly string[], read: () => Promise<Record<string, unknown>>) {
  return useQuery({ queryKey, queryFn: read, retry: false })
}

export function CompanyContextPreview({ args }: Readonly<{ args: UpdateCompanyContextArgs }>) {
  const { data, isLoading } = useCurrent(companyPreviewKeys.companyContext(), readCompanyContext)
  return <FieldChanges updates={{ ...args }} current={data} isLoading={isLoading} />
}

export function MyContextPreview({ args }: Readonly<{ args: UpdateMyContextArgs }>) {
  const { data, isLoading } = useCurrent(companyPreviewKeys.myContext(), readMyContext)
  return <FieldChanges updates={{ ...args }} current={data} isLoading={isLoading} />
}

export function DesignSystemPreview({ args }: Readonly<{ args: UpdateDesignSystemArgs }>) {
  const { data, isLoading } = useCurrent(companyPreviewKeys.designSystem(), readDesignSystem)
  return <FieldChanges updates={{ ...args }} current={data} isLoading={isLoading} />
}
