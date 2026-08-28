"""
Every config key the ingestor turns into a URL must be checked on write.

`validate_scraper_destinations` in `shared/scraper_urls.py` iterates
`SCRAPER_URL_FIELDS`. The ingestor decides which config keys become network
destinations, in `_get_urls_to_scrape`. Adding a key there — a `sitemap_url`, a
`review_api_url` — and forgetting it here re-opens issue #244 for that key
alone, silently: the API keeps returning 200 and the scheduled ingestor keeps
fetching, which is exactly the shape of the original bug.

A comment asking the next author to update both sides cannot fail CI, so the
list is derived from the ingestor's source instead. Read with `ast`, scoped to
that one function — never regex over the whole file — the way
`test_doc_type_lockstep.py` and `test_prioritization_weights_lockstep.py` do.

REVERT MAP
----------
- Drop 'base_url' or 'urls' from SCRAPER_URL_FIELDS -> `covers_every_config_key`.
- Add a URL-bearing key to `_get_urls_to_scrape` without listing it either here
  or in SCRAPER_URL_FIELDS -> `covers_every_config_key`.
- Make the derivation vacuous (wrong function name, wrong path, a parser that
  finds nothing) -> `derivation_is_not_vacuous`.
- Add a THIRD module that persists `webscraper_configs` without calling the shared
  check -> `no_unlisted_module_writes_the_secret_key`.
- Import the check into a writer and never call it
  -> `each_writer_calls_the_shared_check`.
- Narrow the writer search back to the literal `webscraper_configs`, so the array
  writer qualifies only through its comments
  -> `finds_the_array_writer_without_relying_on_its_comments`.
- Widen it to every composed subscript key, so five unrelated handlers are flagged
  -> `the_composed_key_rule_ignores_ordinary_dict_building`.
- Add 'webscraper' to APP_CONFIG_PLUGINS, making `save_app_config` a third writer
  -> `the_app_config_writer_cannot_reach_the_webscraper_key`.
"""
import ast
from pathlib import Path
from unittest.mock import patch

import pytest

INGESTOR_SOURCE = 'plugins/webscraper/ingestor/handler.py'
URL_BUILDER = '_get_urls_to_scrape'

# Keys `_get_urls_to_scrape` reads that are NOT themselves destinations. Listed
# explicitly rather than inferred: a new key defaults to "must be checked", so
# forgetting to classify it fails loudly instead of passing quietly.
#
# 'pagination' holds only a param name, page count and start index; the URLs it
# produces are built from base_url and so carry base_url's already-checked host.
NON_DESTINATION_KEYS = frozenset({'pagination'})


def _ingestor_path() -> Path:
    # lambda/api/test/ -> voc-datalake/
    return Path(__file__).resolve().parents[3] / INGESTOR_SOURCE


def _config_keys_read_by_url_builder() -> set[str]:
    """Config keys `_get_urls_to_scrape` reads, from the ingestor's own source."""
    path = _ingestor_path()
    if not path.is_file():
        # An API test reaching into the plugin tree. Where only the api bundle is
        # present there is nothing to compare, and a skip beats a failure that
        # says nothing about the code under test.
        pytest.skip(f'{INGESTOR_SOURCE} not present in this tree')

    tree = ast.parse(path.read_text(encoding='utf-8'))
    builder = next(
        (
            node for node in ast.walk(tree)
            if isinstance(node, ast.FunctionDef) and node.name == URL_BUILDER
        ),
        None,
    )
    assert builder is not None, f'{URL_BUILDER} not found in {INGESTOR_SOURCE}'

    keys: set[str] = set()
    for node in ast.walk(builder):
        # config.get('key') / config.get('key', default)
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == 'get'
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == 'config'
            and node.args
            and isinstance(node.args[0], ast.Constant)
            and isinstance(node.args[0].value, str)
        ):
            keys.add(node.args[0].value)
        # config['key']
        if (
            isinstance(node, ast.Subscript)
            and isinstance(node.value, ast.Name)
            and node.value.id == 'config'
            and isinstance(node.slice, ast.Constant)
            and isinstance(node.slice.value, str)
        ):
            keys.add(node.slice.value)
    return keys


