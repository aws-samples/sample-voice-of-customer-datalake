/**
 * @fileoverview A tag input for company email domains: type a domain and press Enter (or
 * a comma) to add it as a chip; each chip has a remove button. Domains are lower-cased,
 * de-duplicated and checked before they become a chip (an `@` prefix is dropped).
 * @module pages/Settings/DomainChipsInput
 */
import { useId, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { isPlausibleDomain } from '../Participants/participantInput'

/** A typed domain as stored: trimmed, lower-case, without a leading `@`. */
function normalizeDomain(value: string): string {
  const trimmed = value.trim().toLowerCase()
  return trimmed.startsWith('@') ? trimmed.slice(1) : trimmed
}

export default function DomainChipsInput({ label, domains, max, disabled, onChange }: Readonly<{
  label: string
  domains: readonly string[]
  max: number
  disabled: boolean
  onChange: (domains: string[]) => void
}>) {
  const { t } = useTranslation('participants')
  const inputId = useId()
  const errorId = useId()
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)

  /** Why `domain` cannot become a chip, or null when it can. */
  const domainProblem = (domain: string): string | null => {
    if (!isPlausibleDomain(domain)) return t('settings.domainInvalid', { domain })
    if (domains.includes(domain)) return t('settings.domainDuplicate', { domain })
    if (domains.length >= max) return t('settings.domainMax', { count: max })
    return null
  }
  const commit = () => {
    const domain = normalizeDomain(typed)
    if (domain === '') return
    const problem = domainProblem(domain)
    if (problem !== null) {
      setError(problem)
      return
    }
    onChange([...domains, domain])
    setTyped('')
    setError(null)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' && e.key !== ',') return
    e.preventDefault()
    commit()
  }

  return (
    <div className="space-y-1">
      <label htmlFor={inputId} className="block text-sm font-medium text-text">{label}</label>
      <div className="flex flex-wrap items-center gap-1 rounded-md border border-border p-1.5">
        {domains.map((domain) => (
          <span key={domain} className="badge badge-muted flex items-center gap-1 font-mono">
            {domain}
            {disabled ? null : (
              <button type="button" onClick={() => onChange(domains.filter((d) => d !== domain))}
                aria-label={t('settings.removeDomain', { domain })}>
                <X size={12} aria-hidden />
              </button>
            )}
          </span>
        ))}
        <input id={inputId} value={typed} disabled={disabled} placeholder={t('settings.domainPlaceholder')}
          onChange={(e) => { setTyped(e.target.value); setError(null) }} onKeyDown={onKeyDown} onBlur={commit}
          aria-invalid={error !== null} aria-describedby={error === null ? undefined : errorId}
          className="min-w-[10rem] flex-1 bg-transparent px-1 py-0.5 text-sm text-text outline-none" />
      </div>
      {error === null ? null : <p id={errorId} className="text-xs text-danger">{error}</p>}
    </div>
  )
}
