"""Plugin manifest facts shared by the integrations tests.

Read from `plugins/*/manifest.json` — the source of truth — and deliberately NOT
from the generated frontend copy (`frontend/src/plugins/manifests.json`), which
strips the `secrets` block. That block is exactly the seeded-default data the
integrations status tests need in order to tell a value CDK seeded from one a
human entered.

This lives in its own module rather than in `conftest.py` because `conftest` is
not a unique module name: `plugins/conftest.py` is also on the path when the
whole suite is collected, so `from conftest import ...` resolves to whichever one
pytest imported first.
"""
import json
import pathlib

_PLUGINS_DIR = pathlib.Path(__file__).parents[3] / 'plugins'  # voc-datalake/plugins


def _load_manifests() -> list[dict]:
    """Real plugins only, matching loadPlugins() in lib/plugin-loader.ts.

    That function skips any directory whose name starts with '_', which is how
    `_template` (id 'my_source') and `_shared` stay out of a deployment. The
    filter is repeated here rather than inferred, because a test that included
    the template would assert against a source CDK never seeds.

    A missing directory raises rather than warning: `plugins/` sits beside
    `lambda/`, so its absence means a broken checkout, and a warning that
    collects zero parametrized cases leaves a guard silently inactive.
    """
    paths = sorted(
        p for p in _PLUGINS_DIR.glob('*/manifest.json')
        if not p.parent.name.startswith('_')
    )
    if not paths:
        # A real exception, not `assert`: this runs at IMPORT time, and `python -O`
        # strips asserts — which would turn "checkout is incomplete" into every
        # parametrized guard below silently collecting zero cases, the exact failure
        # the hard check exists to prevent.
        raise RuntimeError(
            f'no plugin manifests under {_PLUGINS_DIR}; checkout is incomplete'
        )
    return [json.loads(p.read_text()) for p in paths]


MANIFESTS = _load_manifests()

# All unique config keys across all plugins — deduplicated because several
# plugins share field names like 'app_name', 'sort_by', 'frequency_minutes'.
MANIFEST_KEYS = sorted({
    field['key']
    for manifest in MANIFESTS
    for field in manifest.get('config', [])
})

# Plugin IDs, used as `source=` path parameters.
PLUGIN_IDS = [m['id'] for m in MANIFESTS]

# {plugin_id: {key: seeded_default}} — the shape api-stack.ts hands the
# integrations handler as PLUGIN_SECRET_DEFAULTS, derived here from the same
# manifests CDK reads, so the two cannot drift unnoticed.
PLUGIN_SECRET_DEFAULTS = {m['id']: dict(m.get('secrets') or {}) for m in MANIFESTS}


def freshly_deployed_secret() -> dict[str, str]:
    """The shared secret exactly as ingestion-stack.ts::createApiSecrets() seeds it.

    That is `legacySecrets` plus `aggregateSecrets(allPlugins)` — each key
    namespaced `<plugin_id>_<key>` — plus the generated `placeholder`. Nothing in
    here was entered by a human, so every source must read as NOT configured.
    """
    secret = {'webscraper_configs': '[]'}  # legacySecrets in createApiSecrets()
    for plugin_id, seeded in PLUGIN_SECRET_DEFAULTS.items():
        for key, value in seeded.items():
            secret[f'{plugin_id}_{key}'] = value
    secret['placeholder'] = 'generated-by-cdk'
    return secret
