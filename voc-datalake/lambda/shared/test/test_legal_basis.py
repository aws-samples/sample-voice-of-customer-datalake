"""shared/legal_basis.py: the legal basis every customer-data delete states."""
import pytest

from shared.legal_basis import LEGACY_LEGAL_BASIS, MAX_LEGAL_BASIS_CHARS, legal_basis_or_legacy, required_legal_basis


def test_a_basis_is_trimmed_and_bounded_at_300_characters():
    assert MAX_LEGAL_BASIS_CHARS == 300
    assert required_legal_basis('  GDPR art. 17 request #123 ') == 'GDPR art. 17 request #123'
    assert required_legal_basis('b' * 300) == 'b' * 300
    with pytest.raises(ValueError, match=r'^why must be at most 300 characters$'):
        required_legal_basis('b' * 301, 'why')


@pytest.mark.parametrize('value', [None, '', '   ', 7, ['GDPR']])
def test_a_missing_blank_or_non_text_basis_is_refused_naming_the_field(value):
    with pytest.raises(ValueError, match=r'^legal_basis is required: say why this data is deleted'):
        required_legal_basis(value)


@pytest.mark.parametrize(('stored', 'recorded'), [
    (' DPA with vendor X ', 'DPA with vendor X'),
    (None, LEGACY_LEGAL_BASIS),
    ('  ', LEGACY_LEGAL_BASIS),
    (12, LEGACY_LEGAL_BASIS),
])
def test_a_stored_basis_or_the_legacy_text(stored, recorded):
    assert legal_basis_or_legacy(stored) == recorded


def test_the_legacy_text_names_the_release():
    assert LEGACY_LEGAL_BASIS == 'not recorded (set before 6.00.00)'
