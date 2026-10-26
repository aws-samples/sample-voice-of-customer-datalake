/**
 * @fileoverview A select per configured dimension, parents first, where a
 * parent's value narrows its child's options and changing a parent drops a
 * child value that no longer fits. Used for dimension defaults (source
 * profiles, feedback forms, scrapers), for correcting one review, and as
 * filters.
 *
 * @module components/DimensionFields/DimensionValuesFields
 */
import { orderedDimensions, withDimensionValue } from '../../api/dimensionsSchema'
import type { Dimension } from '../../api/dimensionsSchema'
import DimensionValueSelect from './DimensionValueSelect'

interface DimensionValuesFieldsProps {
  dimensions: readonly Dimension[]
  value: Readonly<Record<string, string>>
  onChange: (value: Record<string, string>) => void
  emptyLabel: string
  disabled?: boolean
  selectClassName?: string
  className?: string
}

export default function DimensionValuesFields({
  dimensions, value, onChange, emptyLabel, disabled, selectClassName,
  className = 'grid gap-3 sm:grid-cols-2',
}: Readonly<DimensionValuesFieldsProps>) {
  if (dimensions.length === 0) return null
  return (
    <div className={className}>
      {orderedDimensions(dimensions).map((dimension) => (
        <DimensionValueSelect
          key={dimension.key}
          dimension={dimension}
          value={value[dimension.key]}
          parentValue={dimension.parent === undefined ? undefined : value[dimension.parent]}
          onChange={(next) => onChange(withDimensionValue(dimensions, value, dimension.key, next))}
          emptyLabel={emptyLabel}
          disabled={disabled}
          className={selectClassName}
        />
      ))}
    </div>
  )
}
