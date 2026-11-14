/**
 * @fileoverview Preview for `set_prototype_walkthrough` (docs/prototype-builder.md Part 1): the prototype, then
 * how many saved steps the proposal replaces, then every step as it will show (number, title, body as plain text,
 * where it points), or that the walkthrough is removed; then that saving makes a new version of the prototype.
 * @module assistant/approvals/previews/PrototypeWalkthroughPreview
 */
import { useTranslation } from 'react-i18next'
import { useSavedWalkthrough } from '../../../components/PrototypeWalkthrough/useSavedWalkthrough'
import { PrototypePreview } from './PrototypeLine'
import type { SetPrototypeWalkthroughArgs } from '../prototypeSchemas'

/** Where a step without a selector points: its recorded position on its screen ("this screen" when it names none). */
function positionText(route: string, t: (key: string, options?: Record<string, unknown>) => string): string {
  return t('preview.walkthrough.position', { screen: route === '' ? t('preview.walkthrough.thisScreen') : route })
}

/**
 * How many saved steps the proposal replaces (the assistant cannot read them, so the person is told they go);
 * nothing while they are read, or when the version has none.
 */
function ReplacedSteps({ projectId, documentId }: Readonly<{ projectId: string; documentId: string }>) {
  const { t } = useTranslation('assistantTools')
  const count = useSavedWalkthrough(projectId, documentId).data?.length ?? 0
  if (count === 0) return null
  return <p className="font-medium" data-testid="walkthrough-preview-replaces">{t('preview.walkthrough.replaces', { count })}</p>
}

export function PrototypeWalkthroughPreview({ args }: Readonly<{ args: SetPrototypeWalkthroughArgs }>) {
  const { t } = useTranslation('assistantTools')
  return (
    <PrototypePreview projectId={args.project_id} documentId={args.document_id} note={t('preview.walkthrough.note')}>
      <ReplacedSteps projectId={args.project_id} documentId={args.document_id} />
      {args.steps.length === 0 ? <p className="font-medium">{t('preview.walkthrough.remove')}</p> : (
        <ol className="space-y-1.5" data-testid="walkthrough-preview-steps">
          {args.steps.map((step, index) => (
            <li key={`${String(index)}:${step.title}`} className="rounded-md border p-2 break-words">
              <p className="text-[12px] text-muted">{t('preview.walkthrough.step', { n: index + 1, total: args.steps.length })}</p>
              <p className="font-medium">{step.title}</p>
              <p className="whitespace-pre-wrap">{step.body}</p>
              <p className="text-[12px] text-muted break-all">{step.selector ?? positionText(step.anchor?.route ?? '', t)}</p>
            </li>
          ))}
        </ol>
      )}
    </PrototypePreview>
  )
}
