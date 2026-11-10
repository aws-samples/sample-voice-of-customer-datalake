/**
 * @fileoverview "Promote to project" (admin, app session only): pick an existing project or create
 * one, then add every supporter and contact to the request's participant list linked to it.
 *
 * Projects are read and created through the app's own projects API: promoting needs an app
 * session, which is why board-pool users (never admins) never see this panel.
 *
 * @module pages/FeatureRequests/PromotePanel
 */
import { useQuery } from '@tanstack/react-query'
import { FolderPlus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { projectsApi } from '../../api/projectsApi'
import { projectsKey } from '../../api/projectQueryKeys'
import { LabeledField } from '../../components/LabeledField/LabeledField'
import WriteError from './WriteError'
import { useBoardWrite } from './useBoardQueries'
import type { FeatureRequest, PromoteResult } from '../../api/featureRequestsApi'
import { SKIP_REASON_LABELS } from './boardLabels'

const NEW_PROJECT = '__new__'

/** Creates the project first when the admin asked for a new one; answers its id. */
async function projectIdFor(choice: string, newName: string): Promise<string> {
  if (choice !== NEW_PROJECT) return choice
  const created = await projectsApi.createProject({ name: newName.trim() })
  if (!created.project) throw new Error('The project was not created')
  return created.project.project_id
}

function PromoteOutcome({ result }: Readonly<{ result: PromoteResult }>) {
  const { t } = useTranslation('featureRequests')
  const reasonText = (reason: string) => {
    const label = SKIP_REASON_LABELS[reason]
    return label === undefined ? reason : t(label.labelKey)
  }
  return (
    <div role="status" className="text-xs text-text space-y-1">
      <p>{t('promote.done', { count: result.added, list: result.list.name })}</p>
      {result.skipped.length === 0 ? null : (
        <>
          <p className="text-muted">{t('promote.skipped', { count: result.skipped.length })}</p>
          <ul className="list-disc pl-5 text-muted">
            {result.skipped.map((row) => (
              <li key={row.email} className="break-all">{t('promote.skippedRow', { email: row.email, reason: reasonText(row.reason) })}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

export default function PromotePanel({ request }: Readonly<{ request: FeatureRequest }>) {
  const { t } = useTranslation('featureRequests')
  const projects = useQuery({ queryKey: projectsKey(), queryFn: () => projectsApi.getProjects() })
  const [choice, setChoice] = useState(request.project_id ?? '')
  const [newName, setNewName] = useState(request.title)
  const [result, setResult] = useState<PromoteResult | null>(null)
  const promote = useBoardWrite(
    async (api, input: { choice: string; newName: string }) =>
      api.promote(request.request_id, await projectIdFor(input.choice, input.newName)),
    setResult,
  )
  const ready = choice !== '' && (choice !== NEW_PROJECT || newName.trim() !== '')
  return (
    <section className="card p-3 space-y-3" aria-label={t('promote.title')}>
      <h3 className="text-sm font-medium text-text">{t('promote.title')}</h3>
      <p className="text-xs text-muted">{t('promote.hint')}</p>
      <LabeledField label={t('promote.project')}>
        {(id) => (
          <select id={id} className="select w-full" value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="">{projects.isLoading ? t('promote.loadingProjects') : t('promote.pickProject')}</option>
            {(projects.data?.projects ?? []).map((project) => (
              <option key={project.project_id} value={project.project_id}>{project.name}</option>
            ))}
            <option value={NEW_PROJECT}>{t('promote.newProject')}</option>
          </select>
        )}
      </LabeledField>
      {choice === NEW_PROJECT ? (
        <LabeledField label={t('promote.newProjectName')}>
          {(id) => <input id={id} className="input w-full" value={newName} maxLength={200} onChange={(e) => setNewName(e.target.value)} />}
        </LabeledField>
      ) : null}
      <WriteError error={promote.error} />
      {result ? <PromoteOutcome result={result} /> : null}
      <button type="button" className="btn btn-primary btn-sm" disabled={!ready || promote.isPending}
        onClick={() => promote.mutate({ choice, newName })}>
        <FolderPlus size={14} aria-hidden="true" />{t('promote.submit')}
      </button>
    </section>
  )
}
