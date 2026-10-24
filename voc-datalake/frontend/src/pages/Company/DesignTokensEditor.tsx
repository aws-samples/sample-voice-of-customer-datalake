/**
 * @fileoverview The design-token editor: colours (with live swatches),
 * typography, spacing and radius. Read-only when `readOnly`.
 *
 * Swatches paint the company's OWN colours, which are user-chosen data — the
 * one place the Kiro design system allows an arbitrary colour (see "Out of
 * scope" in docs/kiro-design-system.md). A value that is not a recognisable CSS
 * colour shows a hatched "invalid" swatch instead of being painted.
 *
 * @module pages/Company/DesignTokensEditor
 */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'
import clsx from 'clsx'
import { isPaintableColor } from '../../api/designSystemApi'
import type { DesignTokens, NamedValue, TypographyToken } from '../../api/designSystemApi'
import { GroupLabel } from './ContextParts'

const MAX_ROWS = 40

type ScaleKey = 'colors' | 'spacing' | 'radius'

interface EditorProps {
  readonly tokens: DesignTokens
  readonly readOnly: boolean
  readonly onChange: (change: (tokens: DesignTokens) => DesignTokens) => void
}

export default function DesignTokensEditor({ tokens, readOnly, onChange }: EditorProps) {
  const { t } = useTranslation('settings')
  return (
    <div className="space-y-5">
      <NamedValueGroup scale="colors" label={t('designSystem.colors')} tokens={tokens} readOnly={readOnly} onChange={onChange} />
      <TypographyGroup tokens={tokens} readOnly={readOnly} onChange={onChange} />
      <div className="grid gap-5 lg:grid-cols-2">
        <NamedValueGroup scale="spacing" label={t('designSystem.spacing')} tokens={tokens} readOnly={readOnly} onChange={onChange} />
        <NamedValueGroup scale="radius" label={t('designSystem.radius')} tokens={tokens} readOnly={readOnly} onChange={onChange} />
      </div>
    </div>
  )
}

function Swatch({ value }: Readonly<{ value: string }>) {
  const { t } = useTranslation('settings')
  const paintable = isPaintableColor(value)
  return (
    <span
      role="img"
      aria-label={paintable ? t('designSystem.swatch', { value }) : t('designSystem.invalidColor')}
      title={paintable ? value : t('designSystem.invalidColor')}
      className={clsx('w-8 h-8 rounded-md border border-border-strong flex-shrink-0', !paintable && 'bg-bg-hover bg-[repeating-linear-gradient(45deg,transparent_0_4px,var(--border)_4px_6px)]')}
      style={paintable ? { backgroundColor: value.trim() } : undefined}
    />
  )
}

function NamedValueGroup({ scale, label, tokens, readOnly, onChange }: EditorProps & { readonly scale: ScaleKey; readonly label: string }) {
  const { t } = useTranslation('settings')
  const rows = tokens[scale]
  const set = (i: number, patch: Partial<NamedValue>) =>
    onChange((tk) => ({ ...tk, [scale]: tk[scale].map((r, j) => (j === i ? { ...r, ...patch } : r)) }))
  const remove = (i: number) => onChange((tk) => ({ ...tk, [scale]: tk[scale].filter((_, j) => j !== i) }))
  const add = () => onChange((tk) => ({ ...tk, [scale]: [...tk[scale], { name: '', value: '' }] }))

  return (
    <TokenGroup label={label} count={rows.length} readOnly={readOnly} onAdd={add}>
      {rows.map((row, i) => (
        <li key={i} className="flex items-center gap-2">
          {scale === 'colors' ? <Swatch value={row.value} /> : null}
          {readOnly ? (
            <span className="flex-1 text-sm text-text-strong">{row.name} <span className="font-mono text-muted ml-2">{row.value}</span></span>
          ) : (
            <>
              <TokenInput label={t('designSystem.tokenName')} value={row.name} onValue={(name) => set(i, { name })} className="flex-1 min-w-0" />
              <TokenInput label={t('designSystem.tokenValue')} placeholder={scale === 'colors' ? '#8e48ff' : '8px'} value={row.value} onValue={(value) => set(i, { value })} className="w-32 sm:w-40 font-mono" />
              <RemoveTokenButton onRemove={() => remove(i)} />
            </>
          )}
        </li>
      ))}
    </TokenGroup>
  )
}

