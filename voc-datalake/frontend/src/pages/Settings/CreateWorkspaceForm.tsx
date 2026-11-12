/**
 * @fileoverview Create a workspace (platform console; `POST /platform/workspaces`): a name and a slug, checked here
 * by the server's own rules before sending (`isWorkspaceSlug`: 3 to 40 of a-z, 0-9 and "-", not starting or ending
 * with "-", not a reserved word; a name of 1 to 80 characters). The slug is the workspace's address, `/w/{slug}/`,
 * fixed once made; the server answers 409 when another workspace has it.
 *
 * @module pages/Settings/CreateWorkspaceForm
 */
import { useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import { WORKSPACE_NAME_MAX } from '../../api/platformWorkspacesApi'
import type { CreatedWorkspace } from '../../api/platformWorkspacesApi'
import { SLUG_MAX_LENGTH } from '../../workspace/workspacePath'
import { workspaceDraftProblems } from './workspaceDraft'
import type { DraftProblem } from './workspaceDraft'

interface CreateWorkspaceFormProps {
  readonly busy: boolean
  readonly onCreate: (name: string, slug: string) => Promise<CreatedWorkspace>
  readonly onCreated: (workspace: CreatedWorkspace) => void
}

export default function CreateWorkspaceForm({ busy, onCreate, onCreated }: CreateWorkspaceFormProps) {
  const { t } = useTranslation()
  const ids = { title: useId(), name: useId(), slug: useId(), slugHint: useId(), nameError: useId(), slugError: useId() }
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [shown, setShown] = useState<DraftProblem[]>([])
  const nameRef = useRef<HTMLInputElement>(null)
  const slugRef = useRef<HTMLInputElement>(null)

  const submit = () => {
    // Spaces around a pasted slug are not part of it.
    const address = slug.trim()
    const problems = workspaceDraftProblems(name, address)
    // The errors are rendered (each named as its field's description) before focus moves to the first, so it is read.
    flushSync(() => setShown(problems))
    const [first] = problems
    if (first !== undefined) {
      (first === 'name' ? nameRef : slugRef).current?.focus()
      return
    }
    onCreate(name.trim(), address).then((workspace) => {
      setName('')
      setSlug('')
      onCreated(workspace)
    }, () => {
      // The section shows the refusal (a slug taken meanwhile); the draft stays to correct.
    })
  }

  const nameInvalid = shown.includes('name')
  const slugInvalid = shown.includes('slug')
  return (
    <form className="space-y-3 rounded-lg border border-border p-4" noValidate aria-labelledby={ids.title}
      onSubmit={(event) => { event.preventDefault(); submit() }}>
      <h3 id={ids.title} className="text-sm font-semibold tracking-tight text-text-strong">{t('workspaces.platform.createTitle')}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1 text-sm text-text">
          <label htmlFor={ids.name}>{t('workspaces.platform.name')}</label>
          <input ref={nameRef} id={ids.name} className="input" value={name} maxLength={WORKSPACE_NAME_MAX} autoComplete="off"
            aria-invalid={nameInvalid} aria-describedby={nameInvalid ? ids.nameError : undefined}
            onChange={(event) => setName(event.target.value)} />
          {nameInvalid ? <span id={ids.nameError} className="text-xs text-danger">{t('workspaces.platform.nameInvalid', { max: WORKSPACE_NAME_MAX })}</span> : null}
        </div>
        <div className="flex min-w-0 flex-col gap-1 text-sm text-text">
          <label htmlFor={ids.slug}>{t('workspaces.platform.slug')}</label>
          <input ref={slugRef} id={ids.slug} className="input font-mono" value={slug} maxLength={SLUG_MAX_LENGTH} autoComplete="off"
            spellCheck={false} autoCapitalize="none"
            aria-invalid={slugInvalid} aria-describedby={slugInvalid ? `${ids.slugError} ${ids.slugHint}` : ids.slugHint}
            onChange={(event) => setSlug(event.target.value)} />
          <span id={ids.slugHint} className="text-xs text-muted">{t('workspaces.platform.slugHint')}</span>
          {slugInvalid ? <span id={ids.slugError} className="text-xs text-danger">{t('workspaces.platform.slugInvalid')}</span> : null}
        </div>
      </div>
      <button type="submit" className="btn btn-primary gap-2 justify-center" disabled={busy}>
        <Plus size={16} aria-hidden="true" />
        {t('workspaces.platform.create')}
      </button>
    </form>
  )
}
