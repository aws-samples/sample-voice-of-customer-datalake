"""voc-engineering-cache's image (voc-datalake/engineering-cache/): pinned base, git and packages, arm64."""
from __future__ import annotations

import re
from pathlib import Path

from engineering.connectors import cache

ROOT = Path(__file__).resolve().parents[4]
DOCKERFILE = (ROOT / 'engineering-cache' / 'Dockerfile').read_text()
REQUIREMENTS = (ROOT / 'engineering-cache' / 'requirements.txt').read_text()
LAYERS = ROOT / 'lambda' / 'layers'


def test_the_base_is_lambdas_python_image_for_arm64_pinned_by_digest() -> None:
    bases = [line for line in DOCKERFILE.splitlines() if line.startswith('FROM ')]
    assert len(bases) == 1
    assert re.fullmatch(r'FROM --platform=linux/arm64 public\.ecr\.aws/lambda/python:3\.\d+@sha256:[0-9a-f]{64}',
                        bases[0])


def test_git_is_one_exact_build_from_the_distro_and_nothing_is_fetched_from_elsewhere() -> None:
    assert re.search(r'RUN dnf install -y --releasever=latest git-core-\d+\.\d+\.\d+-\d+\.amzn2023\.\d+\.\d+ ', DOCKERFILE)
    assert not re.search(r'\b(curl|wget|git clone|ADD )', DOCKERFILE)


def test_every_python_package_is_pinned_by_version_and_hash_and_installed_requiring_them() -> None:
    pins = re.findall(r'^([a-z0-9-]+)==([0-9.a-z]+) \\\n    --hash=sha256:[0-9a-f]{64}$', REQUIREMENTS, re.MULTILINE)
    listed = [line for line in REQUIREMENTS.splitlines() if line and not line.startswith(('#', ' '))]
    assert len(pins) == len(listed) > 0
    assert '--require-hashes --only-binary=:all: --no-deps -r /tmp/requirements.txt' in DOCKERFILE


def test_its_python_packages_are_the_layers_own() -> None:
    pins = dict(re.findall(r'^([a-z0-9-]+)==([0-9.a-z]+)', REQUIREMENTS, re.MULTILINE))
    processing = (LAYERS / 'processing-deps' / 'requirements.txt').read_text()
    assert f'aws-lambda-powertools[tracer]=={pins["aws-lambda-powertools"]}' in processing
    signing = (LAYERS / 'signing-deps' / 'requirements.txt').read_text()
    assert f'cryptography>={pins["cryptography"]}' in signing


def test_it_runs_the_fillers_handler() -> None:
    assert 'CMD ["engineering.connectors.cache.lambda_handler"]' in DOCKERFILE
    assert callable(cache.lambda_handler)
