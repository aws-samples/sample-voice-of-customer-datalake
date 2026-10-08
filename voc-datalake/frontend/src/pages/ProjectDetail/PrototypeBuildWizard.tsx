/**
 * @fileoverview The Overview tab prototype build wizard and its source pickers.
 * @module pages/ProjectDetail/PrototypeBuildWizard
 */

import clsx from 'clsx'
import { format } from 'date-fns'
import { AlertTriangle } from 'lucide-react'
import { useId } from 'react'
import ModalShell from '../../components/ModalShell/ModalShell'
import { type PrototypeBuildControl } from './usePrototypeBuild'
import type { TFunction } from 'i18next'

/**
 * Where a prototype build is configured and started.
 *
 * One panel for the whole "what should this build read?" question: which PRD and
 * PR/FAQ, plus the optional product context, research reports and uploaded
 * visuals. It replaces a confirm dialog that opened for only some projects, and
 * that is the behaviour change — the card now always opens this, so the
 * configuration is reachable for every project rather than for the awkward ones.
 *
 * `ModalShell` rather than a hand-rolled overlay, and rather than `ConfirmModal`:
 * the shell owns `role="dialog"`, the accessible name, the focus trap and Escape
 * (issue #283 found 23 overlays of which 2 declared a role), while `ConfirmModal`
 * requires a `message` — correct for something whose whole content is a question,
 * wrong here, where the question is optional and the content is a form.
 *
 * The warning, when there is one, is stated FIRST and styled as a caution: it is
 * the only thing on this panel that can save money, since the build endpoint has
 * no existing-prototype check of its own.
 */
