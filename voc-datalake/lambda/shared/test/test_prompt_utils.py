"""Tests for shared.prompts module."""
import pytest
from unittest.mock import patch, mock_open, MagicMock
from pathlib import Path


class TestGetPromptsDir:
    @patch('shared.prompts.Path')
    def test_returns_lambda_path(self, mp):
        from shared.prompts import get_prompts_dir
        d = {}
        def pi(s):
            p = MagicMock(spec=Path)
            d[s] = p
            p.exists.return_value = (s == '/var/task/prompts')
            return p
        mp.side_effect = pi
        assert get_prompts_dir() == d['/var/task/prompts']

    def test_real_resolution(self):
        from shared.prompts import get_prompts_dir
        try:
            assert get_prompts_dir().exists()
        except FileNotFoundError:
            pytest.skip("No prompts dir")

    def test_raises_not_found(self, tmp_path):
        """get_prompts_dir raises FileNotFoundError when no dir exists."""
        from shared.prompts import get_prompts_dir
        # Patch __file__ to point to a location with no prompts dir nearby
        str(tmp_path / "shared" / "prompts.py")
        with patch('shared.prompts.Path') as mp:
            mock_false = MagicMock()
            mock_false.exists.return_value = False
            mp.return_value = mock_false
            mp.cwd.return_value = mock_false
            mock_false.__truediv__ = lambda self, x: mock_false
            mock_false.parent = mock_false
            with pytest.raises(FileNotFoundError):
                get_prompts_dir()


class TestLoadPromptFile:
    def setup_method(self):
        from shared.prompts import load_prompt_file
        load_prompt_file.cache_clear()

    @patch('shared.prompts.get_prompts_dir')
    def test_loads_json(self, md):
        from shared.prompts import load_prompt_file
        mp = MagicMock()
        md.return_value = mp
        fp = MagicMock(exists=MagicMock(return_value=True))
        mp.__truediv__ = lambda s, x: fp
        with patch('builtins.open', mock_open(read_data='{"k":"v"}')):
            assert load_prompt_file('t.json') == {'k': 'v'}

    @patch('shared.prompts.get_prompts_dir')
    def test_missing_file(self, md):
        from shared.prompts import load_prompt_file
        mp = MagicMock()
        md.return_value = mp
        fp = MagicMock(exists=MagicMock(return_value=False))
        mp.__truediv__ = lambda s, x: fp
        with pytest.raises(FileNotFoundError):
            load_prompt_file('x.json')

    @patch('shared.prompts.get_prompts_dir')
    def test_caches(self, md):
        from shared.prompts import load_prompt_file
        mp = MagicMock()
        md.return_value = mp
        fp = MagicMock(exists=MagicMock(return_value=True))
        mp.__truediv__ = lambda s, x: fp
        with patch('builtins.open', mock_open(read_data='{"a":1}')):
            assert load_prompt_file('c.json') is load_prompt_file('c.json')


class TestFormatPrompt:
    def test_simple(self):
        from shared.prompts import format_prompt
        assert format_prompt("Hi {n}", n="A") == "Hi A"

    def test_missing(self):
        from shared.prompts import format_prompt
        r = format_prompt("{a} {b}", a="X")
        assert "X" in r and "{b}" in r

    def test_plain(self):
        from shared.prompts import format_prompt
        assert format_prompt("plain") == "plain"

    def test_int(self):
        from shared.prompts import format_prompt
        assert format_prompt("{n}", n=42) == "42"