class TestScraperUrlFieldsCoverTheIngestor:

    def test_derivation_is_not_vacuous(self):
        """
        Positive control: an empty derivation would make the coverage assertion
        below pass no matter what `SCRAPER_URL_FIELDS` said. `base_url` is named
        because it is the field the editor's URL input writes — if the parser
        stops finding that, it has stopped reading the function.
        """
        keys = _config_keys_read_by_url_builder()

        assert keys, f'parsed no config keys out of {URL_BUILDER} — parser is broken'
        assert 'base_url' in keys

    def test_covers_every_config_key_the_ingestor_turns_into_a_url(self):
        from shared import scraper_urls

        checked = set(scraper_urls.SCRAPER_URL_FIELDS)
        destinations = _config_keys_read_by_url_builder() - NON_DESTINATION_KEYS

        assert destinations <= checked, (
            f'{sorted(destinations - checked)} reach the scheduled ingestor '
            f'unchecked — add them to SCRAPER_URL_FIELDS, or to '
            f'NON_DESTINATION_KEYS here with a reason'
        )

    def test_lists_no_field_the_ingestor_never_reads(self):
        """
        The other direction: a stale entry is not a security hole, but it is a
        claim about the ingestor that has stopped being true, and it makes the
        write-time error message name a field nothing fetches.
        """
        from shared import scraper_urls

        read_by_ingestor = _config_keys_read_by_url_builder()

        assert set(scraper_urls.SCRAPER_URL_FIELDS) <= read_by_ingestor, (
            f'{sorted(set(scraper_urls.SCRAPER_URL_FIELDS) - read_by_ingestor)} '
            f'is validated on write but never read by {URL_BUILDER}'
        )


# Modules allowed to write `webscraper_configs`, each of which must call the
# shared check. Listed explicitly so a NEW writer defaults to "fails this test"
# rather than joining silently: a third write path is how this issue would come
# back, and the reviewer of #391 was right that the fix is only as complete as
# the set of routes that apply it.
WRITER_MODULES = {
    # POST /scrapers — one config object at a time.
    'lambda/api/scrapers_handler.py': 'validate_scraper_destinations',
    # PUT /integrations/webscraper/credentials — the whole array as one string,
    # which is how the Settings webscraper card saves.
    'lambda/api/integrations_handler.py': 'validate_scraper_configs_json',
}

SECRET_KEY = 'webscraper_configs'

# Modules that name the key without persisting it. Enumerated with a reason each,
# for the same reason WRITER_MODULES is: a new file defaults to failing this test
# rather than being assumed harmless.
NON_WRITER_MODULES = {
    # The check itself — names the key in its docstring to say what it guards.
    'lambda/shared/scraper_urls.py',
}


def _writes_a_composed_secret_key(source: str) -> bool:
    """
    Whether the module assigns into a SECRETS mapping under a composed key.

    Catches `secrets[f"{prefix}{key}"] = value` — what `integrations_handler`
    actually does, and the shape a writer of this secret takes when it never
    spells `webscraper_configs` out anywhere.

    Two narrowings, each load-bearing. The key is not required to contain the
    literal `configs`: in the real writer it is assembled from two variables, so
    requiring it missed precisely the invisible form. And the mapping name must
    look like a secrets bag, because "any subscript assignment with an f-string
    key" matches ordinary response- and payload-building in five unrelated
    handlers, and a guard that cries wolf gets an entry added to silence it
    rather than read.

    Keyed on the assignment TARGET, so merely reading such a key does not qualify.
    """
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return False

    for node in ast.walk(tree):
        targets = (
            node.targets if isinstance(node, ast.Assign)
            else [node.target] if isinstance(node, ast.AnnAssign | ast.AugAssign)
            else []
        )
        for target in targets:
            if (
                isinstance(target, ast.Subscript)
                and isinstance(target.value, ast.Name)
                and 'secret' in target.value.id.lower()
                and isinstance(target.slice, ast.JoinedStr | ast.BinOp)
            ):
                return True
    return False


