"""
Additional coverage tests for shared.prompts module.
Targets uncovered lines: 23, 28 (get_prompts_dir local/cwd path resolution).
"""

import pytest
from unittest.mock import patch, MagicMock
from pathlib import Path


class TestGetPromptsDirLocalPath:
    """Tests for get_prompts_dir local development path (line 23) and cwd path (line 28)."""

    @patch('shared.prompts.Path')
    def test_returns_local_path_when_lambda_path_missing(self, mock_path_cls):
        """Returns local development path when Lambda path doesn't exist."""
        from shared.prompts import get_prompts_dir

        call_count = [0]
        paths = {}

        def make_path(arg=None):
            if arg == '/var/task/prompts':
                p = MagicMock(spec=Path)
                p.exists.return_value = False
                return p
            # For Path(__file__), return a mock that chains .parent.parent.parent / 'prompts'
            p = MagicMock(spec=Path)
            p.parent = MagicMock(spec=Path)
            p.parent.parent = MagicMock(spec=Path)
            p.parent.parent.parent = MagicMock(spec=Path)
            local_prompts = MagicMock(spec=Path)
            local_prompts.exists.return_value = True
            p.parent.parent.parent.__truediv__ = lambda self, x: local_prompts
            paths['local'] = local_prompts
            return p

        mock_path_cls.side_effect = make_path

        result = get_prompts_dir()
        assert result == paths['local']

    @patch('shared.prompts.Path')
    def test_returns_cwd_path_when_others_missing(self, mock_path_cls):
        """Returns cwd path when Lambda and local paths don't exist."""
        from shared.prompts import get_prompts_dir

        cwd_prompts = MagicMock(spec=Path)
        cwd_prompts.exists.return_value = True

        cwd_mock = MagicMock(spec=Path)
        cwd_mock.__truediv__ = lambda self, x: cwd_prompts

        def make_path(arg=None):
            if arg == '/var/task/prompts':
                p = MagicMock(spec=Path)
                p.exists.return_value = False
                return p
            # For Path(__file__)
            p = MagicMock(spec=Path)
            p.parent = MagicMock(spec=Path)
            p.parent.parent = MagicMock(spec=Path)
            p.parent.parent.parent = MagicMock(spec=Path)
            local_prompts = MagicMock(spec=Path)
            local_prompts.exists.return_value = False
            p.parent.parent.parent.__truediv__ = lambda self, x: local_prompts
            return p

        mock_path_cls.side_effect = make_path
        mock_path_cls.cwd.return_value = cwd_mock

        result = get_prompts_dir()
        assert result == cwd_prompts
