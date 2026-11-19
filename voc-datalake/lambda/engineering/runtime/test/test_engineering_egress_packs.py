"""Each image's dependency step reaches every registry its gate packs' setup steps need (7.50.00): the Python image's
packs are Python and TypeScript, the Rust image's Rust and TypeScript, the Node image's TypeScript, Java's Java."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from engineering.runtime.egress import REGISTRY_HOSTS

BUNDLE = Path(__file__).resolve().parents[4] / 'templates' / 'orchestration' / 'bundle.json'
#: The gate packs each image carries the toolchains of (templates/orchestration/images/*/Dockerfile).
IMAGE_PACKS = {'python': ('python', 'typescript'), 'node': ('typescript',), 'rust': ('rust', 'typescript'),
               'java': ('java',)}


@pytest.mark.skipif(not BUNDLE.is_file(), reason='the templates\' bundle is not in this tree')
@pytest.mark.parametrize('language', sorted(IMAGE_PACKS))
def test_an_images_dependency_step_reaches_its_packs_registries(language: str) -> None:
    packs = {pack['id']: pack for pack in json.loads(BUNDLE.read_text())['gates']['packs']}
    needed = {host for pack in IMAGE_PACKS[language] for host in packs[pack]['network']}
    assert needed <= set(REGISTRY_HOSTS[language])


def test_the_registries_are_the_toolchains_own_and_nothing_else() -> None:
    assert set(REGISTRY_HOSTS) == set(IMAGE_PACKS)
    every = {host for hosts in REGISTRY_HOSTS.values() for host in hosts}
    assert every == {'pypi.org', 'files.pythonhosted.org', 'registry.npmjs.org', 'index.crates.io', 'static.crates.io',
                     'crates.io', 'static.rust-lang.org', 'repo.maven.apache.org', 'repo1.maven.org',
                     'plugins.gradle.org', 'services.gradle.org'}
