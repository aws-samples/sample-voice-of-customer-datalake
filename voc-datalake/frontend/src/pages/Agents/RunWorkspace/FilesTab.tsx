/**
 * @fileoverview The inspector's Files tab (7.51.00): a tree of the files the agent's tool calls read, listed or wrote
 * (`…/files`, from its transcript), each with how often and when last.
 *
 * @module pages/Agents/RunWorkspace/FilesTab
 */
import { File, Folder } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import LoadFailed from '../../../components/LoadFailed/LoadFailed'
import { formatTime } from '../../../utils/dateUtils'
import { useAgentFiles } from './useRunWorkspace'
import type { TouchedFile } from '../../../api/engineeringRunWorkspaceApi'

interface FolderNode {
  readonly name: string
  readonly folders: Map<string, FolderNode>
  readonly files: TouchedFile[]
}

/** The files as a tree of their folders (a path's last segment is the file; the folders keep their order). */
function treeOf(files: readonly TouchedFile[]): FolderNode {
  const root: FolderNode = { name: '', folders: new Map(), files: [] }
  for (const file of files) {
    const parts = file.path.split('/').filter((part) => part !== '')
    const folder = parts.slice(0, -1).reduce((parent, name) => {
      const child = parent.folders.get(name) ?? { name, folders: new Map<string, FolderNode>(), files: [] }
      parent.folders.set(name, child)
      return child
    }, root)
    folder.files.push(file)
  }
  return root
}

function FileLine({ file }: Readonly<{ file: TouchedFile }>) {
  const { t, i18n } = useTranslation('agents')
  const uses = (['read', 'written', 'listed'] as const).filter((use) => file[use] > 0)
    .map((use) => t(`runWorkspace.files.${use}`, { count: file[use] }))
  return (
    <li className="flex flex-wrap items-center gap-1.5 py-0.5 text-[12px]">
      <File size={12} className="shrink-0 text-muted" aria-hidden="true" />
      <span className="font-mono break-all">{file.path.split('/').at(-1) ?? file.path}</span>
      <span className="text-[12px] text-muted">{uses.join(' · ')}</span>
      {file.last_at !== '' && <time dateTime={file.last_at} className="text-[12px] text-muted">{formatTime(file.last_at, i18n.language)}</time>}
    </li>
  )
}

function FolderView({ folder }: Readonly<{ folder: FolderNode }>) {
  return (
    <ul className="space-y-0.5">
      {[...folder.folders.values()].map((child) => (
        <li key={child.name}>
          <p className="flex items-center gap-1.5 text-[12px] font-medium"><Folder size={12} className="text-muted" aria-hidden="true" />{child.name}</p>
          <div className="ml-4"><FolderView folder={child} /></div>
        </li>
      ))}
      {folder.files.map((file) => <FileLine key={file.path} file={file} />)}
    </ul>
  )
}

export function FilesTab({ runId, agent, live }: Readonly<{ runId: string; agent: string; live: boolean }>) {
  const { t } = useTranslation('agents')
  const files = useAgentFiles(runId, agent, live)
  if (files.isLoading) return <div className="skeleton h-24" />
  if (files.data === undefined) return <LoadFailed onRetry={() => { void files.refetch() }} retrying={files.isFetching} />
  if (files.data.files.length === 0) return <p className="text-sm text-muted">{t('runWorkspace.files.none')}</p>
  return (
    <div className="space-y-1">
      {files.data.truncated && <p role="status" className="text-[12px] text-warn">{t('runWorkspace.files.partial')}</p>}
      <FolderView folder={treeOf(files.data.files)} />
    </div>
  )
}
