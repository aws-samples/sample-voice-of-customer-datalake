"""The Kiro export prompt "Copy to Kiro" pastes ahead of a document.

Since 3.00.00 there is ONE prompt, ``KIRO_DEFAULT_EXPORT_PROMPT``, served by
get_project as ``kiro_default_export_prompt``. A project's stored
``kiro_export_prompt`` (editable only on the removed Export / MCP tab) is never
read: create/update no longer write it and get_project does not return it. The
stored attribute stays in place, unused.
"""
from pathlib import Path
from unittest.mock import MagicMock, patch

from shared.project_access import Caller

# A signed-in workspace admin, the identity the handler fixture carries.
ADMIN_CALLER = Caller(subject='test-user-id', is_admin=True)

# The first sentence of KIRO_DEFAULT_EXPORT_PROMPT — distinctive enough to spot a
# copy of the text, and insensitive to reflowed whitespace. Defined once so the
# frontend and Python duplication guards cannot drift apart. Update this when the
# constant's opening sentence changes.
_FINGERPRINT = 'Build against the project material provided here rather than from assumptions'


def _repo_root() -> Path:
    """Return the voc-datalake repo root (4 levels above this file).

    Raises AssertionError if the resolved path does not look like the repo root,
    so a moved test file fails loudly instead of silently pytest.skip-ing the
    cross-language uniqueness guards.
    """
    root = Path(__file__).resolve().parents[3]
    assert (root / 'lambda').is_dir(), (
        f'Unexpected repo layout: expected a lambda/ directory at {root}. '
        f'If this test file was moved, update _repo_root() accordingly.'
    )
    return root


# ---------------------------------------------------------------------------
# The default text exists in exactly one place in the codebase
# ---------------------------------------------------------------------------

class TestKiroDefaultPromptIsUnique:
    """The default text must not be duplicated anywhere in the codebase."""

    def test_default_text_is_defined_in_projects_py(self):
        """KIRO_DEFAULT_EXPORT_PROMPT constant exists in projects.py."""
        from projects import KIRO_DEFAULT_EXPORT_PROMPT
        assert KIRO_DEFAULT_EXPORT_PROMPT, 'KIRO_DEFAULT_EXPORT_PROMPT must not be empty'
        assert 'Build against the project material provided here' in KIRO_DEFAULT_EXPORT_PROMPT

    def test_default_text_not_duplicated_in_frontend(self):
        """A distinctive line from the default is not copied into any non-test .ts/.tsx file.

        If it appears in a production source file it means the frontend has its
        own copy, which would diverge from the backend constant when the wording
        changes. Test files may reference it as expected values — those are fine.
        """
        fingerprint = _FINGERPRINT
        frontend_root = _repo_root() / 'frontend' / 'src'
        # Assert rather than skip: a skip here would let the guard pass silently
        # if the tree were ever laid out differently, which is exactly the case
        # the guard exists to catch.
        assert frontend_root.is_dir(), (
            f'Expected the frontend source tree at {frontend_root}. Without it this '
            f'uniqueness guard cannot check for a duplicated default prompt.'
        )

        duplicates = []
        for ts_file in list(frontend_root.rglob('*.ts')) + list(frontend_root.rglob('*.tsx')):
            # Test / story / fixture files are allowed to reference the text as
            # expected values — they are not production source.
            name = ts_file.name
            if '.test.' in name or '.spec.' in name or '.stories.' in name:
                continue
            # Also skip files nested inside test or mock directories.
            if '__tests__' in ts_file.parts or '__mocks__' in ts_file.parts:
                continue
            if fingerprint in ts_file.read_text(encoding='utf-8'):
                duplicates.append(str(ts_file.relative_to(_repo_root())))

        assert duplicates == [], (
            f'The Kiro default prompt text is duplicated in the following frontend '
            f'production files: {duplicates}. The single source of truth is '
            f'KIRO_DEFAULT_EXPORT_PROMPT in lambda/api/projects.py. '
            f'The frontend reads it from the API response (kiro_default_export_prompt).'
        )

    def test_default_text_not_duplicated_in_other_python_files(self):
        """The constant must not be copy-pasted into other Python production files."""
        fingerprint = _FINGERPRINT
        # No existence check needed: _repo_root() already asserts lambda/ is a dir.
        lambda_root = _repo_root() / 'lambda'

        duplicates = []
        for py_file in lambda_root.rglob('*.py'):
            # Skip __pycache__, the defining file itself, and test/fixture files.
            if '__pycache__' in py_file.parts:
                continue
            if py_file.name == 'projects.py' and py_file.parent.name == 'api':
                continue
            # Test files and conftest are allowed to reference the constant as
            # expected values — they are not production source.
            if py_file.name.startswith('test_') or py_file.name == 'conftest.py':
                continue
            text = py_file.read_text(encoding='utf-8')
            if fingerprint in text:
                duplicates.append(str(py_file.relative_to(_repo_root())))

        assert duplicates == [], (
            f'The Kiro default prompt text is duplicated in Python production files '
            f'outside lambda/api/projects.py: {duplicates}.'
        )


# ---------------------------------------------------------------------------
# The stored per-project prompt is no longer written or read
# ---------------------------------------------------------------------------

def _meta(**fields) -> dict:
    return {'pk': 'PROJECT#p1', 'sk': 'META', 'project_id': 'p1', 'name': 'Test', **fields}


class TestStoredPromptIsUnused:
    @patch('projects.projects_table', new=MagicMock())
    def test_create_project_no_longer_stores_a_prompt(self):
        from projects import create_project
        item = create_project({'name': 'New Project', 'kiro_export_prompt': 'Use Rust.'}, ADMIN_CALLER)['project']
        assert 'kiro_export_prompt' not in item

    def test_update_project_ignores_the_prompt(self):
        with patch('projects.projects_table') as mock_table:
            from projects import update_project
            assert update_project('p1', {'name': 'Renamed', 'kiro_export_prompt': 'Use Rust.'})['success'] is True
            call_kwargs = mock_table.update_item.call_args[1]
            assert 'kiro_export_prompt' not in call_kwargs['UpdateExpression']
            assert 'Use Rust.' not in call_kwargs['ExpressionAttributeValues'].values()

    @patch('projects.projects_table')
    def test_get_project_serves_the_default_and_drops_a_stored_prompt(self, mock_table):
        from projects import KIRO_DEFAULT_EXPORT_PROMPT, get_project
        mock_table.query.return_value = {'Items': [_meta(kiro_export_prompt='Use Rust only.')]}
        project = get_project('p1')['project']
        assert project['kiro_default_export_prompt'] == KIRO_DEFAULT_EXPORT_PROMPT
        assert 'kiro_export_prompt' not in project

    @patch('projects.projects_table')
    def test_get_project_without_a_stored_prompt(self, mock_table):
        from projects import KIRO_DEFAULT_EXPORT_PROMPT, get_project
        mock_table.query.return_value = {'Items': [_meta()]}
        project = get_project('p1')['project']
        assert project['kiro_default_export_prompt'] == KIRO_DEFAULT_EXPORT_PROMPT
        assert 'kiro_export_prompt' not in project
