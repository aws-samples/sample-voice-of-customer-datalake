/**
 * @fileoverview A library item's details, edited: its title, short name, source, date, tags and (outside a
 * workspace) its project. Saved with the version it was opened at (`expected_version`): when someone changed it
 * meanwhile the server answers 409 `stale`, the editor says so and offers to reload it; a short name another item
 * has is said beside the field.
 *
 * @module pages/Library/ItemEditor
 */
import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2, RefreshCw } from 'lucide-react'
import Notice from '../../components/Notice/Notice'
import { libraryApi, libraryKeys } from '../../api/libraryApi'
import type { LibraryEditBody } from '../../api/libraryApi'
import type { LibraryItem } from '../../api/librarySchema'
import { failureText, libraryFailure } from './libraryErrors'
import { isSlug, parseTags, tagsProblem } from './libraryFormats'
import type { ProjectOption } from './libraryFilters'

interface EditFields {
  readonly title: string
  readonly slug: string
  readonly source: string
  readonly docDate: string
  readonly tags: string
  readonly projectId: string
}

const fieldsOf = (item: LibraryItem): EditFields => ({
  title: item.title, slug: item.slug, source: item.source, docDate: item.doc_date, tags: item.tags.join(', '),
  projectId: item.project_id ?? '',
})

const sameTags = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((tag, index) => tag === b[index])

/** Only what changed, with the version it was opened at. */
function changesOf(item: LibraryItem, fields: EditFields): LibraryEditBody {
  const tags = parseTags(fields.tags)
  return {
    expected_version: item.version,
    ...(fields.title.trim() === item.title ? {} : { title: fields.title.trim() }),
    ...(fields.slug.trim() === item.slug ? {} : { slug: fields.slug.trim() }),
    ...(fields.source.trim() === item.source ? {} : { source: fields.source.trim() }),
    ...(fields.docDate === item.doc_date ? {} : { doc_date: fields.docDate }),
    ...(sameTags(tags, item.tags) ? {} : { tags }),
    ...(fields.projectId === (item.project_id ?? '') ? {} : { project_id: fields.projectId }),
  }
}

function invalid(fields: EditFields): boolean {
  return fields.title.trim() === '' || !isSlug(fields.slug.trim()) || tagsProblem(parseTags(fields.tags)) !== null
}

function Field({ label, hint, children }: Readonly<{ label: string; hint?: string; children: (id: string, hintId: string) => ReactNode }>) {
  const id = useId()
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-[12px] font-medium text-muted">{label}</label>
      {children(id, `${id}-hint`)}
      {hint === undefined ? null : <p id={`${id}-hint`} className="text-[12px] text-muted">{hint}</p>}
    </div>
  )
}

export default function ItemEditor({ item, projects, onDone, onReload }: Readonly<{
  item: LibraryItem
  projects: readonly ProjectOption[] | null
  onDone: () => void
  /** Read the item again (after a 409 `stale`); the editor starts again from what it reads. */
  onReload: () => Promise<unknown>
}>) {
  const { t } = useTranslation('library')
  const queryClient = useQueryClient()
  const [fields, setFields] = useState<EditFields>(() => fieldsOf(item))
  const set = (change: Partial<EditFields>) => setFields((current) => ({ ...current, ...change }))
  const save = useMutation({
    mutationFn: (body: LibraryEditBody) => libraryApi.update(item.item_id, body),
    onSuccess: async (saved) => {
      queryClient.setQueryData(libraryKeys.item(item.item_id), (detail: unknown) => (
        typeof detail === 'object' && detail !== null ? { ...detail, item: saved } : detail))
      await queryClient.invalidateQueries({ queryKey: libraryKeys.all })
      onDone()
    },
  })
  const failure = save.error === null ? null : libraryFailure(save.error)
  const submit = () => {
    const body = changesOf(item, fields)
    if (Object.keys(body).length === 1) onDone()
    else save.mutate(body)
  }
  const reload = async () => {
    await onReload()
    save.reset()
  }
  const disabled = save.isPending
  return (
    <form className="space-y-3" aria-label={t('edit.label')} onSubmit={(event) => { event.preventDefault(); submit() }}>
      <Field label={t('fields.title')}>
        {(id) => <input id={id} className="input" value={fields.title} maxLength={200} required disabled={disabled}
          onChange={(event) => set({ title: event.target.value })} />}
      </Field>
      <Field label={t('fields.slug')} hint={failure === 'slugTaken' ? failureText(t, failure) : t('fields.slugHint')}>
        {(id, hintId) => <input id={id} className="input font-mono" value={fields.slug} maxLength={64} required disabled={disabled}
          aria-describedby={hintId} aria-invalid={failure === 'slugTaken' || !isSlug(fields.slug.trim())}
          onChange={(event) => set({ slug: event.target.value.toLowerCase() })} />}
      </Field>
      <Field label={t('fields.source')}>
        {(id) => <input id={id} className="input" value={fields.source} maxLength={200} disabled={disabled}
          onChange={(event) => set({ source: event.target.value })} />}
      </Field>
      <Field label={t('fields.docDate')}>
        {(id) => <input id={id} type="date" className="input" value={fields.docDate} disabled={disabled}
          onChange={(event) => set({ docDate: event.target.value })} />}
      </Field>
      <Field label={t('fields.tags')} hint={t('fields.tagsHint')}>
        {(id, hintId) => <input id={id} className="input" value={fields.tags} disabled={disabled} aria-describedby={hintId}
          onChange={(event) => set({ tags: event.target.value })} />}
      </Field>
      {projects === null ? null : (
        <Field label={t('fields.project')}>
          {(id) => (
            <select id={id} className="select" value={fields.projectId} disabled={disabled} onChange={(event) => set({ projectId: event.target.value })}>
              <option value="">{t('fields.noProject')}</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          )}
        </Field>
      )}
      {failure === 'stale' ? (
        <Notice variant="banner" tone="warn" role="alert" icon={RefreshCw} text={failureText(t, failure)}
          action={{ label: t('edit.reload'), icon: RefreshCw, onClick: () => void reload() }} />
      ) : null}
      {failure !== null && failure !== 'stale' && failure !== 'slugTaken'
        ? <p role="alert" className="text-sm text-danger">{failureText(t, failure)}</p>
        : null}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="btn btn-secondary" onClick={onDone} disabled={disabled}>{t('edit.cancel')}</button>
        <button type="submit" className="btn btn-primary" disabled={disabled || invalid(fields)}>
          {disabled ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}{t('edit.save')}
        </button>
      </div>
    </form>
  )
}
