"""The toolchain images: one per language the egress allowlist knows, each on the shared base and entry point."""
import re
from pathlib import Path

import pytest

from engineering.runtime.egress import REGISTRY_HOSTS
from engineering.runtime.interface import ROLES

IMAGES = Path(__file__).resolve().parents[4] / 'engineering-images'


def test_there_is_an_image_for_exactly_the_languages_with_registries():
    languages = {path.name for path in IMAGES.iterdir() if (path / 'Dockerfile').is_file()}
    assert languages == set(REGISTRY_HOSTS)


@pytest.mark.parametrize('language', sorted(REGISTRY_HOSTS))
def test_each_image_installs_the_shared_base_and_starts_through_the_shared_entry_point(language):
    dockerfile = (IMAGES / language / 'Dockerfile').read_text()
    assert 'RUN sh /tmp/install-base.sh' in dockerfile
    assert 'COPY lambda/engineering/runtime/unit_runner.py /opt/voc/unit_runner.py' in dockerfile
    assert 'ENTRYPOINT ["sh", "/opt/voc/entrypoint.sh"]' in dockerfile
    for hook in ('ready.sh', 'validate.sh'):
        assert f'engineering-images/{language}/{hook}' in dockerfile
        assert (IMAGES / language / hook).read_text().startswith('#!/bin/sh\n')


@pytest.mark.parametrize('language', sorted(REGISTRY_HOSTS))
def test_each_ready_hook_names_only_its_own_registries(language):
    ready = (IMAGES / language / 'ready.sh').read_text()
    others = {host for other, hosts in REGISTRY_HOSTS.items() if other != language for host in hosts}
    assert not [host for host in others if host in ready]


def test_the_entry_point_turns_the_sandbox_on_and_mounts_nothing_before_a_session():
    entrypoint = (IMAGES / 'common' / 'entrypoint.sh').read_text()
    assert '--secrets-dir /run/voc --sandbox $firewall' in entrypoint
    assert "firewall='--code-firewall'" in entrypoint
    for tables in ('iptables', 'ip6tables'):
        # First in OUTPUT: no earlier ACCEPT lets `code` past them.
        assert f'{tables} -I OUTPUT 1 -p udp --dport 53 -m owner --uid-owner code -j ACCEPT' in entrypoint
        assert f'{tables} -I OUTPUT 3 -o lo -m owner --uid-owner code -j REJECT' in entrypoint
        assert f'{tables} -I OUTPUT 4 -p tcp --dport 8080 -m owner --uid-owner code -j REJECT' in entrypoint
    assert ' -A OUTPUT' not in entrypoint
    assert 'mount-s3' not in entrypoint


@pytest.mark.parametrize('language', sorted(REGISTRY_HOSTS))
def test_every_hook_runs_from_a_directory_no_repository_can_write(language):
    for hook in ('ready.sh', 'validate.sh'):
        assert '\ncd /\n' in (IMAGES / language / hook).read_text()


def test_the_stack_has_an_execution_role_for_exactly_the_runtimes_agent_roles():
    stack = (IMAGES.parent / 'lib' / 'stacks' / 'engineering-runtime.ts').read_text()
    listed = re.search(r'const AGENT_ROLES = \[(.*?)\];', stack, re.DOTALL)
    assert listed is not None
    assert set(re.findall(r"'([a-z_]+)'", listed.group(1))) == set(ROLES)


def test_the_base_keeps_the_agents_home_from_repository_code():
    base = (IMAGES / 'common' / 'install-base.sh').read_text()
    assert 'useradd --create-home --uid 10002 --gid work code' in base
    assert 'chmod 700 /home/unit' in base
