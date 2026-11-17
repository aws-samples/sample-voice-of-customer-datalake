/**
 * @fileoverview A document's front-matter, read only (D6-5), above its body: a definition list when every line is a
 * flat `key: value`, else the YAML as stored in a code view. Nothing is parsed beyond that line rule: no YAML library.
 *
 * @module components/Document/text/PropertiesPanel
 */
import { useTranslation } from 'react-i18next'
import CodeView from './CodeView'
import { flatProperties, frontMatterYaml } from './frontMatter'

export default function PropertiesPanel({ frontMatter }: Readonly<{ frontMatter: string }>) {
  const { t } = useTranslation('documents')
  const yaml = frontMatterYaml(frontMatter)
  const pairs = flatProperties(yaml)
  return (
    <section aria-label={t('properties.label')} className="mb-4 rounded-lg border border-border bg-bg-elevated p-3">
      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">{t('properties.label')}</h3>
      {pairs === null ? <CodeView text={yaml} label={t('view.sourceOf', { title: t('properties.label') })} /> : (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px]">
          {pairs.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="font-mono text-[12px] text-muted">{key}</dt>
              <dd className="min-w-0 break-words text-text">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}
