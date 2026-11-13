"""The egress allowlist of an agent's MicroVM: its language's registries (agents that run code), Bedrock, S3.

No MicroVM reaches the repository host: the connector's broker holds the host credential, fills the
checkout cache and makes every write (docs/autonomous-engineering.md → Repository connectors). So an
agent reaches only Amazon Bedrock in its region, two buckets in S3 (the raw bucket for the cache mount,
the workspace bucket for its run's keys and its own puts) and, for the agents that run repository code, its language's package registries (the dependency
step is the only command with network: ``unit_runner.sandboxed_argv``). The list is checked host by host
(a plain DNS name: no scheme, port, path, wildcard or IP address) and travels with the agent
(``AgentSpec.egress``).
"""
from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Final
from urllib.parse import urlsplit

from engineering.runtime.interface import CODE_ROLES, FUNCTION_URL_RE, RuntimeRefused

#: The package registries each toolchain image fetches from (the images' ready hooks prefetch from the
#: same hosts). Only these, per language: a Python agent never reaches the npm registry.
REGISTRY_HOSTS: Final[dict[str, tuple[str, ...]]] = {
    'python': ('pypi.org', 'files.pythonhosted.org'),
    'node': ('registry.npmjs.org',),
    'rust': ('index.crates.io', 'static.crates.io', 'crates.io'),
    'java': ('repo.maven.apache.org', 'repo1.maven.org', 'plugins.gradle.org', 'services.gradle.org'),
}
MAX_EXTRA_HOSTS: Final = 10
_HOST_RE: Final = re.compile(r'^(?=.{1,253}\Z)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\Z')
_REGION_RE: Final = re.compile(r'^[a-z]{2}(-[a-z]+)+-\d\Z')
_BUCKET_RE: Final = re.compile(r'^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\Z')


def check_host(host: str) -> str:
    """``host`` lower-cased when it is a plain DNS name, else ``RuntimeRefused``."""
    normalised = host.strip().lower()
    if not _HOST_RE.match(normalised):
        raise RuntimeRefused(f'egress host {host!r} is not a plain DNS name (no scheme, port, path or wildcard)')
    return normalised


def service_host(url: str) -> str:
    """A platform function URL's own host (https only): ``<url-id>.lambda-url.<region>.on.aws``."""
    parts = urlsplit(url)
    host = check_host(parts.hostname or '')
    if parts.scheme != 'https' or not FUNCTION_URL_RE.match(host):
        raise RuntimeRefused(f'{url!r} is not a function URL')
    return host


def aws_hosts(region: str, *buckets: str) -> tuple[str, ...]:
    """What the agent process itself reaches in ``region``: Bedrock, its buckets (the cache's and the workspace's;
    their virtual-hosted endpoints only: the regional path-style endpoint would reach every bucket in the region)
    (no SQS: there are no task queues, and an agent's messages reach it through the board).

    The board's function URL is added by its own host (``egress_allowlist``'s ``service_urls``), the broker's too
    once the harness calls it; no generic Lambda endpoint is ever on the list.
    """
    if not _REGION_RE.match(region):
        raise RuntimeRefused(f'{region!r} is not an AWS region name')
    for bucket in buckets:
        if not _BUCKET_RE.match(bucket):
            raise RuntimeRefused(f'{bucket!r} is not an S3 bucket name')
    return (f'bedrock-runtime.{region}.amazonaws.com', *(f'{bucket}.s3.{region}.amazonaws.com' for bucket in buckets))


def egress_allowlist(
    *, role: str, language: str, region: str, bucket: str, workspace_bucket: str | None = None,
    extra_hosts: Iterable[str] = (), service_urls: Iterable[str] = (),
) -> tuple[str, ...]:
    """The sorted, de-duplicated hosts one agent's MicroVM may reach.

    ``extra_hosts`` (at most 10, from the deployment's configuration) add e.g. a private registry
    mirror; they are for the agents that run code only, like the registries. ``service_urls`` are the platform's
    function URLs every agent calls (the board's), by their own host: never a generic Lambda endpoint.
    """
    if language not in REGISTRY_HOSTS:
        raise RuntimeRefused(f'no toolchain image for language {language!r}')
    extra = [check_host(host) for host in extra_hosts]
    if len(extra) > MAX_EXTRA_HOSTS:
        raise RuntimeRefused(f'at most {MAX_EXTRA_HOSTS} extra egress hosts')
    hosts = set(aws_hosts(region, bucket, *([workspace_bucket] if workspace_bucket else [])))
    hosts.update(service_host(url) for url in service_urls)
    if role in CODE_ROLES:
        hosts.update(REGISTRY_HOSTS[language], extra)
    return tuple(sorted(hosts))
