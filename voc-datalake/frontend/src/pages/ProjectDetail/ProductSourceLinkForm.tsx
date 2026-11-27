/**
 * @fileoverview "Add link" on the Sources card (7.104.00): one public https page as a source. The browser checks the
 * scheme and the length (2,048 characters) before the request; the server checks the rest (a public address, no
 * sign-in, every redirect) and says why it refused.
 *
 * @module pages/ProjectDetail/ProductSourceLinkForm
 */
import { useId, useState } from 'react'
import { Link2, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { serverReason } from '../../lib/errors'

/** = shared/product_source_routes.py's URL cap (7.104.00). */
const MAX_URL_CHARS = 2048

/** Why `value` is not a link to add, as a locale key, or null. */
function linkProblem(value: string): string | null {
  if (value.length > MAX_URL_CHARS) return 'product.sources.link.tooLong'
  try {
    return new URL(value).protocol === 'https:' ? null : 'product.sources.link.invalid'
  } catch {
    return 'product.sources.link.invalid'
  }
}

export default function ProductSourceLinkForm({ onAdd }: Readonly<{ onAdd: (url: string) => Promise<unknown> }>) {
  const { t } = useTranslation('projectDetail')
  const inputId = useId()
  const [value, setValue] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault()
    const url = value.trim()
    const invalid = linkProblem(url)
    if (invalid !== null) {
      setProblem(t(invalid))
      return
    }
    setBusy(true)
    setProblem(null)
    try {
      await onAdd(url)
      setValue('')
    } catch (error: unknown) {
      setProblem(t('product.sources.errors.linkFailed', { message: serverReason(error) ?? t('product.sources.errors.tryAgain') }))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="space-y-1" onSubmit={(event) => { void submit(event) }} noValidate>
      <label htmlFor={inputId} className="block text-[12px] font-medium text-muted">{t('product.sources.link.label')}</label>
      <div className="flex gap-2">
        <input id={inputId} type="url" inputMode="url" className="input min-w-0 flex-1" value={value} disabled={busy}
          placeholder={t('product.sources.link.placeholder')} aria-describedby={problem === null ? undefined : `${inputId}-problem`}
          onChange={(event) => setValue(event.target.value)} />
        <button type="submit" className="btn btn-secondary" disabled={busy || value.trim() === ''}>
          {busy ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Link2 size={14} aria-hidden="true" />}
          {t(busy ? 'product.sources.link.adding' : 'product.sources.link.add')}
        </button>
      </div>
      {problem === null ? null : <p id={`${inputId}-problem`} role="alert" className="text-xs text-danger">{problem}</p>}
    </form>
  )
}
