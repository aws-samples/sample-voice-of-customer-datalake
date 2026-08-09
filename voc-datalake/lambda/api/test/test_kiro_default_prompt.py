"""Tests for the Kiro default export prompt feature.

Covers acceptance criteria 1–5 and 8–9 from the task specification:
 1. Steering file contains the default for a project with empty/absent/whitespace
    kiro_export_prompt.
 2. A project with its own non-empty value gets that value, not the default.
 3. The default text exists in exactly one place in the codebase.
 4. Project creation still stores an empty value (default applied at read time).
 5. get_project response exposes both the stored value and the default.
 8. Clearing the field returns the project to following the default.
"""
import re
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest


def _repo_root() -> Path:
    # lambda/api/test/ -> voc-datalake/
    return Path(__file__).resolve().parents[3]


def _read(relative: str) -> str:
    path = _repo_root() / relative
    assert path.is_file(), f'{relative} not found — did the file move?'
    return path.read_text(encoding='utf-8')


# ---------------------------------------------------------------------------
# Criterion 3 — The default text exists in exactly one place in the codebase
# ---------------------------------------------------------------------------

class TestKiroDefaultPromptIsUnique:
    """The default text must not be duplicated anywhere in the codebase."""

    def test_default_text_is_defined_in_projects_py(self):
        """KIRO_DEFAULT_EXPORT_PROMPT constant exists in projects.py."""
        from projects import KIRO_DEFAULT_EXPORT_PROMPT
        assert KIRO_DEFAULT_EXPORT_PROMPT, 'KIRO_DEFAULT_EXPORT_PROMPT must not be empty'
        assert 'Build against the material in this workspace' in KIRO_DEFAULT_EXPORT_PROMPT

    def test_default_text_not_duplicated_in_frontend(self):
        """A distinctive line from the default is not copied into any non-test .ts/.tsx file.

        If it appears in a production source file it means the frontend has its
        own copy, which would diverge from the backend constant when the wording
        changes. Test files may reference it as expected values — those are fine.
        """
        from projects import KIRO_DEFAULT_EXPORT_PROMPT
        # Use the first sentence as the fingerprint — distinctive enough to
        # reliably identify a duplicate but not dependent on whitespace.
        fingerprint = 'Build against the material in this workspace rather than from assumptions'
        frontend_root = _repo_root() / 'frontend' / 'src'
        if not frontend_root.is_dir():
            pytest.skip('frontend/src not present in this tree')

        duplicates = []
        for ts_file in list(frontend_root.rglob('*.ts')) + list(frontend_root.rglob('*.tsx')):
            # Test files are allowed to reference the text as expected values.
            if '.test.' in ts_file.name:
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
        from projects import KIRO_DEFAULT_EXPORT_PROMPT
        fingerprint = 'Build against the material in this workspace rather than from assumptions'
        lambda_root = _repo_root() / 'lambda'
        if not lambda_root.is_dir():
            pytest.skip('lambda/ not present in this tree')

        duplicates = []
        for py_file in lambda_root.rglob('*.py'):
            # Skip __pycache__, the defining file itself, and test files.
            if '__pycache__' in py_file.parts:
                continue
            if py_file.name == 'projects.py' and py_file.parent.name == 'api':
                continue
            # Test files are allowed to reference the constant as expected values.
            if py_file.name.startswith('test_'):
                continue
            text = py_file.read_text(encoding='utf-8')
            if fingerprint in text:
                duplicates.append(str(py_file.relative_to(_repo_root())))

        assert duplicates == [], (
            f'The Kiro default prompt text is duplicated in Python production files '
            f'outside lambda/api/projects.py: {duplicates}.'
        )


# ---------------------------------------------------------------------------
# Criterion 1 — Default used when kiro_export_prompt is empty/absent/whitespace
# ---------------------------------------------------------------------------

class TestBuildSteeringFileUsesDefault:
    """_build_steering_file falls back to KIRO_DEFAULT_EXPORT_PROMPT."""

    def test_empty_kiro_export_prompt_uses_default(self):
        from projects import _build_steering_file, KIRO_DEFAULT_EXPORT_PROMPT
        project = {'name': 'Test', 'kiro_export_prompt': ''}
        result = _build_steering_file(project, [], [])
        assert KIRO_DEFAULT_EXPORT_PROMPT in result

    def test_absent_kiro_export_prompt_uses_default(self):
        from projects import _build_steering_file, KIRO_DEFAULT_EXPORT_PROMPT
        project = {'name': 'Test'}
        result = _build_steering_file(project, [], [])
        assert KIRO_DEFAULT_EXPORT_PROMPT in result

    def test_whitespace_only_kiro_export_prompt_uses_default(self):
        from projects import _build_steering_file, KIRO_DEFAULT_EXPORT_PROMPT
        project = {'name': 'Test', 'kiro_export_prompt': '   \n\t  '}
        result = _build_steering_file(project, [], [])
        assert KIRO_DEFAULT_EXPORT_PROMPT in result

    def test_steering_file_always_has_custom_instructions_section(self):
        """The ## Custom Instructions section is always present now."""
        from projects import _build_steering_file
        project = {'name': 'Test', 'kiro_export_prompt': ''}
        result = _build_steering_file(project, [], [])
        assert '## Custom Instructions' in result


# ---------------------------------------------------------------------------
# Criterion 2 — Project's own value is used instead of the default
# ---------------------------------------------------------------------------

