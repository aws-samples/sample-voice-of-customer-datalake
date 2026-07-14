"""Tests for shared.prompts module."""
import re

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


# Repo location of the prompt files (the production loader's local fallback
# doesn't resolve from the test cwd). Single definition so the contract
# fixture and the encoding test can't drift independently.
REPO_PROMPTS_DIR = Path(__file__).resolve().parents[2] / 'api' / 'prompts'


class TestPrfaqPromptContract:
    """Pin the PR/FAQ prompt file to the chain code's contract (issue #93).

    format_prompt leaves unknown placeholders untouched, so a typo like
    {lauch_date} silently reaches the LLM as literal text — these tests make
    that a build failure instead of a quiet quality regression.

    Every test loads the file through the production loader
    (get_prompts_dir + load_prompt_file), so a relocated prompts directory
    can't leave them passing against a stale copy.
    """

    # Builder parameters that ARE template slots, and those that are not
    # (consumed as a system-prompt instruction). A new parameter must be
    # classified here explicitly — the drift test below fails loudly on
    # anything unrecognized rather than silently trusting it is a slot.
    KNOWN_SLOT_PARAMS = {
        'feature_idea', 'personas_context', 'feedback_context', 'product_context',
    }
    KNOWN_NON_SLOT_PARAMS = {'response_language'}

    # Slots the chain builder supplies: the classified signature params plus
    # the internally generated launch_date and executor-substituted previous.
    SUPPLIED_PLACEHOLDERS = KNOWN_SLOT_PARAMS | {'launch_date', 'previous'}

    # Slots each step MUST keep: dropping one silently severs the LLM from
    # its grounding data (the reverse failure mode of an unknown placeholder).
    # customer_thinking carries the four context slots; later steps are
    # grounded through {previous}; press_release also needs {launch_date}.
    REQUIRED_PLACEHOLDERS = {
        'customer_thinking': KNOWN_SLOT_PARAMS,
        'press_release': {'launch_date', 'previous'},
        'customer_faq': {'previous'},
        'internal_faq': {'previous'},
    }

    def test_builder_signature_has_no_unclassified_parameters(self):
        """Fail loudly when get_prfaq_generation_steps gains a parameter this
        test doesn't know about, instead of silently assuming it is a slot."""
        import inspect
        from shared.prompts import get_prfaq_generation_steps
        params = set(inspect.signature(get_prfaq_generation_steps).parameters)
        unclassified = params - self.KNOWN_SLOT_PARAMS - self.KNOWN_NON_SLOT_PARAMS
        assert not unclassified, (
            f"new builder parameter(s) {unclassified}: classify as slot or "
            "non-slot in TestPrfaqPromptContract"
        )
        missing = (self.KNOWN_SLOT_PARAMS | self.KNOWN_NON_SLOT_PARAMS) - params
        assert not missing, f"classified parameter(s) no longer exist: {missing}"

    @pytest.fixture(autouse=True)
    def _route_loader_at_repo_prompts(self, monkeypatch):
        """Point the production loader at the repo's prompts dir (the local
        fallback in get_prompts_dir doesn't resolve from the test cwd).

        Deliberately autouse for the whole class: the cache_clear is a no-op
        for tests that never load, and a class-wide route means no test can
        accidentally read a stale copy. Loading the real file through
        load_prompt_file also partially covers its explicit UTF-8 encoding
        (the file carries em dashes and typographic quotes)."""
        import shared.prompts as prompts_module
        assert REPO_PROMPTS_DIR.exists(), (
            f'prompts directory moved? expected it at {REPO_PROMPTS_DIR} — '
            'update REPO_PROMPTS_DIR alongside the relocation'
        )
        monkeypatch.setattr(prompts_module, 'get_prompts_dir', lambda: REPO_PROMPTS_DIR)
        prompts_module.load_prompt_file.cache_clear()
        yield
        prompts_module.load_prompt_file.cache_clear()

    @staticmethod
    def _load():
        from shared.prompts import load_prompt_file
        return load_prompt_file('prfaq-generation.json')

    def test_has_the_four_chain_steps_in_code_order(self):
        config = self._load()
        assert list(config['steps']) == [
            'customer_thinking', 'press_release', 'customer_faq', 'internal_faq',
        ]

    def test_every_placeholder_is_supplied_by_the_chain_builder(self):
        config = self._load()
        for index, (name, step) in enumerate(config['steps'].items()):
            searched = step['user_prompt_template'] + '\n' + step.get('system_prompt', '')
            # Broad pattern on purpose: malformed slots like {launch date} or
            # {launch_date } are exactly the typo class this guard exists for
            # (format_prompt leaves them as literal text for the LLM).
            found = set(re.findall(r'\{([^{}]+)\}', searched))
            # {previous} is substituted by the chain executor with the prior
            # step's output — the FIRST step has no prior output, so there it
            # would reach the LLM as literal text and must fail the guard.
            allowed = self.SUPPLIED_PLACEHOLDERS - ({'previous'} if index == 0 else set())
            unknown = found - allowed
            assert not unknown, f"step '{name}' uses unsupplied placeholders: {unknown}"

    def test_steps_keep_their_required_placeholders(self):
        """Reverse direction of the guard above: a prompt edit that DROPS a
        required slot (e.g. {launch_date} vanishing from press_release) must
        fail, not silently lose the LLM's grounding data."""
        config = self._load()
        assert set(self.REQUIRED_PLACEHOLDERS) == set(config['steps'])
        for name, required in self.REQUIRED_PLACEHOLDERS.items():
            step = config['steps'][name]
            searched = step['user_prompt_template'] + '\n' + step.get('system_prompt', '')
            found = set(re.findall(r'\{([^{}]+)\}', searched))
            missing = required - found
            assert not missing, f"step '{name}' dropped required placeholders: {missing}"

    # step name -> the section heading the assembler owns and the step's
    # system prompt must explicitly ban re-adding.
    BANNED_HEADINGS = {
        'press_release': 'press release',
        'customer_faq': 'customer faq',
        'internal_faq': 'internal faq',
    }

    def test_steps_forbid_their_own_section_heading(self):
        """The assembler adds 'Press Release'/'Customer FAQ'/'Internal FAQ'
        headings itself; each prompt must ban re-adding ITS OWN heading —
        asserting the specific artifact, not a proxy 'do not add' phrase
        that other bans (e.g. code fences) could satisfy."""
        config = self._load()
        for name, heading in self.BANNED_HEADINGS.items():
            system = config['steps'][name]['system_prompt'].lower()
            # NOTE: [^.]* couples this pin to sentence punctuation — the ban
            # verb and the heading must share one sentence. A rephrase that
            # splits them across a period should update this test too.
            ban = re.search(r'(do not|never|must not) add[^.]*' + re.escape(heading), system)
            assert ban, f"step '{name}' does not ban adding the '{heading}' heading"

    def test_every_step_bans_preambles(self):
        """All four steps — including customer_thinking, which owns no section
        heading and so is absent from BANNED_HEADINGS — must keep their
        'no preamble' instruction so chained outputs stay assembly-clean."""
        config = self._load()
        for name, step in config['steps'].items():
            assert 'no preamble' in step['system_prompt'].lower(), (
                f"step '{name}' lacks the preamble ban"
            )

    def test_faq_steps_pin_the_qa_format(self):
        config = self._load()
        for name in ('customer_faq', 'internal_faq'):
            assert '**Q:' in config['steps'][name]['system_prompt'], (
                f"step '{name}' does not pin the Q&A format"
            )

    def test_chain_builder_formats_prfaq_steps_cleanly(self):
        """End-to-end through build_chain_steps: no unresolved placeholders
        except the {previous} handled later by the chain executor."""
        from datetime import datetime, timedelta, timezone
        from shared.prompts import get_prfaq_generation_steps

        def launch_date_now() -> str:
            return (datetime.now(timezone.utc) + timedelta(days=90)).strftime('%Y-%m-%d')

        # Sample the expected date BEFORE and AFTER the builder call: if the
        # test straddles a UTC midnight, the builder's date matches one of
        # the two samples instead of flaking.
        expected_before = launch_date_now()
        steps = get_prfaq_generation_steps(
            feature_idea='Test feature',
            personas_context='P1',
            feedback_context='F1',
        )
        expected_after = launch_date_now()
        assert len(steps) == 4
        # Cross-check: the builder's emitted step names track the JSON keys
        # (the hardcoded-order test above stays as the human-intent pin —
        # deriving EXPECTED from builder output would pin nothing).
        assert [s['step_name'] for s in steps] == list(self._load()['steps'])
        for step in steps:
            # Broad pattern for the same malformed-slot class the raw-template
            # guard catches, applied to the BUILDER's formatted output.
            leftovers = set(re.findall(r'\{([^{}]+)\}', step['user'])) - {'previous'}
            assert not leftovers, (
                f"step '{step['step_name']}' has unresolved placeholders: {leftovers}"
            )
        # The slots must render coherent content, not just resolve: the
        # default product_context is a real sentence and launch_date is a
        # generated future date — neither may leave a dangling section.
        import inspect
        default_product_context = inspect.signature(
            get_prfaq_generation_steps
        ).parameters['product_context'].default
        assert default_product_context.strip(), 'builder default must be a real sentence'
        first_step = steps[0]['user']
        assert default_product_context in first_step
        press_release = steps[1]['user']
        # Match the ACTUAL generated date (today + ~90 days), not any
        # date-shaped text — a future literal example date in the template
        # must not satisfy this vacuously.
        assert expected_before in press_release or expected_after in press_release, (
            'launch_date slot did not render the builder-generated date '
            f'({expected_before} / {expected_after})'
        )


