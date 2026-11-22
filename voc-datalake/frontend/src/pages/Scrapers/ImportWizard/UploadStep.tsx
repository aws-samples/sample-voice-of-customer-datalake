/**
 * @fileoverview The wizard's Upload step: choose (or drop) a CSV, TSV, JSON or Excel file; the server reads its
 * first 256 KB and says what each column holds; the first 20 rows are shown before going on (with a warning when the
 * file was not UTF-8 and was read as Windows-1252).
 *
 * @module pages/Scrapers/ImportWizard/UploadStep
 */
import { FileUp, Loader2 } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { ImportWizardState } from './useImportWizard'
import type { FilePickProblem, Table } from './wizardFile'
import StickyActionBar from '../../../components/StickyActionBar/StickyActionBar'

const PREVIEW_ROWS = 20
const PROBLEM_KEYS: Readonly<Record<FilePickProblem, string>> = {
  format: 'importWizard.upload.problems.format',
  tooLarge: 'importWizard.upload.problems.tooLarge',
  workbookTooLarge: 'importWizard.upload.problems.workbookTooLarge',
  empty: 'importWizard.upload.problems.empty',
  unreadable: 'importWizard.upload.problems.unreadable',
}

/** The first rows of the file as a table (each cell cut short: a long comment would push the grid off screen). */
function PreviewTable({ table }: Readonly<{ table: Table }>) {
  const { t } = useTranslation('scrapers')
  const rows = table.rows.slice(0, PREVIEW_ROWS)
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="min-w-full text-xs">
        <caption className="sr-only">{t('importWizard.upload.preview', { count: rows.length })}</caption>
        <thead className="bg-bg-subtle">
          <tr>{table.headers.map((header) => <th key={header} scope="col" className="px-2 py-1.5 text-left font-semibold text-text-strong whitespace-nowrap">{header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            // (the preview never reorders: a row's position is its identity, it has no id of its own)
            <tr key={index} className="border-t border-border">
              {table.headers.map((header) => <td key={header} className="px-2 py-1 text-text max-w-[16rem] truncate">{row[header]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function UploadStep({ wizard }: Readonly<{ wizard: ImportWizardState }>) {
  const { t } = useTranslation('scrapers')
  const inputId = useId()
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    void wizard.pick(event.dataTransfer.files.item(0))
  }
  const { detected } = wizard
  return (
    <section className="card space-y-4" aria-labelledby={`${inputId}-title`}>
      <h2 id={`${inputId}-title`} className="text-sm font-semibold text-text-strong">{t('importWizard.steps.upload')}</h2>
      <div onDragOver={(event) => { event.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)}
        onDrop={onDrop} data-testid="import-drop-zone"
        className={`rounded-md border-2 border-dashed px-4 py-8 text-center ${dragging ? 'border-accent bg-accent-subtle' : 'border-border'}`}>
        <FileUp size={20} className="mx-auto mb-2 text-muted" aria-hidden="true" />
        <p className="text-sm text-text">{t('importWizard.upload.drop')}</p>
        <p className="text-xs text-muted mt-1">{t('importWizard.upload.formats')}</p>
        <button type="button" className="btn btn-secondary btn-sm mt-3" onClick={() => input.current?.click()}>
          {t('importWizard.upload.choose')}
        </button>
        <input ref={input} type="file" className="sr-only" tabIndex={-1} aria-hidden="true" accept=".csv,.tsv,.tab,.txt,.json,.jsonl,.ndjson,.xlsx"
          onChange={(event) => void wizard.pick(event.target.files?.item(0) ?? null)} />
      </div>
      {wizard.busy && <p role="status" className="text-sm text-muted inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" aria-hidden="true" />{t('importWizard.upload.reading')}</p>}
      {wizard.pickError !== null && <p role="alert" className="text-sm text-danger">{t(PROBLEM_KEYS[wizard.pickError])}</p>}
      {detected !== null && (
        <>
          <p className="text-sm text-text">
            <span className="font-medium text-text-strong">{detected.file.name}</span>{' · '}
            {t('importWizard.upload.rows', { count: detected.table.rows.length, columns: detected.table.headers.length })}
          </p>
          {detected.file.legacyEncoding && <p role="status" className="text-sm text-warn">{t('importWizard.upload.legacyEncoding')}</p>}
          <PreviewTable table={detected.table} />
          <StickyActionBar variant="footer" className="flex justify-end">
            <button type="button" className="btn btn-primary" onClick={() => wizard.setStep('map')}>{t('importWizard.continue')}</button>
          </StickyActionBar>
        </>
      )}
    </section>
  )
}
