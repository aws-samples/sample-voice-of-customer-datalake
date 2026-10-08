/**
 * @fileoverview Categories configuration manager component.
 *
 * Features:
 * - Add, edit, delete categories and subcategories
 * - AI-powered category generation from company description
 * - Expandable tree view
 * - Persist to backend
 *
 * @module components/CategoriesManager
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Loader2, Sparkles, Check, AlertCircle } from 'lucide-react'
import { api } from '../../api/client'
import { categoriesConfigKey, useCategoriesConfig } from '../../hooks/useCategories'
import ConfirmModal from '../ConfirmModal/ConfirmModal'
import { normalizeCategories } from './categoriesSchema'
import CategoryRow from './CategoryRow'
import { subcategoriesOf, toSlug } from './categoryEntries'
import ReprocessPanel from './ReprocessPanel'

/**
 * Unique id for a new (sub)category, minted at interaction time.
 * crypto.randomUUID over Date.now(): two adds in the same millisecond
 * produced identical ids (same hazard as issue #160 in the former chat store).
 */
function makeEntryId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

/** A product owner accountable for a category (and implicitly able to see its feedback). */
export interface CategoryOwner {
  sub: string
  username: string
  email: string
}

export interface Category {
  id: string
  /** snake_case identifier stored on every review (≤64). */
  name: string
  /** Human label / explanation (≤500). */
  description?: string
  /** The product or area this category belongs to (≤120). */
  product?: string
  /** Product owners responsible for it (≤20). */
  owners?: CategoryOwner[]
  subcategories: Subcategory[]
}

export interface Subcategory {
  id: string
  name: string
  description?: string
}

