import { useTranslation } from 'react-i18next'

interface NameFieldsProps {
  readonly givenName: string
  readonly familyName: string
  readonly onGivenNameChange: (value: string) => void
  readonly onFamilyNameChange: (value: string) => void
  readonly autoFocusFirst?: boolean
}

export default function NameFields({
  givenName, familyName, onGivenNameChange, onFamilyNameChange, autoFocusFirst,
}: NameFieldsProps) {
  const { t } = useTranslation('components')
  return (
    <>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {t('userAdmin.firstNameLabel')}
        </label>
        <input
          type="text"
          value={givenName}
          onChange={(e) => onGivenNameChange(e.target.value)}
          placeholder="Jane"
          className="input"
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus={autoFocusFirst}
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {t('userAdmin.lastNameLabel')}
        </label>
        <input
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
