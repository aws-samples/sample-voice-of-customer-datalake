/**
 * @fileoverview Channel, dimension and tag filters of the Categories page.
 *
 * One select per configured dimension (parents first; a parent's value narrows
 * its child's options and clears a child value that no longer fits). The
 * channel and tag options are what the window actually contains; a value from
 * a shared link that is not among them is still offered, so the select never
 * shows a filter it cannot display.
 *
 * Renders nothing when there is nothing to filter by.
 *
 * @module pages/Categories/AttributeFilterControls
 */
import { useTranslation } from 'react-i18next'
import DimensionValuesFields from '../../components/DimensionFields/DimensionValuesFields'
import type { Dimension } from '../../api/dimensionsSchema'

interface AttributeFilterControlsProps {
  readonly channels: readonly string[]
  readonly channel: string | null
  readonly onChannelChange: (channel: string | null) => void
  readonly tags: readonly string[]
  readonly tag: string | null
  readonly onTagChange: (tag: string | null) => void
  readonly dimensions: readonly Dimension[]
  readonly dimensionFilter: Readonly<Record<string, string>>
  readonly onDimensionFilterChange: (filter: Record<string, string>) => void
}

/** `options`, plus `current` when a link selected one the window does not contain. */
function withCurrent(options: readonly string[], current: string | null): readonly string[] {
  return current === null || options.includes(current) ? options : [current, ...options]
}

function OptionSelect({ label, allLabel, options, value, onChange }: Readonly<{
  label: string; allLabel: string; options: readonly string[]; value: string | null; onChange: (value: string | null) => void
}>) {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)} aria-label={label} className="select w-auto">
      <option value="">{allLabel}</option>
      {options.map((option) => <option key={option} value={option}>{option}</option>)}
    </select>
  )
}

export function AttributeFilterControls(props: AttributeFilterControlsProps) {
  const { t } = useTranslation('categories')
  const channels = withCurrent(props.channels, props.channel)
  const tags = withCurrent(props.tags, props.tag)
  if (channels.length === 0 && tags.length === 0 && props.dimensions.length === 0) return null
  return (
    <div className="flex flex-wrap items-end gap-3 sm:gap-4 mt-3 pt-3 border-t border-border" role="group" aria-label={t('attributeFilters')}>
      {channels.length > 0 && (
        <OptionSelect label={t('filterByChannel')} allLabel={t('allChannels')} options={channels} value={props.channel} onChange={props.onChannelChange} />
      )}
      <DimensionValuesFields
        dimensions={props.dimensions}
        value={props.dimensionFilter}
        onChange={props.onDimensionFilterChange}
        emptyLabel={t('anyValue')}
        selectClassName="select w-auto"
        className="contents"
      />
      {tags.length > 0 && (
        <OptionSelect label={t('filterByTag')} allLabel={t('allTags')} options={tags} value={props.tag} onChange={props.onTagChange} />
      )}
    </div>
  )
}
