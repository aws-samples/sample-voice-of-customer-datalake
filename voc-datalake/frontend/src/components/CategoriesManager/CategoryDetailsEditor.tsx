/**
 * @fileoverview Product + product-owner fields of one category.
 *
 * A category maps to the product it belongs to and to the people accountable
 * for it. Owners automatically see their categories' feedback (resolved by the
 * backend's category-access policy), so picking an owner here is also a grant —
 * the hint says so. Owners are picked from the admin users list, never typed,
 * because a grant is keyed by the Cognito `sub` the list carries.
 *
 * @module components/CategoriesManager/CategoryDetailsEditor
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { UserPlus, X } from 'lucide-react'
import { api } from '../../api/client'
import { normalizeOwnerCandidates } from './categoriesSchema'
import type { Category, CategoryOwner } from './CategoriesManager'

/** Server-side limits (contract C), mirrored so the editor refuses before the route does. */
const MAX_PRODUCT_LENGTH = 120
const MAX_OWNERS = 20

/** Same key and fetcher as Settings → Users, so the two share one cached list. */
const USERS_KEY = ['users'] as const

type CategoryDetails = Pick<Category, 'product' | 'owners'>

interface CategoryDetailsEditorProps {
  readonly category: Category
  readonly disabled: boolean
  readonly onChange: (updates: CategoryDetails) => void
}

function ownerLabel(owner: CategoryOwner): string {
  return owner.username === '' ? owner.email : owner.username
}

function useOwnerCandidates() {
  return useQuery({
    queryKey: USERS_KEY,
    queryFn: () => api.getUsers(),
    select: (data) => normalizeOwnerCandidates(Array.isArray(data.users) ? data.users : []),
  })
}

function ProductField({ stored, disabled, onCommit }: Readonly<{
  stored: string
  disabled: boolean
  onCommit: (product: string | undefined) => void
}>) {
  const { t } = useTranslation('components', { keyPrefix: 'categoriesManager.details' })
  const id = useId()
  const [product, setProduct] = useState(stored)
  const commit = () => {
    const next = product.trim()
    if (next !== stored) onCommit(next === '' ? undefined : next)
  }
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-text-strong mb-1">{t('productLabel')}</label>
      <input
        id={id}
        type="text"
        value={product}
        maxLength={MAX_PRODUCT_LENGTH}
        disabled={disabled}
        onChange={(e) => setProduct(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
        placeholder={t('productPlaceholder')}
        className="input py-1.5 text-sm"
      />
      <p className="text-xs text-muted mt-1">{t('productHint')}</p>
    </div>
  )
}

function OwnerChips({ owners, disabled, onRemove }: Readonly<{
  owners: CategoryOwner[]
  disabled: boolean
  onRemove: (sub: string) => void
}>) {
  const { t } = useTranslation('components', { keyPrefix: 'categoriesManager.details' })
  if (owners.length === 0) return null
  return (
    <ul className="flex flex-wrap gap-1.5 mb-2" aria-label={t('ownersLabel')}>
      {owners.map((owner) => {
        const label = t('removeOwner', { name: ownerLabel(owner) })
        return (
          <li key={owner.sub} className="badge badge-accent gap-1" title={owner.email}>
            {ownerLabel(owner)}
            <button
              type="button"
              onClick={() => onRemove(owner.sub)}
              disabled={disabled}
              aria-label={label}
              title={label}
              className="rounded-full hover:text-danger focus-ring"
            >
              <X size={12} aria-hidden="true" />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function OwnersField({ owners, disabled, onChange }: Readonly<{
  owners: CategoryOwner[]
  disabled: boolean
  onChange: (owners: CategoryOwner[]) => void
}>) {
  const { t } = useTranslation('components', { keyPrefix: 'categoriesManager.details' })
  const id = useId()
  const { data: candidates = [], isError } = useOwnerCandidates()
  const available = candidates.filter((c) => !owners.some((o) => o.sub === c.sub))
  const atLimit = owners.length >= MAX_OWNERS

  const add = (sub: string) => {
    const owner = available.find((c) => c.sub === sub)
    if (owner !== undefined && !atLimit) onChange([...owners, owner])
  }

  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-text-strong mb-1">{t('ownersLabel')}</label>
      <OwnerChips owners={owners} disabled={disabled} onRemove={(sub) => onChange(owners.filter((o) => o.sub !== sub))} />
      <div className="flex items-center gap-2">
        <UserPlus size={14} className="text-muted flex-shrink-0" aria-hidden="true" />
        <select
          id={id}
          value=""
          disabled={disabled || atLimit || available.length === 0}
          onChange={(e) => add(e.target.value)}
          className="select select-sm flex-1 min-w-0"
        >
          <option value="">{atLimit ? t('ownersLimit', { max: MAX_OWNERS }) : t('addOwner')}</option>
          {available.map((c) => (
            <option key={c.sub} value={c.sub}>{c.email === '' ? ownerLabel(c) : `${ownerLabel(c)} — ${c.email}`}</option>
          ))}
        </select>
      </div>
      <p className="text-xs text-muted mt-1">{isError ? t('ownersUnavailable') : t('ownersHint')}</p>
    </div>
  )
}

export default function CategoryDetailsEditor({ category, disabled, onChange }: CategoryDetailsEditorProps) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 pb-3 mb-1 border-b border-border">
      <ProductField
        stored={category.product ?? ''}
        disabled={disabled}
        onCommit={(product) => onChange({ product, owners: category.owners })}
      />
      <OwnersField
        owners={category.owners ?? []}
        disabled={disabled}
        onChange={(owners) => onChange({ product: category.product, owners })}
      />
    </div>
  )
}
