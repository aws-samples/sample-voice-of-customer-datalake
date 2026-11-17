/**
 * @fileoverview One file's part of a patch, drawn (7.51.00, D51-2: our own renderer on unifiedDiff.ts, no diff
 * library): each hunk with its header, its lines numbered on both sides, unified or split side by side, and each long
 * run of unchanged lines folded until it is opened. The text is the patch's, shown as text.
 *
 * Adapted from kirodotdev/KiroCrew `website/src/components/DiffPanel.tsx` (the split and unified toggle) and
 * `website/src/components/FoldableDiffBlock.tsx` (the fold), Apache-2.0 (THIRD-PARTY-LICENSES.md); not its Pierre renderer.
 *
 * @module pages/Agents/RunWorkspace/FileDiff
 */
import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { foldContext, modeChangeKind, parseUnifiedDiff, splitRows } from './unifiedDiff'
import type { DiffFile, DiffHunk, DiffLine } from './unifiedDiff'

const LINE_TONE: Readonly<Record<DiffLine['kind'], string>> = { add: 'bg-ok-subtle', del: 'bg-danger-subtle', context: '' }
const SIGN: Readonly<Record<DiffLine['kind'], string>> = { add: '+', del: '-', context: ' ' }
const NUMBER = 'w-10 select-none px-1 text-right align-top text-muted'

function LineText({ line }: Readonly<{ line: DiffLine | null }>) {
  const { t } = useTranslation('agents')
  if (line === null) return null
  return (
    <>
      {line.text}
      {line.noNewline && <span className="ml-2 text-[12px] text-muted">{t('runWorkspace.changes.noNewline')}</span>}
    </>
  )
}

function UnifiedRow({ line }: Readonly<{ line: DiffLine }>) {
  return (
    <tr className={LINE_TONE[line.kind]}>
      <td className={NUMBER}>{line.oldNo ?? ''}</td>
      <td className={NUMBER}>{line.newNo ?? ''}</td>
      <td className="w-4 select-none text-center text-muted">{SIGN[line.kind]}</td>
      <td className="whitespace-pre px-1"><LineText line={line} /></td>
    </tr>
  )
}

function SplitRow({ left, right }: Readonly<{ left: DiffLine | null; right: DiffLine | null }>) {
  return (
    <tr>
      <td className={clsx(NUMBER, left !== null && LINE_TONE[left.kind])}>{left?.oldNo ?? ''}</td>
      <td className={clsx('w-1/2 whitespace-pre px-1', left !== null && LINE_TONE[left.kind])}><LineText line={left} /></td>
      <td className={clsx(NUMBER, 'border-l border-border', right !== null && LINE_TONE[right.kind])}>{right?.newNo ?? ''}</td>
      <td className={clsx('w-1/2 whitespace-pre px-1', right !== null && LINE_TONE[right.kind])}><LineText line={right} /></td>
    </tr>
  )
}

function Lines({ lines, split }: Readonly<{ lines: readonly DiffLine[]; split: boolean }>) {
  if (split) return <>{splitRows(lines).map((row, index) => <SplitRow key={index} left={row.left} right={row.right} />)}</>
  return <>{lines.map((line, index) => <UnifiedRow key={index} line={line} />)}</>
}

function HunkView({ hunk, split }: Readonly<{ hunk: DiffHunk; split: boolean }>) {
  const { t } = useTranslation('agents')
  const segments = useMemo(() => foldContext(hunk.lines), [hunk])
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set())
  return (
    <tbody>
      <tr className="bg-info-subtle text-info"><td colSpan={4} className="px-2 py-0.5 whitespace-pre">{hunk.header}</td></tr>
      {segments.map((segment, index) => (segment.kind === 'fold' && !opened.has(index) ? (
        <tr key={index} className="bg-bg-accent">
          <td colSpan={4} className="px-2 py-0.5">
            <button type="button" className="link text-[12px]" onClick={() => setOpened(new Set([...opened, index]))}>
              {t('runWorkspace.changes.unfold', { count: segment.lines.length })}
            </button>
          </td>
        </tr>
      ) : <Lines key={index} lines={segment.lines} split={split} />))}
    </tbody>
  )
}

/** A file's own line: its path (a rename's or a copy's old one first), its status, its counts and a mode change. */
function FileLine({ file }: Readonly<{ file: DiffFile }>) {
  const { t } = useTranslation('agents')
  const notes = [
    t(`runWorkspace.changes.status.${file.status}`, { defaultValue: file.status }),
    ...(file.modeChange === null ? [] : [t(`runWorkspace.changes.mode.${modeChangeKind(file.modeChange)}`)]),
  ]
  return (
    <p className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-0.5 text-[12px] text-muted">
      <span className="font-mono break-all">{file.oldPath === null ? file.path : t('runWorkspace.changes.renamed', { from: file.oldPath, to: file.path })}</span>
      <span>{notes.join(' · ')}</span>
      <span className="tabular-nums"><span className="text-ok">+{file.additions}</span> <span className="text-danger">-{file.deletions}</span></span>
    </p>
  )
}

/** A file's part of a patch (`split`: side by side), or a line saying it holds no lines to show. */
export function FileDiff({ patch, split }: Readonly<{ patch: string; split: boolean }>) {
  const { t } = useTranslation('agents')
  const files = useMemo(() => parseUnifiedDiff(patch), [patch])
  const hunks = files.flatMap((file) => file.hunks)
  if (files.some((file) => file.binary)) return <p className="px-2 py-1 text-[12px] text-muted">{t('runWorkspace.changes.binary')}</p>
  if (hunks.length === 0) return <p className="px-2 py-1 text-[12px] text-muted">{t('runWorkspace.changes.noLines')}</p>
  return (
    <div className="overflow-x-auto">
      {files.map((file, at) => (
        <div key={`${String(at)}:${file.path}`}>
          <FileLine file={file} />
          <table className="w-full border-collapse font-mono text-[12px] leading-5">
            {file.hunks.map((hunk, index) => <HunkView key={index} hunk={hunk} split={split} />)}
          </table>
        </div>
      ))}
    </div>
  )
}
