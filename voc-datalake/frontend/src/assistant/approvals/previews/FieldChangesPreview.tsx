/**
 * @fileoverview Before/after per changed field — `update_persona` (current
 * values from the project record) and `update_product_context` (current values
 * from the product-context query the Project Detail page shares).
 *
 * @module assistant/approvals/previews/FieldChangesPreview
 */
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { projectsApi } from '../../../api/projectsApi'
import { productContextKey } from '../../../pages/ProjectDetail/useProjectData'
import { humanizeKey, isRecord, sameValue } from './format'
import { useProjectDetail } from './useProjectDetail'
import { ValueView } from './ValueView'
import type { UpdatePersonaArgs, UpdateProductContextArgs } from '../schemas'

interface FieldChangesProps {
  updates: Record<string, unknown>
  /** `undefined` while the current record is unknown (loading or failed). */
  current: Record<string, unknown> | undefined
  isLoading: boolean
}

export function FieldChanges({ updates, current, isLoading }: Readonly<FieldChangesProps>) {
  const { t } = useTranslation('assistantTools')
  const fields = Object.entries(updates).filter(([, v]) => v !== undefined)
  return (
    <div className="space-y-2">
      {isLoading && <p className="text-[12px] text-muted">{t('preview.loading')}</p>}
      {!isLoading && current === undefined && (
        <p className="text-[12px] text-warn">{t('preview.currentUnavailable')}</p>
      )}
      {fields.map(([key, after]) => {
        const before = current?.[key]
        const unchanged = current !== undefined && sameValue(before, after)
        return (
          <div key={key} className="text-sm border border-border rounded-md p-2">
            <p className="text-[12px] font-medium text-muted">
              {humanizeKey(key)}{unchanged && ` · ${t('preview.unchanged')}`}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
              {current !== undefined && (
                <div className={clsx('rounded-sm px-1.5 py-1 text-muted', !unchanged && 'bg-danger-subtle')}>
                  <p className="text-[12px]">{t('preview.before')}</p>
                  <ValueView value={before} />
                </div>
              )}
              <div className={clsx('rounded-sm px-1.5 py-1 text-text-strong', !unchanged && 'bg-ok-subtle')}>
                <p className="text-[12px] text-muted">{t('preview.after')}</p>
                <ValueView value={after} />
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function PersonaChangesPreview({ args }: Readonly<{ args: UpdatePersonaArgs }>) {
  const { t } = useTranslation('assistantTools')
  const { data, isLoading } = useProjectDetail(args.project_id)
  const persona = data?.personas.find((p) => p.persona_id === args.persona_id)
  const current: Record<string, unknown> | undefined = persona === undefined ? undefined : { ...persona }
  return (
    <div className="space-y-2">
      <p className="text-sm">
        <span className="text-[12px] font-medium text-muted">{t('preview.persona')}: </span>
        {persona?.name ?? args.persona_id}
      </p>
      <FieldChanges updates={args.updates} current={current} isLoading={isLoading} />
    </div>
  )
}

export function ProductContextPreview({ args }: Readonly<{ args: UpdateProductContextArgs }>) {
  const { data, isLoading } = useQuery({
    queryKey: productContextKey(args.project_id),
    queryFn: () => projectsApi.getProductContext(args.project_id),
    retry: false,
  })
  const context: unknown = data?.context
  return <FieldChanges updates={args.updates} current={isRecord(context) ? context : undefined} isLoading={isLoading} />
}