class TestBuildChainSteps:
    @patch('shared.prompts.load_prompt_file')
    def test_builds(self, ml):
        from shared.prompts import build_chain_steps
        ml.return_value = {'steps': {'s1': {
            'system_prompt': 'S1', 'user_prompt_template': '{x}',
            'max_tokens': 2000, 'thinking_budget': 0, 'name': 'N1'}}}
        r = build_chain_steps('f.json', ['s1'], {'x': 'D'})
        assert r[0]['system'] == 'S1' and r[0]['user'] == 'D'

    @patch('shared.prompts.load_prompt_file')
    def test_missing_step(self, ml):
        from shared.prompts import build_chain_steps
        ml.return_value = {'steps': {'s1': {}}}
        with pytest.raises(KeyError):
            build_chain_steps('f.json', ['bad'], {})

    @patch('shared.prompts.load_prompt_file')
    def test_language(self, ml):
        from shared.prompts import build_chain_steps
        ml.return_value = {'steps': {'s1': {
            'system_prompt': 'B', 'user_prompt_template': ''}}}
        r = build_chain_steps('f.json', ['s1'], {'response_language': 'es'})
        assert 'Spanish' in r[0]['system']

    @patch('shared.prompts.load_prompt_file')
    def test_defaults(self, ml):
        from shared.prompts import build_chain_steps
        ml.return_value = {'steps': {'s1': {}}}
        r = build_chain_steps('f.json', ['s1'], {})
        assert r[0]['max_tokens'] == 4096


class TestGetResponseLanguageInstruction:
    def test_none(self):
        from shared.prompts import get_response_language_instruction as f
        assert f(None) == ''

    def test_en(self):
        from shared.prompts import get_response_language_instruction as f
        assert f('en') == ''

    def test_es(self):
        from shared.prompts import get_response_language_instruction as f
        assert 'Spanish' in f('es')

    def test_unknown(self):
        from shared.prompts import get_response_language_instruction as f
        assert 'xx' in f('xx')

    def test_all(self):
        from shared.prompts import get_response_language_instruction as f
        for c in ['es', 'fr', 'de', 'pt', 'ja', 'zh', 'ko']:
            assert f(c) != ''


class TestConvenienceFunctions:
    @patch('shared.prompts.build_chain_steps')
    def test_persona(self, mb):
        from shared.prompts import get_persona_generation_steps
        mb.return_value = []
        get_persona_generation_steps(3, 's', 'fb', 'custom', 'es')
        assert mb.call_args[0][0] == 'persona-generation.json'

    @patch('shared.prompts.build_chain_steps')
    def test_persona_truncates(self, mb):
        from shared.prompts import get_persona_generation_steps
        mb.return_value = []
        get_persona_generation_steps(3, 's', 'x' * 20000)
        assert len(mb.call_args[0][2]['feedback_sample']) == 15000

    @patch('shared.prompts.build_chain_steps')
    def test_persona_no_custom(self, mb):
        from shared.prompts import get_persona_generation_steps
        mb.return_value = []
        get_persona_generation_steps(3, 's', 'fb')
        assert mb.call_args[0][2]['custom_section'] == ''

    @patch('shared.prompts.build_chain_steps')
    def test_prd(self, mb):
        from shared.prompts import get_prd_generation_steps
        mb.return_value = []
        get_prd_generation_steps('F', 'p', 'fb', 'fr')
        assert mb.call_args[0][0] == 'prd-generation.json'

    @patch('shared.prompts.build_chain_steps')
    def test_prfaq(self, mb):
        from shared.prompts import get_prfaq_generation_steps
        mb.return_value = []
        get_prfaq_generation_steps('F', 'p', 'fb')
        assert mb.call_args[0][0] == 'prfaq-generation.json'

    @patch('shared.prompts.build_chain_steps')
    def test_research(self, mb):
        from shared.prompts import get_research_analysis_steps
        mb.return_value = []
        get_research_analysis_steps('Q?', 's', 'fb', 50, 'ko')
        assert mb.call_args[0][2]['feedback_count'] == 50

    @patch('shared.prompts.load_prompt_file')
    def test_avatar(self, ml):
        from shared.prompts import get_avatar_prompt_config
        ml.return_value = {}
        get_avatar_prompt_config()
        ml.assert_called_with('avatar-generation.json')
