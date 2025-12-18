import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { 
  Plus, Trash2, Loader2, Sparkles, ChevronDown, ChevronRight,
  Check, AlertCircle, GripVertical
} from 'lucide-react'
import { api } from '../api/client'
import ConfirmModal from './ConfirmModal'

export interface Category {
  id: string
  name: string
  description?: string
  subcategories: Subcategory[]
}

export interface Subcategory {
  id: string
  name: string
  description?: string
}

export interface CategoriesConfig {
  categories: Category[]
  updated_at?: string
}

export default function CategoriesManager() {
  const queryClient = useQueryClient()
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set())
  const [companyDescription, setCompanyDescription] = useState('')
  const [deleteCategoryId, setDeleteCategoryId] = useState<string | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [editingCategory, setEditingCategory] = useState<string | null>(null)
  const [editingSubcategory, setEditingSubcategory] = useState<string | null>(null)
  const [newCategoryName, setNewCategoryName] = useState('')
  const [newSubcategoryName, setNewSubcategoryName] = useState<Record<string, string>>({})

  const { data: categoriesConfig, isLoading } = useQuery({
    queryKey: ['categories-config'],
    queryFn: () => api.getCategoriesConfig(),
  })

  const saveMutation = useMutation({
    mutationFn: (categories: Category[]) => api.saveCategoriesConfig({ categories }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['categories-config'] })
    },
  })

  const generateMutation = useMutation({
    mutationFn: (description: string) => api.generateCategories(description),
    onSuccess: (data) => {
      if (data.categories) {
        saveMutation.mutate(data.categories)
      }
      setIsGenerating(false)
    },
    onError: () => {
      setIsGenerating(false)
    },
  })

  const categories = categoriesConfig?.categories || []

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
      id: `cat_${Date.now()}`,
      name: newCategoryName.trim().toLowerCase().replace(/\s+/g, '_'),
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
      id: `sub_${Date.now()}`,
      name: name.toLowerCase().replace(/\s+/g, '_'),
      description: name,
    }
    saveMutation.mutate(
      categories.map(c => c.id === categoryId 
        ? { ...c, subcategories: [...c.subcategories, newSub] }
        : c
      )
    )
    setNewSubcategoryName(prev => ({ ...prev, [categoryId]: '' }))
  }

  const handleDeleteSubcategory = (categoryId: string, subcategoryId: string) => {
    saveMutation.mutate(
      categories.map(c => c.id === categoryId 
        ? { ...c, subcategories: c.subcategories.filter(s => s.id !== subcategoryId) }
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
        <Loader2 className="animate-spin text-gray-400" size={24} />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* AI Generation Section */}
      <div className="bg-gradient-to-r from-purple-50 to-blue-50 rounded-lg p-4 border border-purple-200">
        <div className="flex items-start gap-3">
          <div className="p-2 bg-purple-100 rounded-lg">
            <Sparkles className="text-purple-600" size={20} />
          </div>
          <div className="flex-1">
            <h4 className="font-semibold text-gray-900 mb-1">AI Category Suggestions</h4>
            <p className="text-sm text-gray-600 mb-3">
              Describe your company, industry, or product to get AI-suggested categories tailored to your business.
            </p>
            <textarea
              value={companyDescription}
              onChange={(e) => setCompanyDescription(e.target.value)}
              placeholder="e.g., We are an airline company offering domestic and international flights. Our customers care about punctuality, comfort, baggage handling, customer service, and in-flight experience..."
              className="input min-h-[80px] text-sm mb-3"
            />
            <button
              onClick={handleGenerate}
              disabled={isGenerating || !companyDescription.trim()}
              className="btn btn-primary flex items-center gap-2"
            >
              {isGenerating ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <Sparkles size={16} />
                  Generate Categories
                </>
              )}
            </button>
            {generateMutation.isError && (
              <p className="text-sm text-red-600 mt-2 flex items-center gap-1">
                <AlertCircle size={14} />
                Failed to generate categories. Please try again.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Categories List */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h4 className="font-semibold text-gray-900">Categories & Subcategories</h4>
          <span className="text-sm text-gray-500">{categories.length} categories</span>
        </div>

        {categories.length === 0 ? (
          <div className="text-center py-8 text-gray-500 bg-gray-50 rounded-lg border border-dashed border-gray-300">
            <p className="mb-2">No categories configured yet.</p>
            <p className="text-sm">Use AI generation above or add categories manually below.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {categories.map((category) => (
              <div key={category.id} className="border border-gray-200 rounded-lg overflow-hidden">
                {/* Category Header */}
                <div className="flex items-center gap-2 p-3 bg-gray-50 hover:bg-gray-100">
                  <GripVertical size={16} className="text-gray-400 cursor-grab" />
                  <button
                    onClick={() => toggleExpanded(category.id)}
                    className="p-1 hover:bg-gray-200 rounded"
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
                      defaultValue={category.description || category.name}
                      onBlur={(e) => handleUpdateCategory(category.id, { 
                        description: e.target.value,
                        name: e.target.value.toLowerCase().replace(/\s+/g, '_')
                      })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          handleUpdateCategory(category.id, { 
                            description: e.currentTarget.value,
                            name: e.currentTarget.value.toLowerCase().replace(/\s+/g, '_')
                          })
                        }
                        if (e.key === 'Escape') setEditingCategory(null)
                      }}
                      className="flex-1 px-2 py-1 border border-blue-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      autoFocus
                    />
                  ) : (
                    <span 
                      className="flex-1 font-medium text-gray-900 cursor-pointer hover:text-blue-600"
                      onClick={() => setEditingCategory(category.id)}
                    >
                      {category.description || category.name}
                    </span>
                  )}
                  
                  <span className="text-xs text-gray-500 bg-gray-200 px-2 py-0.5 rounded">
                    {category.name}
                  </span>
                  <span className="text-xs text-gray-400">
                    {category.subcategories.length} sub
                  </span>
                  <button
                    onClick={() => handleDeleteCategory(category.id)}
                    className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                {/* Subcategories */}
                {expandedCategories.has(category.id) && (
                  <div className="p-3 pl-10 space-y-2 bg-white">
                    {category.subcategories.map((sub) => (
                      <div key={sub.id} className="flex items-center gap-2 text-sm">
                        <span className="w-2 h-2 bg-gray-300 rounded-full" />
                        {editingSubcategory === sub.id ? (
                          <input
                            type="text"
                            defaultValue={sub.description || sub.name}
                            onBlur={(e) => {
                              const updated = categories.map(c => c.id === category.id 
                                ? { ...c, subcategories: c.subcategories.map(s => s.id === sub.id 
                                    ? { ...s, description: e.target.value, name: e.target.value.toLowerCase().replace(/\s+/g, '_') }
                                    : s
                                  )}
                                : c
                              )
                              saveMutation.mutate(updated)
                              setEditingSubcategory(null)
                            }}
                            className="flex-1 px-2 py-1 border border-blue-300 rounded text-sm"
                            autoFocus
                          />
                        ) : (
                          <span 
                            className="flex-1 text-gray-700 cursor-pointer hover:text-blue-600"
                            onClick={() => setEditingSubcategory(sub.id)}
                          >
                            {sub.description || sub.name}
                          </span>
                        )}
                        <span className="text-xs text-gray-400">{sub.name}</span>
                        <button
                          onClick={() => handleDeleteSubcategory(category.id, sub.id)}
                          className="p-1 text-gray-400 hover:text-red-600 rounded"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                    
                    {/* Add Subcategory */}
                    <div className="flex items-center gap-2 mt-2">
                      <input
                        type="text"
                        value={newSubcategoryName[category.id] || ''}
                        onChange={(e) => setNewSubcategoryName(prev => ({ ...prev, [category.id]: e.target.value }))}
                        placeholder="Add subcategory..."
                        className="flex-1 px-2 py-1 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleAddSubcategory(category.id)
                        }}
                      />
                      <button
                        onClick={() => handleAddSubcategory(category.id)}
                        disabled={!newSubcategoryName[category.id]?.trim()}
                        className="p-1 text-blue-600 hover:bg-blue-50 rounded disabled:opacity-50"
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
        <div className="flex items-center gap-2 mt-4">
          <input
            type="text"
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
            placeholder="Add new category..."
            className="flex-1 input"
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddCategory()
            }}
          />
          <button
            onClick={handleAddCategory}
            disabled={!newCategoryName.trim() || saveMutation.isPending}
            className="btn btn-primary flex items-center gap-2"
          >
            <Plus size={16} />
            Add Category
          </button>
        </div>
      </div>

      {/* Save Status */}
      {saveMutation.isPending && (
        <div className="flex items-center gap-2 text-sm text-blue-600">
          <Loader2 size={14} className="animate-spin" />
          Saving...
        </div>
      )}
      {saveMutation.isSuccess && (
        <div className="flex items-center gap-2 text-sm text-green-600">
          <Check size={14} />
          Categories saved successfully
        </div>
      )}

      <ConfirmModal
        isOpen={deleteCategoryId !== null}
        title="Delete Category"
        message="Are you sure you want to delete this category and all its subcategories? This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        isLoading={saveMutation.isPending}
        onConfirm={confirmDeleteCategory}
        onCancel={() => setDeleteCategoryId(null)}
      />
    </div>
  )
}
