/**
 * @fileoverview The Platform step inspector (map, reduce, memory; and Learn and the coach, which a model runs but
 * which have no card of their own) (7.52.00 C2; docs/ux part 5 §5.4): its settings in words, edited while building
 * (StepForm's ParamsFields: a map's sharding, a memory step's mode, scope and limit), and its assertions where the
 * vocabulary has checks for it.
 *
 * @module components/WorkflowEditor/inspector/PlatformInspector
 */
import { useTranslation } from 'react-i18next'
import { platformLine } from '../nodes/nodeText'
import { SectionHeading } from './InspectorShell'
import { Arrows, InThisFlow, StepAssertions } from './inspectorParts'
import type { KindViewProps } from './inspectorParts'

const PLATFORM: ReadonlySet<string> = new Set(['map', 'reduce', 'memory'])

export function PlatformInspector({ props }: Readonly<{ props: KindViewProps }>) {
  const { t } = useTranslation('agents')
  const { node } = props
  return (
    <>
      <InThisFlow props={props} rows={PLATFORM.has(node.type) ? [[t('inspector.platform.setting'), platformLine(t, node)]] : []} />
      <section className="space-y-2">
        <SectionHeading>{t('inspector.tab.assertions')}</SectionHeading>
        <StepAssertions props={props} place={node.type} />
      </section>
      <section className="space-y-2">
        <SectionHeading>{t('inspector.tab.arrows')}</SectionHeading>
        <Arrows props={props} />
      </section>
    </>
  )
}
