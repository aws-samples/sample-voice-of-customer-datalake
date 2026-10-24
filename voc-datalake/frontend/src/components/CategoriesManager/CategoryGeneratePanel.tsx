/**
 * @fileoverview "AI Category Suggestions": generate a taxonomy from a company
 * description via `POST /settings/categories/generate`.
 *
 * Admin-only (owner decision 2026-10-08, #242): every call spends Bedrock and
 * its result replaces the admin-only categories config, so `CategoriesManager`
 * renders this panel only for admins. The server's 403 is the boundary; hiding
 * the panel only keeps a non-admin from meeting it.
 *
 * @module components/CategoriesManager/CategoryGeneratePanel
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@tanstack/react-query'
import { Loader2, Sparkles, AlertCircle } from 'lucide-react'
import { api } from '../../api/client'

interface CategoryGeneratePanelProps {
  /** Receives the raw `categories` array of a successful generation (the caller normalizes it). */
  readonly onGenerated: (categories: unknown[]) => void
}

export default function CategoryGeneratePanel({ onGenerated }: CategoryGeneratePanelProps) {
  const { t } = useTranslation('components', { keyPrefix: 'categoriesManager' })
  const [companyDescription, setCompanyDescription] = useState('')

  const generateMutation = useMutation({
    mutationFn: (description: string) => api.generateCategories(description),
    onSuccess: (data) => {
      if (Array.isArray(data.categories)) onGenerated(data.categories)
    },
  })

  const handleGenerate = () => {
    if (!companyDescription.trim()) return
    generateMutation.mutate(companyDescription)
  }

  const isGenerating = generateMutation.isPending

  return (
    <div className="bg-aim-subtle rounded-lg p-3 sm:p-4 border border-aim/30">
      <div className="flex flex-col sm:flex-row sm:items-start gap-3">
        <div className="p-2 bg-aim-subtle rounded-lg w-fit">
          <Sparkles className="text-aim" size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold tracking-tight text-text-strong mb-1">{t('aiTitle')}</h3>
          <p className="text-sm text-text mb-3">
            {t('aiDescription')}
          </p>
          <textarea
            value={companyDescription}
            onChange={(e) => setCompanyDescription(e.target.value)}
            placeholder={t('aiPlaceholder')}
            aria-label={t('companyLabel')}
            className="input min-h-[80px] text-sm mb-3 w-full"
          />
          <button
            type="button"
            onClick={handleGenerate}
            disabled={isGenerating || !companyDescription.trim()}
            className="btn btn-primary flex items-center justify-center gap-2 w-full sm:w-auto"
          >
            {isGenerating ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                {t('generating')}
              </>
            ) : (
              <>
                <Sparkles size={16} />
                {t('generateButton')}
              </>
            )}
          </button>
          {generateMutation.isError && (
            <p role="alert" className="text-sm text-text mt-3 flex items-center gap-2 bg-danger-subtle border border-danger/30 rounded-md px-3 py-2">
              <AlertCircle size={14} className="text-danger flex-shrink-0" />
              {t('generateError')}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
