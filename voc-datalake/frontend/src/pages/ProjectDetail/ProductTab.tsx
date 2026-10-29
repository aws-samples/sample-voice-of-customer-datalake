/**
 * ProductTab — the current product/service description that PRD / PR/FAQ
 * generation uses as context.
 *
 * One header (what this is, completeness, last saved, "Fill with AI assistant"),
 * the company context it inherits, the form in sections (per-field autosave), and
 * two secondary cards: internal documents and the report.
 *
 * The context is the page's shared query (`productContextQuery`): this tab, the
 * Overview card and the assistant's `update_product_context` approval (which
 * refreshes it) all read one cache entry, so an approved assistant card shows up
 * in the form at once and a save here updates the Overview count without a refetch.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { projectsApi } from '../../api/projectsApi'
import CompanyContextStrip from './CompanyContextStrip'
import ProductContextForm from './ProductContextForm'
import { DocsUpload } from './ProductDocsUpload'
import ProductReportCard from './ProductReportCard'
import ProductTabHeader from './ProductTabHeader'
import { countFilledProductContextFields, emptyProductContext } from './productContextFields'
import { productContextKey, productContextQuery } from './useProjectData'
import type { ProductContext } from '../../api/projectTypes'

/** The product-context query's data shape, taken from the call that produces it. */
type ProductContextResponse = Awaited<ReturnType<typeof projectsApi.getProductContext>>

/** Build a single-field patch without a type assertion (computed generic keys widen otherwise). */
function singleFieldPatch<K extends keyof ProductContext>(field: K, value: ProductContext[K]): Partial<ProductContext> {
  const patch: Partial<ProductContext> = {}
  patch[field] = value
  return patch
}

/** Every authored field present: a cleared field can arrive missing, and the form needs a string. */
function normalised(context: Partial<ProductContext> | undefined): ProductContext {
  return { ...emptyProductContext(), ...context }
}

interface ProductTabProps {
  readonly projectId: string
  /**
   * False for a viewer (`can_edit: false`): the form is shown disabled, the uploaded
   * docs are listed without upload/delete, and neither the assistant button nor the
   * report — both of which lead to a write — is offered. Each would otherwise 403.
   */
  readonly canEdit: boolean
  /**
   * A report generation was started. The Background Jobs panel owns the wait;
   * the document itself lands in the Documents tab when the job completes.
   */
  readonly onJobStarted?: () => void
}

export default function ProductTab({ projectId, canEdit, onJobStarted }: ProductTabProps) {
  const { t } = useTranslation('projectDetail')
  const queryClient = useQueryClient()
  // A failed read leaves the form blank, as before: the tab must stay usable.
  const { data, isLoading } = useQuery(productContextQuery(projectId))
  const context = useMemo(() => normalised(data?.context), [data])
  const [savingField, setSavingField] = useState<keyof ProductContext | null>(null)

  const persistField = useCallback(async <K extends keyof ProductContext>(field: K, value: ProductContext[K]) => {
    setSavingField(field)
    try {
      const saved = await projectsApi.updateProductContext(projectId, singleFieldPatch(field, value))
      // Seed the shared cache with the server's copy: the Overview card counts from it.
      queryClient.setQueryData<ProductContextResponse>(productContextKey(projectId), { context: normalised(saved.context) })
    } catch (e) {
      console.error(`Failed to save ${String(field)}`, e)
    } finally {
      setSavingField(null)
    }
  }, [projectId, queryClient])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted" role="status">
        <Loader2 size={20} className="mr-2 animate-spin" aria-hidden="true" /> {t('product.loading')}
      </div>
    )
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <ProductTabHeader context={context} canEdit={canEdit} />
      <CompanyContextStrip />
      <div className="grid items-start gap-4 sm:gap-6 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <ProductContextForm
            context={context}
            readOnly={!canEdit}
            savingField={savingField}
            onPersistField={(field, value) => { void persistField(field, value) }}
          />
        </div>
        <div className="min-w-0 space-y-4">
          <DocsUpload projectId={projectId} canEdit={canEdit} />
          {canEdit && (
            <ProductReportCard
              projectId={projectId}
              hasNoFields={countFilledProductContextFields(context) === 0}
              onJobStarted={onJobStarted}
            />
          )}
        </div>
      </div>
    </div>
  )
}