function TypographyGroup({ tokens, readOnly, onChange }: EditorProps) {
  const { t } = useTranslation('settings')
  const rows = tokens.typography
  const set = (i: number, patch: Partial<TypographyToken>) =>
    onChange((tk) => ({ ...tk, typography: tk.typography.map((r, j) => (j === i ? { ...r, ...patch } : r)) }))
  const remove = (i: number) => onChange((tk) => ({ ...tk, typography: tk.typography.filter((_, j) => j !== i) }))
  const add = () => onChange((tk) => ({ ...tk, typography: [...tk.typography, { role: '', family: '', size: undefined, weight: undefined }] }))
  const optional = (value: string) => (value === '' ? undefined : value)

  return (
    <TokenGroup label={t('designSystem.typography')} count={rows.length} readOnly={readOnly} onAdd={add}>
      {rows.map((row, i) => (
        <li key={i} className="flex flex-col sm:flex-row sm:items-center gap-2">
          {readOnly ? (
            <span className="text-sm text-text-strong">
              {row.role} <span className="font-mono text-muted ml-2">{[row.family, row.size, row.weight].filter(Boolean).join(' · ')}</span>
            </span>
          ) : (
            <>
              <TokenInput label={t('designSystem.typeRole')} value={row.role} onValue={(role) => set(i, { role })} className="sm:w-36" />
              <TokenInput label={t('designSystem.typeFamily')} value={row.family} onValue={(family) => set(i, { family })} className="flex-1 min-w-0" />
              <TokenInput label={t('designSystem.typeSize')} placeholder="16px" value={row.size ?? ''} onValue={(size) => set(i, { size: optional(size) })} className="sm:w-24 font-mono" />
              <TokenInput label={t('designSystem.typeWeight')} placeholder="600" value={row.weight ?? ''} onValue={(weight) => set(i, { weight: optional(weight) })} className="sm:w-20 font-mono" />
              <RemoveTokenButton onRemove={() => remove(i)} className="self-end sm:self-center" />
            </>
          )}
        </li>
      ))}
    </TokenGroup>
  )
}

/** One token group: its label, the empty note, the rows and (when editable) the add button. */
function TokenGroup({ label, count, readOnly, onAdd, children }: Readonly<{
  label: string
  count: number
  readOnly: boolean
  onAdd: () => void
  children: ReactNode
}>) {
  const { t } = useTranslation('settings')
  return (
    <div>
      <GroupLabel>{label}</GroupLabel>
      {count === 0 ? <p className="text-sm text-muted italic">{t('designSystem.noTokens')}</p> : null}
      <ul className="space-y-2">{children}</ul>
      {readOnly ? null : <AddRowButton onAdd={onAdd} full={count >= MAX_ROWS} />}
    </div>
  )
}

/** A token text field; the placeholder defaults to its accessible label. */
function TokenInput({ label, placeholder = label, value, onValue, className }: Readonly<{
  label: string
  placeholder?: string
  value: string | number
  onValue: (value: string) => void
  className: string
}>) {
  return (
    <input aria-label={label} placeholder={placeholder} value={value} onChange={(e) => onValue(e.target.value)} className={clsx('input', className)} />
  )
}

function RemoveTokenButton({ onRemove, className }: Readonly<{ onRemove: () => void; className?: string }>) {
  const { t } = useTranslation('settings')
  return (
    <button type="button" onClick={onRemove} className={clsx('icon-btn', className)} aria-label={t('designSystem.removeToken')} title={t('designSystem.removeToken')}><X size={16} /></button>
  )
}

function AddRowButton({ onAdd, full }: Readonly<{ onAdd: () => void; full: boolean }>) {
  const { t } = useTranslation('settings')
  return (
    <button type="button" onClick={onAdd} disabled={full} className="btn btn-ghost btn-sm flex items-center gap-1.5 mt-2">
      <Plus size={14} /> {t('designSystem.addToken')}
    </button>
  )
}