export function PrototypeBuildWizard({
  build, t,
}: {
  readonly build: PrototypeBuildControl
  readonly t: TFunction<'projectDetail'>
}) {
  // `aria-labelledby` rather than `ariaLabel`, pointing at the heading this panel
  // already renders: one string on screen and in the accessible name, so the two
  // cannot drift apart, and no second translated value to keep in step.
  const headingId = useId()

  return (
    <ModalShell
      isOpen={build.wizard.isOpen}
      onClose={build.wizard.onCancel}
      ariaLabelledBy={headingId}
      panelClassName="max-w-lg"
    >
      <div data-testid="prototype-build-wizard" className="flex max-h-[90vh] min-h-0 flex-col">
        <div className="dialog-header">
          <h2 id={headingId} className="dialog-title">
            {t('documents.prototype.button')}
          </h2>
        </div>
        <div className="dialog-body">
          {/* A LIVE REGION, and that is the point rather than decoration: `warning` is
              derived from documents that refetch whenever a job completes, so it can
              APPEAR or ESCALATE while this panel is open — a prototype arriving turns
              the submit from "build from the PRD alone" into "build a second and keep
              the first". A sighted user sees the amber block change; without a live
              region a screen-reader user who opened with no warning is told nothing,
              and the submit quietly costs more than when they opened it.

              The region wraps the CONDITION, not just the text: an element that only
              exists once there is something to say cannot announce its own arrival, so
              the container is always mounted and only its contents change. */}
          <div role="status" aria-live="polite">
            {build.wizard.warning === '' ? null : (
              <p className="mt-2 flex items-start gap-2 rounded-lg bg-warn-subtle p-2.5 text-sm text-warn">
                <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
                <span>{build.wizard.warning}</span>
              </p>
            )}
          </div>
          <PrototypeSourcePicker sources={build.sources} t={t} />
          <PrototypeExtraSources extras={build.extras} t={t} />
        </div>
        <div className="dialog-footer flex-col-reverse sm:flex-row">
          <button
            type="button"
            onClick={build.wizard.onCancel}
            className="btn btn-secondary w-full sm:w-auto"
          >
            {t('documents.prototype.cancel')}
          </button>
          {/* No busy state here, deliberately: `onConfirm` closes the panel before
              starting the request, so this button cannot be on screen while a start
              is in flight. The busy label and any failure to start belong to the
              card's own status line, which is where the user is looking once this
              closes — and which already has tests for both. A spinner here would be
              protection that never runs. */}
          <button
            type="button"
            onClick={build.wizard.onConfirm}
            className="btn btn-primary w-full sm:w-auto"
          >
            {t('documents.prototype.button')}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}

/**
 * Which PRD and PR/FAQ the build will read, and a way to change either.
 *
 * A `select` rather than a list of radios: the live case that motivated this has
 * three PR/FAQs and would grow, and a native select is also the control that
 * works on a phone without any of its own keyboard handling.
 *
 * A type with one document renders as a plain line, not a disabled select. There
 * is nothing to choose, but naming it still answers "what will this read", which
 * is half of why the dialog opens at all. A type with none renders nothing —
 * "no PRD" is already the confirm message's whole subject in that case, and
 * repeating it under the sentence that says it would be noise.
 */
function PrototypeSourcePicker({
  sources, t,
}: {
  readonly sources: PrototypeBuildControl['sources']
  readonly t: TFunction<'projectDetail'>
}) {
  // Nothing to say when the project has neither type: the message already reads
  // "create a PRD or a PR-FAQ first".
  if (sources.prdOptions.length === 0 && sources.prfaqOptions.length === 0) return null

  return (
    // `mt-3` lives here rather than on a wrapper in the wizard: this component
    // returns null when there is nothing to choose, and a wrapper's margin would
    // leave a gap the panel cannot detect (a React element that renders nothing is
    // still a non-null child).
    <div data-testid="prototype-source-picker" className="mt-3 space-y-2 rounded-lg bg-bg-accent p-3">
      <SourceRow
        label={t('documents.prototype.sourcePrd')}
        latestLabel={t('documents.prototype.sourceLatest')}
        options={sources.prdOptions}
        selectedId={sources.prdId}
        onSelect={sources.onSelectPrd}
      />
      <SourceRow
        label={t('documents.prototype.sourcePrfaq')}
        latestLabel={t('documents.prototype.sourceLatest')}
        options={sources.prfaqOptions}
        selectedId={sources.prfaqId}
        onSelect={sources.onSelectPrfaq}
      />
    </div>
  )
}

/** One source slot: a select when there is a choice, a statement when there is not. */
function SourceRow({
  label, latestLabel, options, selectedId, onSelect,
}: {
  readonly label: string
  /** Marks the default option. Passed in so the key stays a literal `t()` call. */
  readonly latestLabel: string
  readonly options: PrototypeBuildControl['sources']['prdOptions']
  readonly selectedId: string
  readonly onSelect: (documentId: string) => void
}) {
  const selectId = useId()
  if (options.length === 0) return null

  const selected = options.find((option) => option.document_id === selectedId)

  if (options.length === 1) {
    return (
      <p className="text-xs text-text">
        <span className="font-medium">{label}</span>{' '}
        <span className="text-muted">{(selected ?? options.at(0))?.title}</span>
      </p>
    )
  }

  return (
    <div className="text-xs">
      {/* A real label, not a bare span: this is the only control in the dialog,
          and a select whose purpose is announced as "combobox" is unusable
          without sight of the text beside it. */}
      <label htmlFor={selectId} className="block font-medium text-text mb-1">{label}</label>
      <select
        id={selectId}
        value={selectedId}
        onChange={(e) => onSelect(e.target.value)}
        className="select select-sm"
      >
        {options.map((option, index) => (
          <option key={option.document_id} value={option.document_id}>
            {/* Options are newest first, so index 0 is what the build would use
                with no choice made. Dates disambiguate the same-titled documents
                this picker exists for — six prototypes named "Prototype" is the
                real shape of this data. */}
            {`${option.title} — ${format(new Date(option.created_at), 'MMM d, yyyy')}`}
            {index === 0 ? ` (${latestLabel})` : ''}
          </option>
        ))}
      </select>
    </div>
  )
}

/**
 * The optional inputs a prototype build can be told to read: the project's
 * product context, specific research reports, and uploaded visuals to take the
 * palette and layout from.
 *
 * Rendered inside `PrototypeBuildWizard`, beside the PRD/PR-FAQ pickers, so one
 * panel answers the whole "what should this build read?" question.
 *
 * These sat on the card face until the wizard existed, and the reason is worth
 * keeping because it constrains any future move: the confirm dialog they would
 * otherwise have lived in opened for only SOME projects — `warningKeyFor` returned
 * null for one PRD, one PR-FAQ and no prototype — so a control inside it was
 * unreachable for the simplest project. The wizard opens for every project, which
 * is what makes this placement safe and what
 * `OverviewTab.prototypeWizard.test.tsx` pins.
 *
 * Checkboxes rather than the `select` the source picker uses, because these are
 * independent on/off choices rather than one-of-many, and because the research list
 * is a multi-selection: the same shape `DataSourceSteps` uses, which is also why the
 * research ids stay a separate field from the document ids.
 */
function PrototypeExtraSources({
  extras, t,
}: {
  readonly extras: PrototypeBuildControl['extras']
  readonly t: TFunction<'projectDetail'>
}) {
  return (
    <div data-testid="prototype-extra-sources" className="mb-3 space-y-1.5 rounded-lg bg-bg-accent p-2.5">
      <p className="text-xs font-medium text-text">{t('documents.prototype.extraSources')}</p>
      <SourceCheckbox
        label={t('documents.prototype.useProductContext')}
        checked={extras.useProductContext}
        onChange={extras.onToggleProductContext}
      />
      {/* Nothing to offer, nothing to show — the same reason `SourceRow` renders
          null for a type the project has none of. A checkbox that can only ever
          contribute an empty section is an invitation to a no-op. */}
      {extras.researchOptions.length === 0 ? null : (
        <>
          <SourceCheckbox
            // `total`, not `count`: `count` makes i18next resolve plural
            // suffixes, which would mean two more keys per catalogue for a
            // number that is only ever shown in parentheses. `overview.state.research`
            // already interpolates `total` the same way.
            label={t('documents.prototype.useResearch', { total: extras.researchOptions.length })}
            checked={extras.useResearch}
            onChange={extras.onToggleResearch}
          />
          {extras.useResearch ? (
            <div data-testid="prototype-research-list" className="ml-5 space-y-1 border-l pl-2">
              {extras.researchOptions.map((option) => {
                const checked = extras.selectedResearchIds.includes(option.document_id)
                return (
                  <SourceCheckbox
                    key={option.document_id}
                    label={option.title}
                    checked={checked}
                    // At the bound, the unticked boxes stop accepting: the API
                    // rejects a longer list, and a 400 after the choice is made
                    // says nothing about which report to give up.
                    disabled={!checked && extras.researchLimitReached}
                    onChange={() => extras.onToggleResearchId(option.document_id)}
                  />
                )
              })}
              {extras.researchLimitReached ? (
                <p className="text-xs text-warn">
                  {t('documents.prototype.researchLimit', { max: extras.maxResearchIds })}
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      )}
      <PrototypeVisualSources extras={extras} t={t} />
    </div>
  )
}

/**
 * The uploaded mockups a build can take its palette and layout from.
 *
 * NO MASTER TICK-BOX, unlike research, and that follows the API rather than taste:
 * there is no `use_visuals` field, so a master would be UI state with nothing to
 * send it to — and it would introduce the two nonsense states the backend's
 * `_validated_product_doc_ids` docstring rejects, "on with an empty list" and "off
 * with ids". The ticked list IS the request, so the boxes that decide it are the
 * only control there is.
 *
 * What replaces the master is a group heading carrying the count — named to
 * assistive tech through `role="group"`/`aria-labelledby`, since with no master
 * checkbox there is nothing else to associate the rows with — and the
 * same indented rail the research sub-list uses once opened — so the group still
 * reads as one thing among the extra sources rather than as loose boxes, and a row
 * here looks and behaves exactly like a report row one section up. Always expanded
 * for a reason beyond consistency: with no flag to record, a collapsed group would
 * hide ticked ids that are still being sent.
 */
function PrototypeVisualSources({
  extras, t,
}: {
  readonly extras: PrototypeBuildControl['extras']
  readonly t: TFunction<'projectDetail'>
}) {
  const headingId = useId()
  // Nothing ready, nothing extracting and nothing failed: no images uploaded at
  // all, so there is nothing to offer and nothing to explain. Same rule as the
  // research box — a section whose only possible contribution is empty is an
  // invitation to a no-op.
  if (extras.visualOptions.length === 0
    && extras.visualsExtracting === 0
    && extras.visualsFailed === 0) return null

  return (
    // `role="group"` + `aria-labelledby`, so the tick-boxes are programmatically
    // associated with the heading that names them: without it the rows announce as
    // loose checkboxes with filenames and nothing says what selecting one does.
    // The research sub-list gets that association from its master checkbox; this
    // list has no master by design (there is no `use_visuals` field to hold), so
    // the association has to be stated.
    //
    // A role on the existing div rather than a `fieldset`/`legend`: it introduces
    // no new element, so the `ml-5 … border-l pl-2` rail and every text size stay
    // exactly as they were, and the heading keeps carrying the count.
    <div data-testid="prototype-visual-sources" role="group" aria-labelledby={headingId}>
      <p id={headingId} className="text-xs font-medium text-text">
        {/* `total`, not `count`: no plural suffixes to translate eight times for a
            number that only ever appears in parentheses, matching `useResearch`. */}
        {t('documents.prototype.visuals', { total: extras.visualOptions.length })}
      </p>
      {extras.visualOptions.length === 0 ? null : (
        <div data-testid="prototype-visual-list" className="ml-5 space-y-1 border-l pl-2">
          {extras.visualOptions.map((option) => {
            const checked = extras.selectedVisualIds.includes(option.doc_id)
            return (
              <SourceCheckbox
                key={option.doc_id}
                label={option.filename}
                checked={checked}
                // At the bound the unticked boxes stop accepting, rather than
                // letting the API refuse the whole build after the choice is made.
                disabled={!checked && extras.visualLimitReached}
                onChange={() => extras.onToggleVisualId(option.doc_id)}
              />
            )
          })}
        </div>
      )}
      {extras.visualLimitReached ? (
        <p className="text-xs text-warn">
          {t('documents.prototype.visualsLimit', { max: extras.maxVisualIds })}
        </p>
      ) : null}
      {/* Said rather than left to be noticed: these images exist in the Product
          tab, and a picker that lists two of the three a user just uploaded, with
          no explanation, reads as a bug. Non-image uploads get no note — a
          Markdown file is not a visual that failed to appear.

          TWO lines rather than one count, and independent so both can show at
          once: waiting resolves the first and never resolves the second. Under one
          "still being processed" line a failed extraction sent the user back to
          wait for something that will not arrive. */}
      {extras.visualsExtracting > 0 ? (
        <p className="text-xs text-muted">
          {t('documents.prototype.visualsNotReady', { total: extras.visualsExtracting })}
        </p>
      ) : null}
      {/* amber, not gray: this one asks for an action (upload the file again)
          rather than for patience, and amber-700 is the colour the other
          action-needed lines on this card use. */}
      {extras.visualsFailed > 0 ? (
        <p className="text-xs text-warn">
          {t('documents.prototype.visualsFailed', { total: extras.visualsFailed })}
        </p>
      ) : null}
    </div>
  )
}

/** One tick-box with a real label, so the whole row is a hit target and the
    accessible name comes from the label rather than from an aria-label. */
function SourceCheckbox({
  label, checked, disabled, onChange,
}: {
  readonly label: string
  readonly checked: boolean
  readonly disabled?: boolean
  readonly onChange: (next: boolean) => void
}) {
  return (
    <label className={clsx(
      'flex items-center gap-2 text-xs',
      // gray-500, not gray-400: #6b7280 clears 4.5:1 on white where #9ca3af does
      // not, and the disabled rows are the ones a user most needs to read to
      // understand why they cannot tick them.
      disabled === true ? 'text-muted' : 'text-text',
    )}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="rounded-sm"
      />
      {/* `title` because of `truncate`, not for the accessible name — that already
          comes from the label. Report titles are user-supplied and this column is
          narrow, so two reports named "Churn interviews Q1" and "Churn interviews
          Q2" render as the same visible string; the tooltip is the only way to tell
          which box is which. Sighted mouse users are exactly who needs it: a screen
          reader reads the full label regardless of the CSS clip. */}
      <span className="truncate" title={label}>{label}</span>
    </label>
  )
}
