import { useId } from 'react'
import { useTranslation } from 'react-i18next'

interface NameFieldsProps {
  readonly givenName: string
  readonly familyName: string
  readonly onGivenNameChange: (value: string) => void
  readonly onFamilyNameChange: (value: string) => void
}

export default function NameFields({
  givenName, familyName, onGivenNameChange, onFamilyNameChange,
}: NameFieldsProps) {
  const { t } = useTranslation('components')
  // Each label names its input (it used to name nothing, so screen readers read a bare text box).
  const givenId = useId()
  const familyId = useId()
  return (
    <>
      <div>
        <label htmlFor={givenId} className="block text-sm font-medium text-text mb-1">
          {t('userAdmin.firstNameLabel')}
        </label>
        <input
          id={givenId}
          type="text"
          value={givenName}
          onChange={(e) => onGivenNameChange(e.target.value)}
          placeholder="Jane"
          className="input"
        />
      </div>
      <div>
        <label htmlFor={familyId} className="block text-sm font-medium text-text mb-1">
          {t('userAdmin.lastNameLabel')}
        </label>
        <input
          id={familyId}
          type="text"
          value={familyName}
          onChange={(e) => onFamilyNameChange(e.target.value)}
          placeholder="Doe"
          className="input"
        />
      </div>
    </>
  )
}
