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

import {
  useQuery, useMutation, useQueryClient,
} from '@tanstack/react-query'
import {
  Plus, Trash2, Loader2, Sparkles, ChevronDown, ChevronRight,
  Check, AlertCircle, GripVertical,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import ConfirmModal from '../ConfirmModal'

interface Category {
  id: string
  name: string
  description?: string
  subcategories: Subcategory[]
}

interface Subcategory {
  id: string
  name: string
  description?: string
}

interface SaveStatusProps {
  isPending: boolean
  isSuccess: boolean
  t: (key: string) => string
}

function SaveStatus({
  isPending, isSuccess, t,
}: Readonly<SaveStatusProps>) {
  if (isPending) {
    return (
      <div className="flex items-center gap-2 text-sm text-blue-600">
        <Loader2 size={14} className="animate-spin" />
        {t('categories.saving')}
      </div>
    )
  }
  if (isSuccess) {
    return (
      <div className="flex items-center gap-2 text-sm text-green-600">
        <Check size={14} />
        {t('categories.saved')}
      </div>
    )
  }
  return null
}

export default function CategoriesManager() {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set())
  const [companyDescription, setCompanyDescription] = useState('')
  const [deleteCategoryId, setDeleteCategoryId] = useState<string | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [editingCategory, setEditingCategory] = useState<string | null>(null)
  const [editingSubcategory, setEditingSubcategory] = useState<string | null>(null)
  const [newCategoryName, setNewCategoryName] = useState('')
  const [newSubcategoryName, setNewSubcategoryName] = useState<Record<string, string>>({})

  const {
    data: categoriesConfig, isLoading,
  } = useQuery({
    queryKey: ['categories-config'],
    queryFn: () => api.getCategoriesConfig(),
  })

  const saveMutation = useMutation({
    mutationFn: (categories: Category[]) => api.saveCategoriesConfig({ categories }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['categories-config'] })
    },
  })

  const generateMutation = useMutation({
    mutationFn: (description: string) => api.generateCategories(description),
    onSuccess: (data) => {
      saveMutation.mutate(data.categories)
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
    if (newCategoryName.trim() === '') return
    const id = crypto.randomUUID()
    const newCategory: Category = {
      id: `cat_${id}`,
      name: newCategoryName.trim().toLowerCase().replaceAll(/\s+/g, '_'),
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
    if (deleteCategoryId != null && deleteCategoryId !== '') {
      saveMutation.mutate(categories.filter((c) => c.id !== deleteCategoryId))
      setDeleteCategoryId(null)
    }
  }

  const handleUpdateCategory = (categoryId: string, updates: Partial<Category>) => {
    saveMutation.mutate(
      categories.map((c) => c.id === categoryId ? {
        ...c,
        ...updates,
      } : c),
    )
    setEditingCategory(null)
  }

  const handleAddSubcategory = (categoryId: string) => {
    const name = (newSubcategoryName[categoryId] ?? '').trim()
    if (name === '') return
    const id = crypto.randomUUID()
    const newSub: Subcategory = {
      id: `sub_${id}`,
      name: name.toLowerCase().replaceAll(/\s+/g, '_'),
      description: name,
    }
    saveMutation.mutate(
      categories.map((c) => c.id === categoryId
        ? {
          ...c,
          subcategories: [...c.subcategories, newSub],
        }
        : c,
      ),
    )
    setNewSubcategoryName((prev) => ({
      ...prev,
      [categoryId]: '',
    }))
  }

  const handleUpdateSubcategory = (categoryId: string, subcategoryId: string, newValue: string) => {
    const updated = categories.map((c) => {
      if (c.id !== categoryId) return c
      return {
        ...c,
        subcategories: c.subcategories.map((s) => {
          if (s.id !== subcategoryId) return s
          return {
            ...s,
            description: newValue,
            name: newValue.toLowerCase().replaceAll(/\s+/g, '_'),
          }
        }),
      }
    })
    saveMutation.mutate(updated)
    setEditingSubcategory(null)
  }

  const handleDeleteSubcategory = (categoryId: string, subcategoryId: string) => {
    saveMutation.mutate(
      categories.map((c) => c.id === categoryId
        ? {
          ...c,
          subcategories: c.subcategories.filter((s) => s.id !== subcategoryId),
        }
        : c,
      ),
    )
  }

  const handleGenerate = () => {
    if (companyDescription.trim() === '') return
    setIsGenerating(true)
    generateMutation.mutate(companyDescription)
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="animate-spin text-gray-400" size={24} />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* AI Generation Section */}
      <div className="bg-gradient-to-r from-purple-50 to-blue-50 rounded-lg p-3 sm:p-4 border border-purple-200">
        <div className="flex flex-col sm:flex-row sm:items-start gap-3">
          <div className="p-2 bg-purple-100 rounded-lg w-fit">
            <Sparkles className="text-purple-600" size={20} />
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="font-semibold text-gray-900 mb-1">{t('categories.aiSuggestionsTitle')}</h4>
            <p className="text-sm text-gray-600 mb-3">
              {t('categories.aiSuggestionsDescription')}
            </p>
            <textarea
              value={companyDescription}
              onChange={(e) => setCompanyDescription(e.target.value)}
              placeholder={t('categories.companyPlaceholder')}
              className="input min-h-[80px] text-sm mb-3 w-full"
            />
            <button
              onClick={handleGenerate}
              disabled={isGenerating || companyDescription.trim() === ''}
              className="btn btn-primary flex items-center justify-center gap-2 w-full sm:w-auto"
            >
              {isGenerating ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  {t('categories.generating')}
                </>
              ) : (
                <>
                  <Sparkles size={16} />
                  {t('categories.generateButton')}
                </>
              )}
            </button>
            {generateMutation.isError ? <p className="text-sm text-red-600 mt-2 flex items-center gap-1">
              <AlertCircle size={14} />
              {t('categories.generateError')}
            </p> : null}
          </div>
        </div>
      </div>

      {/* Categories List */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h4 className="font-semibold text-gray-900">{t('categories.titleLabel')}</h4>
          <span className="text-sm text-gray-500">{t('categories.categoriesCount', { count: categories.length })}</span>
        </div>

        {categories.length === 0 ? (
          <div className="text-center py-8 text-gray-500 bg-gray-50 rounded-lg border border-dashed border-gray-300">
            <p className="mb-2">{t('categories.emptyTitle')}</p>
            <p className="text-sm">{t('categories.emptyDescription')}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {categories.map((category) => (
              <div key={category.id} className="border border-gray-200 rounded-lg overflow-hidden">
                {/* Category Header */}
                <div className="flex flex-wrap items-center gap-2 p-2 sm:p-3 bg-gray-50 hover:bg-gray-100">
                  <GripVertical size={16} className="text-gray-400 cursor-grab hidden sm:block" />
                  <button
                    onClick={() => toggleExpanded(category.id)}
                    className="p-1 hover:bg-gray-200 rounded flex-shrink-0"
                  >
                    {expandedCategories.has(category.id) ? (
                      <ChevronDown size={16} />
                    ) : (
                      <ChevronRight size={16} />
                    )}
                  </button>

                  {editingCategory === category.id ? (
                    <input
                      type="text"
                      defaultValue={category.description ?? category.name}
                      onBlur={(e) => handleUpdateCategory(category.id, {
                        description: e.target.value,
                        name: e.target.value.toLowerCase().replaceAll(/\s+/g, '_'),
                      })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          handleUpdateCategory(category.id, {
                            description: e.currentTarget.value,
                            name: e.currentTarget.value.toLowerCase().replaceAll(/\s+/g, '_'),
                          })
                        }
                        if (e.key === 'Escape') setEditingCategory(null)
                      }}
                      className="flex-1 min-w-0 px-2 py-1 border border-blue-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      ref={(el) => el?.focus()}
                    />
                  ) : (
                    <button
                      type="button"
                      className="flex-1 min-w-0 font-medium text-gray-900 cursor-pointer hover:text-blue-600 truncate text-left bg-transparent border-none p-0"
                      onClick={() => setEditingCategory(category.id)}
                    >
                      {category.description ?? category.name}
                    </button>
                  )}

                  <span className="text-xs text-gray-500 bg-gray-200 px-2 py-0.5 rounded hidden sm:inline">
                    {category.name}
                  </span>
                  <span className="text-xs text-gray-400 flex-shrink-0">
                    {t('categories.subcategoriesCount', { count: category.subcategories.length })}
                  </span>
                  <button
                    onClick={() => handleDeleteCategory(category.id)}
                    className="p-1.5 sm:p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded flex-shrink-0"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                {/* Subcategories */}
                {expandedCategories.has(category.id) && (
                  <div className="p-2 sm:p-3 pl-4 sm:pl-10 space-y-2 bg-white">
                    {category.subcategories.map((sub) => (
                      <div key={sub.id} className="flex items-center gap-2 text-sm">
                        <span className="w-2 h-2 bg-gray-300 rounded-full flex-shrink-0" />
                        {editingSubcategory === sub.id ? (
                          <input
                            type="text"
                            defaultValue={sub.description ?? sub.name}
                            onBlur={(e) => handleUpdateSubcategory(category.id, sub.id, e.target.value)}
                            className="flex-1 min-w-0 px-2 py-1 border border-blue-300 rounded text-sm"
                            ref={(el) => el?.focus()}
                          />
                        ) : (
                          <button
                            type="button"
                            className="flex-1 min-w-0 text-gray-700 cursor-pointer hover:text-blue-600 truncate text-left bg-transparent border-none p-0 text-sm"
                            onClick={() => setEditingSubcategory(sub.id)}
                          >
                            {sub.description ?? sub.name}
                          </button>
                        )}
                        <span className="text-xs text-gray-400 hidden sm:inline flex-shrink-0">{sub.name}</span>
                        <button
                          onClick={() => handleDeleteSubcategory(category.id, sub.id)}
                          className="p-1.5 sm:p-1 text-gray-400 hover:text-red-600 rounded flex-shrink-0"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}

                    {/* Add Subcategory */}
                    <div className="flex items-center gap-2 mt-2">
                      <input
                        type="text"
                        value={newSubcategoryName[category.id] ?? ''}
                        onChange={(e) => setNewSubcategoryName((prev) => ({
                          ...prev,
                          [category.id]: e.target.value,
                        }))}
                        placeholder={t('categories.addSubcategoryPlaceholder')}
                        className="flex-1 min-w-0 px-2 py-1.5 sm:py-1 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleAddSubcategory(category.id)
                        }}
                      />
                      <button
                        onClick={() => handleAddSubcategory(category.id)}
                        disabled={(newSubcategoryName[category.id] ?? '').trim() === ''}
                        className="p-1.5 sm:p-1 text-blue-600 hover:bg-blue-50 rounded disabled:opacity-50 flex-shrink-0"
                      >
                        <Plus size={16} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Add New Category */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 mt-4">
          <input
            type="text"
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
            placeholder={t('categories.addCategoryPlaceholder')}
            className="flex-1 input"
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddCategory()
            }}
          />
          <button
            onClick={handleAddCategory}
            disabled={newCategoryName.trim() === '' || saveMutation.isPending}
            className="btn btn-primary flex items-center justify-center gap-2 w-full sm:w-auto"
          >
            <Plus size={16} />
            {t('categories.addCategory')}
          </button>
        </div>
      </div>

      {/* Save Status */}
      <SaveStatus isPending={saveMutation.isPending} isSuccess={saveMutation.isSuccess} t={t} />

      <ConfirmModal
        isOpen={deleteCategoryId !== null}
        title={t('categories.deleteConfirmTitle')}
        message={t('categories.deleteConfirmMessage')}
        confirmLabel={t('categories.deleteButton')}
        variant="danger"
        isLoading={saveMutation.isPending}
        onConfirm={confirmDeleteCategory}
        onCancel={() => setDeleteCategoryId(null)}
      />
    </div>
  )
}
