/**
 * @fileoverview The Product tab's header: what the tab is for, how complete the
 * description is, when it was last saved, and — for an editor — "Fill with AI
 * assistant".
 *
 * The button opens the assistant bubble on a NEW conversation with a short
 * interview request as its draft (nothing is sent until the user presses send).
 * The interview itself — the questions, one at a time, only for empty fields, then
 * ONE `update_product_context` approval card — is the assistant's own guidance
 * (`lambda/stream/src/assistant/tools/product-interview.ts`), so the questions live
 * in one place. The page context (this project, kind `project`) comes from the
 * route, as for any message sent from this page.
 *
 * @module pages/ProjectDetail/ProductTabHeader
 */
import { Package, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { openAssistant } from '../../assistant/store/openAssistant'
import { formatDateTime } from '../../utils/dateUtils'
import { countFilledProductContextFields, PRODUCT_CONTEXT_FIELD_COUNT } from './productContextFields'
import type { ProductContext } from '../../api/projectTypes'

export default function ProductTabHeader({ context, canEdit }: Readonly<{ context: ProductContext; canEdit: boolean }>) {
  const { t, i18n } = useTranslation('projectDetail')
  const updatedAt = context.updated_at ?? ''
  return (
    <header className="card flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1 space-y-1">
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-text-strong">
          <Package size={18} className="flex-shrink-0 text-accent" aria-hidden="true" />
          {t('product.title')}
        </h2>
        <p className="text-sm text-muted">{t('product.subtitle')}</p>
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted">
          <span>
            {t('overview.state.product', {
              filled: countFilledProductContextFields(context), total: PRODUCT_CONTEXT_FIELD_COUNT,
            })}
          </span>
          <span>
            {updatedAt === ''
              ? t('product.neverSaved')
              : t('product.lastSaved', { at: formatDateTime(updatedAt, i18n.language, updatedAt) })}
          </span>
        </p>
      </div>
      {canEdit && (
        <div className="flex flex-col gap-1.5 sm:max-w-xs sm:items-end">
          <button
            type="button"
            className="btn btn-primary self-start sm:self-end"
            onClick={() => openAssistant({ prompt: t('product.assistant.prompt') })}
          >
            <Sparkles size={14} aria-hidden="true" />
            {t('product.assistant.button')}
          </button>
          <p className="text-[12px] text-muted sm:text-right">{t('product.assistant.hint')}</p>
        </div>
      )}
    </header>
  )
}
