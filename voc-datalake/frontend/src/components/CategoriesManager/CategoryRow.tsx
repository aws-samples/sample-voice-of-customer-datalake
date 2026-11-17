/**
 * @fileoverview One category of the Categories manager: its header row
 * (expand, rename, product badge, delete) and, when expanded, its details
 * editor and subcategory list.
 *
 * @module components/CategoriesManager/CategoryRow
 */
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, ChevronDown, ChevronRight, GripVertical, Package } from 'lucide-react'
import CategoryDetailsEditor from './CategoryDetailsEditor'
import { displayName, subcategoriesOf, toSlug } from './categoryEntries'
import { Tooltip } from '../Tooltip/Tooltip'
import type { Category, Subcategory } from './CategoriesManager'

interface SubcategoryRowProps {
  readonly sub: Subcategory
  readonly isEditing: boolean
  readonly onStartEdit: () => void
  readonly onRename: (value: string) => void
  readonly onDelete: () => void
}

function SubcategoryRow({ sub, isEditing, onStartEdit, onRename, onDelete }: SubcategoryRowProps) {
  const { t } = useTranslation('components', { keyPrefix: 'categoriesManager' })
  const name = displayName(sub)
  return (
    <div className="flex items-center gap-2 text-sm">
      <span aria-hidden="true" className="w-2 h-2 bg-border-strong rounded-full flex-shrink-0" />
      {isEditing ? (
        <input
          type="text"
          defaultValue={name}
          onBlur={(e) => onRename(e.target.value)}
          aria-label={t('renameLabel', { name })}
          className="input flex-1 min-w-0 px-2 py-1 rounded-sm"
          autoFocus
        />
      ) : (
        <Tooltip kind="description" content={t('renameHint')}>
          <button
            type="button"
            className="flex-1 min-w-0 text-left text-text hover:text-accent-text break-words [overflow-wrap:anywhere] rounded-sm focus-ring"
            onClick={onStartEdit}
          >
            {name}
          </button>
        </Tooltip>
      )}
      <Tooltip kind="label" content={t('deleteSubcategoryLabel', { name })}>
        <button
          type="button"
          onClick={onDelete}
          aria-label={t('deleteSubcategoryLabel', { name })}
          className="icon-btn hover:text-danger hover:bg-danger-subtle flex-shrink-0"
        >
          <Trash2 size={14} />
        </button>
      </Tooltip>
    </div>
  )
}

interface CategoryNameProps {
  readonly name: string
  readonly isEditing: boolean
  readonly onStartEdit: () => void
  readonly onRename: (value: string) => void
  readonly onCancelEdit: () => void
}

function CategoryName({ name, isEditing, onStartEdit, onRename, onCancelEdit }: CategoryNameProps) {
  const { t } = useTranslation('components', { keyPrefix: 'categoriesManager' })
  if (!isEditing) {
    return (
      <Tooltip kind="description" content={t('renameHint')}>
        <button
          type="button"
          className="flex-1 min-w-0 text-left font-medium text-text-strong hover:text-accent-text break-words [overflow-wrap:anywhere] rounded-sm focus-ring"
          onClick={onStartEdit}
        >
          {name}
        </button>
      </Tooltip>
    )
  }
  return (
    <input
      type="text"
      defaultValue={name}
      onBlur={(e) => onRename(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onRename(e.currentTarget.value)
        if (e.key === 'Escape') onCancelEdit()
      }}
      aria-label={t('renameLabel', { name })}
      className="input flex-1 min-w-0 px-2 py-1 rounded-sm"
      autoFocus
    />
  )
}

interface AddSubcategoryProps {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly onAdd: () => void
}