class TestBuildSteeringFileUsesCustomPrompt:
    """A non-empty kiro_export_prompt is used and the default is not."""

    def test_custom_prompt_appears_in_steering_file(self):
        from projects import _build_steering_file, KIRO_DEFAULT_EXPORT_PROMPT
        custom = 'Use only TypeScript. No classes. Pure functions only.'
        project = {'name': 'Test', 'kiro_export_prompt': custom}
        result = _build_steering_file(project, [], [])
        assert custom in result

    def test_default_not_used_when_custom_prompt_set(self):
        from projects import _build_steering_file, KIRO_DEFAULT_EXPORT_PROMPT
        custom = 'Use only TypeScript. No classes. Pure functions only.'
        project = {'name': 'Test', 'kiro_export_prompt': custom}
        result = _build_steering_file(project, [], [])
        assert KIRO_DEFAULT_EXPORT_PROMPT not in result


# ---------------------------------------------------------------------------
# Criterion 4 — Project creation stores an empty value
# ---------------------------------------------------------------------------

class TestCreateProjectStoresEmptyPrompt:
    """create_project must store kiro_export_prompt as '' (not the default)."""

    @patch('projects.projects_table')
    def test_create_project_stores_empty_kiro_export_prompt(self, mock_table):
        from projects import create_project
        result = create_project({'name': 'New Project'})
        item = result['project']
        assert 'kiro_export_prompt' in item
        assert item['kiro_export_prompt'] == '', (
            'kiro_export_prompt must default to empty at creation time so that '
            'future changes to the default wording reach this project.'
        )

    @patch('projects.projects_table')
    def test_create_project_does_not_seed_default_text(self, mock_table):
        """The default text must never be written into the stored record."""
        from projects import create_project, KIRO_DEFAULT_EXPORT_PROMPT
        result = create_project({'name': 'New Project'})
        item = result['project']
        assert item.get('kiro_export_prompt', '') != KIRO_DEFAULT_EXPORT_PROMPT, (
            'The default text must not be written into new project records. '
            'Doing so would freeze today\'s wording and hide future improvements.'
        )


# ---------------------------------------------------------------------------
# Criterion 5 — get_project exposes both stored value and the default
# ---------------------------------------------------------------------------

class TestGetProjectExposesDefault:
    """get_project response carries kiro_default_export_prompt."""

    @patch('projects.projects_table')
    def test_get_project_includes_kiro_default_export_prompt(self, mock_table):
        mock_table.query.return_value = {
            'Items': [
                {'pk': 'PROJECT#p1', 'sk': 'META', 'project_id': 'p1', 'name': 'Test',
                 'kiro_export_prompt': ''},
            ]
        }
        from projects import get_project, KIRO_DEFAULT_EXPORT_PROMPT
        result = get_project('p1')
        project = result['project']
        assert 'kiro_default_export_prompt' in project, (
            'get_project must return kiro_default_export_prompt so the frontend '
            'can distinguish "no override" from "custom override".'
        )
        assert project['kiro_default_export_prompt'] == KIRO_DEFAULT_EXPORT_PROMPT

    @patch('projects.projects_table')
    def test_get_project_preserved_stored_empty_value(self, mock_table):
        """The stored empty value is NOT replaced by the default in the response."""
        mock_table.query.return_value = {
            'Items': [
                {'pk': 'PROJECT#p1', 'sk': 'META', 'project_id': 'p1', 'name': 'Test',
                 'kiro_export_prompt': ''},
            ]
        }
        from projects import get_project, KIRO_DEFAULT_EXPORT_PROMPT
        result = get_project('p1')
        project = result['project']
        # The stored field stays empty so the caller can tell the difference.
        assert project.get('kiro_export_prompt', None) == '', (
            'The stored kiro_export_prompt must not be overwritten in the response. '
            'The frontend needs the empty value to know this project follows the default.'
        )

    @patch('projects.projects_table')
    def test_get_project_custom_prompt_alongside_default(self, mock_table):
        """A project with its own prompt exposes both the custom and the default."""
        custom = 'Use Rust only.'
        mock_table.query.return_value = {
            'Items': [
                {'pk': 'PROJECT#p1', 'sk': 'META', 'project_id': 'p1', 'name': 'Test',
                 'kiro_export_prompt': custom},
            ]
        }
        from projects import get_project, KIRO_DEFAULT_EXPORT_PROMPT
        result = get_project('p1')
        project = result['project']
        assert project['kiro_export_prompt'] == custom
        assert project['kiro_default_export_prompt'] == KIRO_DEFAULT_EXPORT_PROMPT


# ---------------------------------------------------------------------------
# Criterion 8 — Clearing the field returns the project to the default
# ---------------------------------------------------------------------------

class TestClearingPromptReturnsToDefault:
    """After clearing kiro_export_prompt the steering file uses the default again."""

    def test_cleared_prompt_uses_default_in_steering_file(self):
        from projects import _build_steering_file, KIRO_DEFAULT_EXPORT_PROMPT
        # Simulate a project that previously had a custom prompt, then it was cleared.
        project = {'name': 'Test', 'kiro_export_prompt': ''}
        result = _build_steering_file(project, [], [])
        assert KIRO_DEFAULT_EXPORT_PROMPT in result

    def test_cleared_prompt_does_not_store_default_text(self):
        """Clearing is represented as empty string, not the default text written in."""
        from projects import KIRO_DEFAULT_EXPORT_PROMPT
        # The update path passes '' when clearing — verify update_project accepts it.
        with patch('projects.projects_table') as mock_table:
            from projects import update_project
            result = update_project('p1', {'kiro_export_prompt': ''})
            assert result['success'] is True
            # Verify the empty string was written, not the default
            call_kwargs = mock_table.update_item.call_args[1]
            stored_value = call_kwargs['ExpressionAttributeValues'][':kiro_prompt']
            assert stored_value == '', (
                'Clearing kiro_export_prompt must store empty string, '
                'not the default text. The default is applied at read time only.'
            )
            assert stored_value != KIRO_DEFAULT_EXPORT_PROMPT