class TestLoadPromptFileEncoding:
    """Pin the explicit UTF-8 encoding in load_prompt_file.

    Reverting encoding='utf-8' only breaks on non-UTF-8 default locales
    (Windows/cp1252), so CI would stay green without this platform-
    independent pin: assert the kwarg is passed, on every platform.
    """

    def test_opens_prompt_files_with_explicit_utf8(self, monkeypatch):
        import shared.prompts as prompts_module

        monkeypatch.setattr(prompts_module, 'get_prompts_dir', lambda: REPO_PROMPTS_DIR)
        prompts_module.load_prompt_file.cache_clear()

        seen = {}
        real_open = open

        def spy_open(file, *args, **kwargs):
            # Record ONLY the prompt-file open: incidental open() calls
            # (coverage tooling, future loader logging) must not overwrite
            # the observation or fake a pass.
            if str(file).endswith('prfaq-generation.json'):
                seen['encoding'] = kwargs.get('encoding')
            return real_open(file, *args, **kwargs)

        # Scope the spy to the module under test — unrelated open() calls
        # elsewhere are never intercepted at all.
        monkeypatch.setattr('shared.prompts.open', spy_open, raising=False)
        try:
            config = prompts_module.load_prompt_file('prfaq-generation.json')
        finally:
            prompts_module.load_prompt_file.cache_clear()

        assert seen['encoding'] == 'utf-8'
        assert 'steps' in config  # the spy delegated to the real loader
        # And the em-dash-bearing content itself decoded correctly.
        press_system = config['steps']['press_release']['system_prompt']
        assert '\u2014' in press_system  # — em dash round-trips
