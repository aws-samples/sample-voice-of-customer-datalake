/**
 * @fileoverview The routes `pickerHarness.tsx` renders (components only, so the file stays fast-refresh clean): the
 * picker reading `?template=` as the main page reads it, and a stand-in builder that shows the new form it was handed
 * (`readHandoff` of the history state) as `data-testid="handoff"` JSON.
 *
 * @module pages/FeedbackForms/test/pickerRoutes
 */
import { useLocation, useSearchParams } from 'react-router-dom'
import TemplatePicker from '../picker/TemplatePicker'
import { readHandoff } from '../builder/newFormHandoff'

export function PickerAtUrl() {
  const [params] = useSearchParams()
  return <TemplatePicker template={params.get('template')} />
}

export function BuilderStandIn() {
  const handoff = readHandoff(useLocation().state)
  return <output data-testid="handoff">{JSON.stringify(handoff)}</output>
}