function AddSubcategory({ value, onChange, onAdd }: AddSubcategoryProps) {
  const { t } = useTranslation('components', { keyPrefix: 'categoriesManager' })
  return (
    <div className="flex items-center gap-2 mt-2">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('addSubcategoryPlaceholder')}
        aria-label={t('addSubcategoryLabel')}
        className="input flex-1 min-w-0 py-1.5"
        onKeyDown={(e) => {
          if (e.key === 'Enter') onAdd()
        }}
      />
      <Tooltip kind="label" content={t('addSubcategoryLabel')}>
        <button
          type="button"
          onClick={onAdd}
          disabled={!value.trim()}
          aria-label={t('addSubcategoryLabel')}
          className="icon-btn text-accent-text hover:bg-accent-subtle disabled:opacity-40 flex-shrink-0"
        >
          <Plus size={16} />
        </button>
      </Tooltip>
    </div>
  )
}

export interface CategoryRowProps {
  readonly category: Category
  readonly isOpen: boolean
  readonly saving: boolean
  readonly isEditing: boolean
  readonly editingSubcategoryId: string | null
  readonly newSubcategoryName: string
  readonly onToggle: () => void
  readonly onStartEdit: () => void
  readonly onCancelEdit: () => void
  readonly onUpdate: (updates: Partial<Category>) => void
  readonly onDelete: () => void
  readonly onStartEditSubcategory: (subcategoryId: string) => void
  readonly onRenameSubcategory: (subcategoryId: string, value: string) => void
  readonly onDeleteSubcategory: (subcategoryId: string) => void
  readonly onNewSubcategoryNameChange: (value: string) => void
  readonly onAddSubcategory: () => void
}

export default function CategoryRow(props: CategoryRowProps) {
  const { t } = useTranslation('components', { keyPrefix: 'categoriesManager' })
  const { category, isOpen } = props
  const name = displayName(category)
  const subcategories = subcategoriesOf(category)
  const toggleLabel = isOpen ? t('collapseLabel', { name }) : t('expandLabel', { name })
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 p-2 sm:p-3 bg-bg-accent hover:bg-bg-hover">
        <GripVertical size={16} aria-hidden="true" className="text-muted cursor-grab hidden sm:block" />
        <Tooltip kind="label" content={toggleLabel}>
          <button
            type="button"
            onClick={props.onToggle}
            aria-expanded={isOpen}
            aria-label={toggleLabel}
            className="icon-btn flex-shrink-0"
          >
            {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
        </Tooltip>

        <CategoryName
          name={name}
          isEditing={props.isEditing}
          onStartEdit={props.onStartEdit}
          onCancelEdit={props.onCancelEdit}
          onRename={(value) => props.onUpdate({ description: value, name: toSlug(value) })}
        />

        {category.product === undefined ? (
          <span className="badge badge-warn flex-shrink-0">{t('noProduct')}</span>
        ) : (
          <Tooltip kind="description" content={t('details.productLabel')}>
            <span className="badge badge-muted flex-shrink-0">
              <Package size={12} aria-hidden="true" />
              {category.product}
            </span>
          </Tooltip>
        )}
        <span className="text-xs text-muted flex-shrink-0">
          {t('subCount', { count: subcategories.length })}
        </span>
        <Tooltip kind="label" content={t('deleteCategoryLabel', { name })}>
          <button
            type="button"
            onClick={props.onDelete}
            aria-label={t('deleteCategoryLabel', { name })}
            className="icon-btn hover:text-danger hover:bg-danger-subtle flex-shrink-0"
          >
            <Trash2 size={14} />
          </button>
        </Tooltip>
      </div>

      {isOpen && (
        <div className="p-2 sm:p-3 pl-4 sm:pl-10 space-y-2 bg-card">
          <CategoryDetailsEditor category={category} disabled={props.saving} onChange={props.onUpdate} />
          {subcategories.map((sub) => (
            <SubcategoryRow
              key={sub.id}
              sub={sub}
              isEditing={props.editingSubcategoryId === sub.id}
              onStartEdit={() => props.onStartEditSubcategory(sub.id)}
              onRename={(value) => props.onRenameSubcategory(sub.id, value)}
              onDelete={() => props.onDeleteSubcategory(sub.id)}
            />
          ))}
          <AddSubcategory
            value={props.newSubcategoryName}
            onChange={props.onNewSubcategoryNameChange}
            onAdd={props.onAddSubcategory}
          />
        </div>
      )}
    </div>
  )
}
