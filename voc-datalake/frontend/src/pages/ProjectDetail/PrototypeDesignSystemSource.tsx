/**
 * @fileoverview The "Design system" row of the prototype build wizard's "Also read
 * (optional)" list.
 *
 * Same tick-box as the product description beside it, with a short label and one line
 * under it saying what will be read ("Uses its colours, type and guidelines") — on the
 * line rather than in the label, which the narrow dialog would truncate — so a person can
 * tell an empty-looking design system from a full one without leaving the dialog. With none set up the box is
 * shown DISABLED rather than hidden, with the reason and a link to where it is set up:
 * unlike research or visuals (project inputs that simply do not exist yet), a design
 * system is a company setting people may not know about, and the dialog is where they
 * learn that prototypes can follow it.
 *
 * @module pages/ProjectDetail/PrototypeDesignSystemSource
 */

import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { SourceCheckbox } from './PrototypeSourceCheckbox'
import type { DesignSystemContents, PrototypeDesignSystemOption } from './usePrototypeDesignSystem'
import type { TFunction } from 'i18next'

/** Where the design system is set up (Knowledge → Company → Design system). */
const DESIGN_SYSTEM_PATH = '/company?tab=design'

/** The parts the prompt will read, translated, in label order. */
function contentParts(contents: DesignSystemContents, t: TFunction<'projectDetail'>): string[] {
  return [
    contents.colours ? t('documents.prototype.designSystemParts.colours') : null,
    contents.type ? t('documents.prototype.designSystemParts.type') : null,
    contents.spacing ? t('documents.prototype.designSystemParts.spacing') : null,
    contents.guidelines ? t('documents.prototype.designSystemParts.guidelines') : null,
    contents.components > 0
      ? t('documents.prototype.designSystemParts.components', { count: contents.components })
      : null,
    contents.references > 0
      ? t('documents.prototype.designSystemParts.references', { count: contents.references })
      : null,
  ].filter((part): part is string => part !== null)
}

function noop(): void {
  // A disabled box never changes; `SourceCheckbox` still needs a handler.
}

export function PrototypeDesignSystemSource({
  option, t,
}: {
  readonly option: PrototypeDesignSystemOption
  readonly t: TFunction<'projectDetail'>
}) {
  const { i18n } = useTranslation()
  const hintId = useId()

  // Not read yet, or the read failed: no row (never an unticked box that ticks itself a
  // moment later), and the request omits the field so the build behaves as it did
  // before this option existed. The page reads it on load, so by the time the dialog
  // opens it is normally there.
  if (!option.known) return null

  if (!option.available) {
    return (
      <div data-testid="prototype-design-system">
        <SourceCheckbox
          label={t('documents.prototype.designSystem')}
          checked={false}
          disabled
          describedBy={hintId}
          onChange={noop}
        />
        <p id={hintId} className="ml-5 text-xs text-muted">
          {t('documents.prototype.designSystemNoneHint')}{' '}
          <Link to={DESIGN_SYSTEM_PATH} className="link">{t('documents.prototype.designSystemSetUp')}</Link>
        </p>
      </div>
    )
  }

  const parts = new Intl.ListFormat(i18n.language, { style: 'long', type: 'conjunction' })
    .format(contentParts(option.contents, t))
  return (
    <div data-testid="prototype-design-system">
      <SourceCheckbox
        label={t('documents.prototype.designSystem')}
        checked={option.use}
        describedBy={hintId}
        onChange={option.onToggle}
      />
      <p id={hintId} className="ml-5 text-xs text-muted">{t('documents.prototype.designSystemUses', { parts })}</p>
    </div>
  )
}
