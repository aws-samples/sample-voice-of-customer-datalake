/**
 * @fileoverview Approval previews of the bulk admin write tools. Deterministic:
 * every cell is computed from the validated args — no model-written prose.
 *
 * - import_reviews: source name, source profile, how many reviews (and how many
 *   carry a rating / a date), then the first rows as a table;
 * - create_users: one table row per person (email, role, names) and the
 *   temporary-password note;
 * - set_source_enabled: the plugin and its new schedule state.
 *
 * Design tokens: a role is a label (`badge-muted`), except an administrator
 * (`badge-warn`, plus a count note); a schedule on / off is a state (`badge-ok` /
 * `badge-muted`). Every review row is shown (scrollable), never a sample.
 *
 * @module assistant/approvals/previews/BulkAdminPreviews
 */
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { DEFAULT_IMPORT_SOURCE_ID, importStats } from '../reviewImportSchemas'
import { CardNote, FieldTable, NothingSavedNote } from './FieldDiff'
import { Code, Muted } from './ScraperValues'
import { fieldRow } from './format'
import type { ReactNode } from 'react'
import type { ImportReviewsArgs } from '../reviewImportSchemas'
import type { SetSourceEnabledArgs } from '../planSchemas'
import type { CreateUsersArgs, UserRole } from '../userSchemas'

/** Characters of a review's text shown in the table (the full text is imported). */
const PREVIEW_TEXT_CHARS = 160

const R = 'preview.reviewImport'
const U = 'preview.users'

function clipped(text: string): string {
  return text.length <= PREVIEW_TEXT_CHARS ? text : `${text.slice(0, PREVIEW_TEXT_CHARS)}\u2026`
}

export function TableHead({ labels }: Readonly<{ labels: readonly string[] }>) {
  return (
    <thead>
      <tr className="text-left text-muted">
        {labels.map((label) => <th key={label} scope="col" className="py-1 pr-2 font-medium">{label}</th>)}
      </tr>
    </thead>
  )
}

export function Cell({ children, className }: Readonly<{ children: ReactNode; className?: string }>) {
  return <td className={clsx('py-1 pr-2 align-top', className)}>{children}</td>
}

function ReviewRows({ args }: Readonly<{ args: ImportReviewsArgs }>) {
  const { t } = useTranslation('assistantTools')
  const notSet = <Muted text={t(`${U}.notSet`)} />
  // EVERY row is listed (scrollable): rows can come from an attached or pasted
  // file, so a row the approver cannot see is a row nobody reviewed.
  return (
    <div className="max-h-80 overflow-auto" data-testid="review-rows">
      <table className="w-full text-[12px]" aria-label={t(`${R}.tableLabel`)}>
        <TableHead labels={[t(`${R}.text`), t(`${R}.rating`), t(`${R}.author`), t(`${R}.date`), t(`${R}.title`), t(`${R}.url`)]} />
        <tbody>
          {args.items.map((item, index) => (
            <tr key={index} className="border-t border-border" data-testid={`review-row-${String(index)}`}>
              <Cell className="min-w-[12rem] break-words text-text">{clipped(item.text)}</Cell>
              <Cell className="whitespace-nowrap">{item.rating ?? notSet}</Cell>
              <Cell className="break-words">{item.author ?? notSet}</Cell>
              <Cell className="whitespace-nowrap font-mono">{item.created_at ?? notSet}</Cell>
              <Cell className="break-words">{item.title ?? notSet}</Cell>
              <Cell className="break-all font-mono">{item.url ?? notSet}</Cell>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function ImportReviewsPreview({ args }: Readonly<{ args: ImportReviewsArgs }>) {
  const { t } = useTranslation('assistantTools')
  const stats = importStats(args)
  const undated = stats.total - stats.dated
  const rows = [
    fieldRow('source_name', t(`${R}.sourceName`), args.source_name),
    fieldRow('source_id', t(`${R}.sourceId`), <Code text={args.source_id ?? DEFAULT_IMPORT_SOURCE_ID} />),
    fieldRow('count', t(`${R}.count`), t(`${R}.countValue`, { count: stats.total })),
    fieldRow('rated', t(`${R}.rated`), t(`${R}.ofTotal`, { n: stats.rated, total: stats.total })),
    fieldRow('dated', t(`${R}.dated`), t(`${R}.ofTotal`, { n: stats.dated, total: stats.total })),
  ]
  return (
    <div className="space-y-2">
      <FieldTable rows={rows} label={t(`${R}.summaryLabel`)} />
      <ReviewRows args={args} />
      <CardNote text={t(`${R}.reviewAllNote`)} />
      {undated > 0 && <CardNote text={t(`${R}.undatedNote`, { count: undated })} />}
      <CardNote text={t(`${R}.pipelineNote`)} />
      <NothingSavedNote />
    </div>
  )
}

/** An administrator row is flagged (`badge-warn`): a pasted or attached list must not slip one in unnoticed. */
function RoleBadge({ role }: Readonly<{ role: UserRole }>) {
  const { t } = useTranslation('assistantTools')
  return role === 'admins'
    ? <span className="badge badge-warn">{t(`${U}.roleAdmins`)}</span>
    : <span className="badge badge-muted">{t(`${U}.roleUsers`)}</span>
}

export function CreateUsersPreview({ args }: Readonly<{ args: CreateUsersArgs }>) {
  const { t } = useTranslation('assistantTools')
  const notSet = <Muted text={t(`${U}.notSet`)} />
  const admins = args.users.filter((user) => user.role === 'admins').length
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]" aria-label={t(`${U}.usersTableLabel`, { count: args.users.length })}>
          <TableHead labels={[t(`${U}.email`), t(`${U}.role`), t(`${U}.firstName`), t(`${U}.lastName`)]} />
          <tbody>
            {args.users.map((user) => (
              <tr key={user.email} className="border-t border-border" data-testid={`user-row-${user.email}`}>
                <Cell className="break-all text-text">{user.email}</Cell>
                <Cell><RoleBadge role={user.role} /></Cell>
                <Cell>{user.given_name ?? notSet}</Cell>
                <Cell>{user.family_name ?? notSet}</Cell>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {admins > 0 && <CardNote text={t(`${U}.adminsNote`, { n: admins, total: args.users.length })} />}
      <CardNote text={t(`${U}.temporaryPasswordsNote`)} />
      <CardNote text={t(`${U}.inOrderNote`)} />
      <NothingSavedNote />
    </div>
  )
}

export function SourceEnabledPreview({ args }: Readonly<{ args: SetSourceEnabledArgs }>) {
  const { t } = useTranslation('assistantTools')
  const state = args.enabled
    ? <span className="badge badge-ok">{t('preview.sourceSchedule.on')}</span>
    : <span className="badge badge-muted">{t('preview.sourceSchedule.off')}</span>
  const rows = [
    fieldRow('source', t('preview.sourceSchedule.source'), <Code text={args.source} />),
    fieldRow('schedule', t('preview.sourceSchedule.schedule'), state),
  ]
  return (
    <div className="space-y-2">
      <FieldTable rows={rows} label={t('preview.sourceSchedule.label')} />
      <CardNote text={t(args.enabled ? 'preview.sourceSchedule.onNote' : 'preview.sourceSchedule.offNote')} />
      <NothingSavedNote />
    </div>
  )
}