class TestEveryWriterAppliesTheCheck:
    """
    Every module this test can SEE persisting `webscraper_configs` applies the
    policy.

    `POST /scrapers` was checked first and `PUT /integrations/webscraper/
    credentials` was not, which left the same internal destination reachable
    through a different route. Derived from source rather than asserted in prose,
    because prose cannot fail CI.

    What is derived, stated precisely rather than as completeness — the guarantee
    is only as strong as the derivation:

      * modules containing the literal `webscraper_configs`, and
      * modules assigning into a secrets mapping under a COMPOSED key ending in
        `configs` (an f-string or concatenation), which is how a writer that never
        spells the key out would look.

    `integrations_handler.py` is found by the first rule only because its comments
    spell the key out — its code builds `f"{source}_{key}"` — so the second rule is
    what keeps it visible if those comments are ever tidied away, and what makes a
    future dynamic-key writer visible at all. Neither rule can see a key assembled
    at runtime from values this test cannot read; `test_the_app_config_writer_
    cannot_reach_the_webscraper_key` covers the one such writer that exists today.
    """

    @staticmethod
    def _modules_naming_the_secret_key() -> set[str]:
        root = Path(__file__).resolve().parents[3]
        found = set()
        for path in sorted((root / 'lambda').rglob('*.py')):
            if '/test' in str(path) or path.name.startswith('test_'):
                continue
            source = path.read_text(encoding='utf-8')
            if SECRET_KEY in source or _writes_a_composed_secret_key(source):
                found.add(str(path.relative_to(root)))
        return found

    def test_the_app_config_writer_cannot_reach_the_webscraper_key(self):
        """
        `save_app_config` writes `f"{source}_configs"` — the same key SHAPE this
        secret uses — and is kept away from the webscraper's only by the
        `APP_CONFIG_PLUGINS` gate. Nothing else asserts that gate, so adding
        'webscraper' to it would make that function a genuine third writer while
        every other assertion in this class kept passing.

        If this ever has to change, route that write through
        `validate_scraper_configs_json` first.
        """
        import integrations_handler

        assert 'webscraper' not in integrations_handler.APP_CONFIG_PLUGINS

    def test_derivation_is_not_vacuous(self):
        """A search that finds nothing would make the assertion below trivial."""
        found = self._modules_naming_the_secret_key()

        assert found, f'no module mentions {SECRET_KEY} — the search is broken'
        assert 'lambda/api/scrapers_handler.py' in found

    def test_finds_the_array_writer_without_relying_on_its_comments(self):
        """
        `integrations_handler` contains `webscraper_configs` only in COMMENTS — its
        code composes `f"{prefix}{key}"` — so a literal search alone put the guard
        at the mercy of prose that a tidy-up could remove. The composed-key rule
        must find it on the strength of the code.
        """
        root = Path(__file__).resolve().parents[3]
        source = (root / 'lambda/api/integrations_handler.py').read_text(
            encoding='utf-8'
        )
        without_comments = '\n'.join(
            line for line in source.splitlines() if not line.strip().startswith('#')
        )

        assert SECRET_KEY not in without_comments, (
            'the literal is now in the code — this test is asserting the wrong '
            'thing and can be simplified'
        )
        assert _writes_a_composed_secret_key(without_comments)

        # And the search must actually USE that rule: asserting the helper alone
        # would still pass if `_modules_naming_the_secret_key` went back to
        # matching only the literal.
        with patch.object(Path, 'read_text', autospec=True) as mock_read:
            mock_read.side_effect = lambda self, **kw: (
                without_comments if self.name == 'integrations_handler.py'
                else self.read_bytes().decode('utf-8')
            )
            found = self._modules_naming_the_secret_key()

        assert 'lambda/api/integrations_handler.py' in found

    def test_the_composed_key_rule_ignores_ordinary_dict_building(self):
        """
        Positive control on the narrowing: matching every f-string subscript
        assignment flagged five unrelated handlers building responses, and a guard
        that cries wolf gets silenced rather than read.
        """
        assert not _writes_a_composed_secret_key('payload[f"{name}_count"] = 1')
        assert _writes_a_composed_secret_key('secrets[f"{name}_configs"] = 1')

    def test_no_unlisted_module_writes_the_secret_key(self):
        found = self._modules_naming_the_secret_key()
        unlisted = found - set(WRITER_MODULES) - NON_WRITER_MODULES

        assert not unlisted, (
            f'{sorted(unlisted)} mention {SECRET_KEY}. If one WRITES it, call the '
            f'shared check from shared/scraper_urls.py and add it to '
            f'WRITER_MODULES here; if it only reads, add it to NON_WRITER_MODULES '
            f'with the reason.'
        )

    @pytest.mark.parametrize(('module', 'checker'), sorted(WRITER_MODULES.items()))
    def test_each_writer_calls_the_shared_check(self, module, checker):
        """
        Asserted as a CALL, not a mention: importing the function and never
        calling it is the shape of a check that was added and then bypassed.
        """
        root = Path(__file__).resolve().parents[3]
        tree = ast.parse((root / module).read_text(encoding='utf-8'))

        called = {
            node.func.id
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
        }

        assert checker in called, f'{module} does not call {checker}'