export default function CategoriesManager() {
  const { t } = useTranslation('components', { keyPrefix: 'categoriesManager' })
  const queryClient = useQueryClient()
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set())
  const [companyDescription, setCompanyDescription] = useState('')
  const [deleteCategoryId, setDeleteCategoryId] = useState<string | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [editingCategory, setEditingCategory] = useState<string | null>(null)
  const [editingSubcategory, setEditingSubcategory] = useState<string | null>(null)
  const [newCategoryName, setNewCategoryName] = useState('')
  const [newSubcategoryName, setNewSubcategoryName] = useState<Partial<Record<string, string>>>({})

  // Normalized once at the shared query boundary — legacy rows lack
  // id/subcategories and crashed this tab (issue #181).
  const { data: categoriesConfig, isLoading } = useCategoriesConfig()

  const saveMutation = useMutation({
    mutationFn: (categories: Category[]) => api.saveCategoriesConfig({ categories }),
    // Refetch on failure too: the route validates (and is admin-only), so a
    // refused save must not leave the editor showing what was not stored.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: categoriesConfigKey() })
    },
  })

  const generateMutation = useMutation({
    mutationFn: (description: string) => api.generateCategories(description),
    onSuccess: (data) => {
      if (Array.isArray(data.categories)) {
        // The LLM response is a wire boundary too — normalize before saving.
        saveMutation.mutate(normalizeCategories(data.categories))
      }
      setIsGenerating(false)
    },
    onError: () => {
      setIsGenerating(false)
    },
  })

  const categories = categoriesConfig?.categories ?? []

  const toggleExpanded = (categoryId: string) => {
    const newExpanded = new Set(expandedCategories)
    if (newExpanded.has(categoryId)) {
      newExpanded.delete(categoryId)
    } else {
      newExpanded.add(categoryId)
    }
    setExpandedCategories(newExpanded)
  }

  const handleAddCategory = () => {
    if (!newCategoryName.trim()) return
    const newCategory: Category = {
      id: makeEntryId('cat'),
      name: toSlug(newCategoryName.trim()),
      description: newCategoryName.trim(),
      subcategories: [],
    }
    saveMutation.mutate([...categories, newCategory])
    setNewCategoryName('')
  }

  const handleDeleteCategory = (categoryId: string) => {
    setDeleteCategoryId(categoryId)
  }
  
  const confirmDeleteCategory = () => {
    if (deleteCategoryId) {
      saveMutation.mutate(categories.filter(c => c.id !== deleteCategoryId))
      setDeleteCategoryId(null)
    }
  }

  const handleUpdateCategory = (categoryId: string, updates: Partial<Category>) => {
    saveMutation.mutate(
      categories.map(c => c.id === categoryId ? { ...c, ...updates } : c)
    )
    setEditingCategory(null)
  }

  const handleAddSubcategory = (categoryId: string) => {
    const name = newSubcategoryName[categoryId]?.trim()
    if (!name) return
    const newSub: Subcategory = {
      id: makeEntryId('sub'),
      name: toSlug(name),
      description: name,
    }
    saveMutation.mutate(
      categories.map(c => c.id === categoryId 
        ? { ...c, subcategories: [...subcategoriesOf(c), newSub] }
        : c
      )
    )
    setNewSubcategoryName(prev => ({ ...prev, [categoryId]: '' }))
  }

  const handleUpdateSubcategory = (categoryId: string, subcategoryId: string, newValue: string) => {
    const updated = categories.map(c => {
      if (c.id !== categoryId) return c
      return {
        ...c,
        subcategories: subcategoriesOf(c).map(s => {
          if (s.id !== subcategoryId) return s
          return {
            ...s,
            description: newValue,
            name: toSlug(newValue),
          }
        }),
      }
    })
    saveMutation.mutate(updated)
    setEditingSubcategory(null)
  }

  const handleDeleteSubcategory = (categoryId: string, subcategoryId: string) => {
    saveMutation.mutate(
      categories.map(c => c.id === categoryId 
        ? { ...c, subcategories: subcategoriesOf(c).filter(s => s.id !== subcategoryId) }
        : c
      )
    )
  }

  const handleGenerate = () => {
    if (!companyDescription.trim()) return
    setIsGenerating(true)
    generateMutation.mutate(companyDescription)
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="animate-spin text-muted" size={24} />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* AI Generation Section */}
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

      {/* Categories List */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold tracking-tight text-text-strong">{t('listTitle')}</h3>
          <span className="text-sm font-mono text-muted">{t('categoryCount', { count: categories.length })}</span>
        </div>
        <p className="text-sm text-text mb-3">{t('listHelp')}</p>

        {categories.length === 0 ? (
          <div className="text-center py-8 text-muted bg-bg-accent rounded-lg border border-dashed border-border-strong">
            <p className="mb-2">{t('emptyTitle')}</p>
            <p className="text-sm">{t('emptyHint')}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {categories.map((category) => (
              <CategoryRow
                key={category.id}
                category={category}
                isOpen={expandedCategories.has(category.id)}
                saving={saveMutation.isPending}
                isEditing={editingCategory === category.id}
                editingSubcategoryId={editingSubcategory}
                newSubcategoryName={newSubcategoryName[category.id] ?? ''}
                onToggle={() => toggleExpanded(category.id)}
                onStartEdit={() => setEditingCategory(category.id)}
                onCancelEdit={() => setEditingCategory(null)}
                onUpdate={(updates) => handleUpdateCategory(category.id, updates)}
                onDelete={() => handleDeleteCategory(category.id)}
                onStartEditSubcategory={setEditingSubcategory}
                onRenameSubcategory={(subId, value) => handleUpdateSubcategory(category.id, subId, value)}
                onDeleteSubcategory={(subId) => handleDeleteSubcategory(category.id, subId)}
                onNewSubcategoryNameChange={(value) => setNewSubcategoryName(prev => ({ ...prev, [category.id]: value }))}
                onAddSubcategory={() => handleAddSubcategory(category.id)}
              />
            ))}
          </div>
        )}

        {/* Add New Category */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 mt-4">
          <input
            type="text"
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
            placeholder={t('addCategoryPlaceholder')}
            aria-label={t('addCategory')}
            className="flex-1 input"
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddCategory()
            }}
          />
          <button
            onClick={handleAddCategory}
            disabled={!newCategoryName.trim() || saveMutation.isPending}
            className="btn btn-secondary flex items-center justify-center gap-2 w-full sm:w-auto"
          >
            <Plus size={16} />
            {t('addCategory')}
          </button>
        </div>
      </div>

      {/* Save Status */}
      {saveMutation.isPending && (
        <div className="flex items-center gap-2 text-sm text-accent-text">
          <Loader2 size={14} className="animate-spin" />
          {t('saving')}
        </div>
      )}
      {saveMutation.isSuccess && (
        <div className="flex items-center gap-2 text-sm text-ok">
          <Check size={14} />
          {t('saved')}
        </div>
      )}
      {saveMutation.isError && (
        <p role="alert" className="text-sm text-text flex items-center gap-2 bg-danger-subtle border border-danger/30 rounded-md px-3 py-2">
          <AlertCircle size={14} className="text-danger flex-shrink-0" aria-hidden="true" />
          {t('saveError')}
        </p>
      )}

      <ReprocessPanel />

      <ConfirmModal
        isOpen={deleteCategoryId !== null}
        title={t('deleteTitle')}
        message={t('deleteMessage')}
        confirmLabel={t('deleteConfirm')}
        variant="danger"
        isLoading={saveMutation.isPending}
        onConfirm={confirmDeleteCategory}
        onCancel={() => setDeleteCategoryId(null)}
      />
    </div>
  )
}
