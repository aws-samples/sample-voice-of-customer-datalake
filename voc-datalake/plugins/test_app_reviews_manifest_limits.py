"""App-review ingestors need a Lambda budget that scales with their storefront sweep.

The iOS ingestor walks every storefront in IOS_COUNTRIES, paginating each one,
and only returns after the whole loop finishes — so a timeout throws away
everything collected so far instead of yielding partial progress. It ran on the
300s default while the pagination work (continuation tokens, empty-page retries)
increased how much it fetches per run, which is the combination that made runs
die with nothing to show.

These tests tie the manifest budgets to the actual driver (storefront count) and
to the ceilings enforced in lib/plugin-loader.ts, so neither side can drift
without failing.
"""
import json
import re
from pathlib import Path

import pytest

PLUGINS_DIR = Path(__file__).resolve().parent
VOC_DIR = PLUGINS_DIR.parent

# What the ingestors used to get, and what proved insufficient. Explicit literals
# so a revert to them fails rather than silently passing.
PREVIOUS_TIMEOUT = 300
PREVIOUS_MEMORY = 512

# Conservative floor for the per-storefront cost: each country is a paginated
# HTTP walk with rate limiting, so well over a second each. Expressed per
# storefront rather than as a flat number so that ADDING storefronts forces the
# timeout to be revisited.
MIN_SECONDS_PER_STOREFRONT = 10


def _manifest(plugin_id: str) -> dict:
    path = PLUGINS_DIR / plugin_id / 'manifest.json'
    return json.loads(path.read_text(encoding='utf-8'))


def _ingestor(plugin_id: str) -> dict:
    return _manifest(plugin_id)['infrastructure']['ingestor']


def _loader_ceiling(field: str) -> int:
    """Read the hard ceiling the CDK plugin loader enforces for a field."""
    source = (VOC_DIR / 'lib' / 'plugin-loader.ts').read_text(encoding='utf-8')
    match = re.search(rf'{field}: z\.number\(\)\.int\(\)\.min\(\d+\)\.max\((\d+)\)', source)
    assert match, f'could not find the {field} ceiling in plugin-loader.ts'
    return int(match.group(1))


def _ios_storefront_count() -> int:
    source = (PLUGINS_DIR / 'app_reviews_ios' / 'ingestor' / 'countries.py').read_text(encoding='utf-8')
    block = source.split('IOS_COUNTRIES')[1]
    return len(re.findall(r'"[a-z]{2}"', block.split(']')[0]))


@pytest.mark.parametrize('plugin_id', ['app_reviews_ios', 'app_reviews_android'])
class TestBudgetsWereRaised:
    def test_timeout_exceeds_the_previous_default(self, plugin_id):
        assert _ingestor(plugin_id)['timeout'] > PREVIOUS_TIMEOUT

    def test_memory_exceeds_the_previous_default(self, plugin_id):
        assert _ingestor(plugin_id)['memory'] > PREVIOUS_MEMORY


@pytest.mark.parametrize('plugin_id', ['app_reviews_ios', 'app_reviews_android'])
class TestBudgetsStayWithinLoaderLimits:
    """lib/plugin-loader.ts rejects the whole synth if a manifest exceeds these,
    so an over-eager bump breaks deployment rather than any test."""

    def test_timeout_within_ceiling(self, plugin_id):
        assert _ingestor(plugin_id)['timeout'] <= _loader_ceiling('timeout')

    def test_memory_within_ceiling(self, plugin_id):
        assert _ingestor(plugin_id)['memory'] <= _loader_ceiling('memory')


class TestIosBudgetTracksItsStorefrontSweep:
    def test_timeout_scales_with_storefront_count(self):
        """Adding storefronts must force a timeout review, since nothing is
        yielded until every one of them has been walked."""
        required = _ios_storefront_count() * MIN_SECONDS_PER_STOREFRONT
        assert _ingestor('app_reviews_ios')['timeout'] >= required

    def test_ios_gets_at_least_as_long_as_android(self):
        """iOS fans out across many storefronts; Android queries one locale."""
        assert _ingestor('app_reviews_ios')['timeout'] >= _ingestor('app_reviews_android')['timeout']

    def test_storefront_list_is_actually_large(self):
        """Guards the premise: if the sweep were trimmed to a couple of
        countries, the scaling test above would go slack without anyone noticing."""
        assert _ios_storefront_count() >= 20
