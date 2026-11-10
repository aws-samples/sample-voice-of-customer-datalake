/**
 * @fileoverview The name + description fields shared by the Create and Edit
 * project dialogs, so both label, describe and validate them the same way.
 *
 * @module pages/Projects/ProjectFormFields
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'

interface ProjectFormFieldsProps {
  readonly name: string
  readonly description: string
  readonly onNameChange: (name: string) => void
  readonly onDescriptionChange: (description: string) => void
  /** Translated message shown under the name (and announced with it); null when valid. */
  readonly nameError?: string | null
}

export default function ProjectFormFields({
  name, description, onNameChange, onDescriptionChange, nameError = null,
}: ProjectFormFieldsProps) {
  const { t } = useTranslation('projects')
  const nameId = useId()
  const nameErrorId = useId()
  const descriptionId = useId()
  return (
    <>
      <div>
        <label htmlFor={nameId} className="block text-sm font-medium text-text mb-1">{t('createModal.nameLabel')}</label>
        <input
          id={nameId}
          type="text"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('createModal.namePlaceholder')}
          className="input"
          required
          aria-invalid={nameError !== null}
          aria-describedby={nameError === null ? undefined : nameErrorId}
        />
        {nameError === null ? null : <p id={nameErrorId} className="mt-1 text-xs text-danger">{nameError}</p>}
      </div>
      <div>
        <label htmlFor={descriptionId} className="block text-sm font-medium text-text mb-1">{t('createModal.descriptionLabel')}</label>
        <textarea
          id={descriptionId}
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          placeholder={t('createModal.descriptionPlaceholder')}
          rows={3}
          className="input"
        />
      </div>
    </>
  )
}
