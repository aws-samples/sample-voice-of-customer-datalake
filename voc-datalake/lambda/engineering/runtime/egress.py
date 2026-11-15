"""The egress allowlist of an agent's session: its language's registries (agents that run code), Bedrock, S3.

No session reaches the repository host: the connector's broker holds the host credential, fills the
checkout cache and makes every write (docs/autonomous-engineering.md → Repository connectors). So an
agent reaches only Amazon Bedrock in its region, two buckets in S3 (the raw bucket for the cache mount,
the workspace bucket for its run's keys and its own puts), the platform's two function URLs (the board's and the
broker's, each by its own host, on the agent's own proxy) and, for the agents that run repository code, its language's
package registries (the dependency step is the only command with network: ``unit_runner.sandboxed_argv``; its proxy
never gets a function URL). The list is checked host by host
(a plain DNS name: no scheme, port, path, wildcard or IP address) and travels with the agent
(``AgentSpec.egress``).
"""
from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Final
from urllib.parse import urlsplit

from engineering.runtime.interface import CODE_ROLES, FUNCTION_URL_RE, RuntimeRefused
from engineering.runtime.unit_runner import HOST_RE

#: The package registries each toolchain image fetches from (the images' ready hooks prefetch from the
#: same hosts). Only these, per language: a Python agent never reaches the npm registry.
REGISTRY_HOSTS: Final[dict[str, tuple[str, ...]]] = {
    'python': ('pypi.org', 'files.pythonhosted.org'),
    'node': ('registry.npmjs.org',),
    'rust': ('index.crates.io', 'static.crates.io', 'crates.io'),
    'java': ('repo.maven.apache.org', 'repo1.maven.org', 'plugins.gradle.org', 'services.gradle.org'),
}
MAX_EXTRA_HOSTS: Final = 10
_REGION_RE: Final = re.compile(r'^[a-z]{2}(-[a-z]+)+-\d\Z')
_BUCKET_RE: Final = re.compile(r'^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\Z')


def check_host(host: str) -> str:
    """``host`` lower-cased when it is a plain DNS name, else ``RuntimeRefused``."""
    normalised = host.strip().lower()
    if not HOST_RE.match(normalised):
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

    The board's and the broker's function URLs are added by their own hosts (``egress_allowlist``'s
    ``service_urls``); no generic Lambda endpoint is ever on the list.
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
    """The sorted, de-duplicated hosts one agent's session may reach, both of its users together (``split`` parts
    them: the agent's own and the dependency step's).

    ``extra_hosts`` (at most 10, from the deployment's configuration) add e.g. a private registry
    mirror; they are for the agents that run code only, like the registries, and only the dependency step reaches
    them. ``service_urls`` are the platform's function URLs every agent calls (the board's and the broker's), by their
    own host: never a generic Lambda endpoint.
    """
    if language not in REGISTRY_HOSTS:
        raise RuntimeRefused(f'no toolchain image for language {language!r}')
    extra = [check_host(host) for host in extra_hosts]
    if len(extra) > MAX_EXTRA_HOSTS:
        raise RuntimeRefused(f'at most {MAX_EXTRA_HOSTS} extra egress hosts')
    # ``split`` parts the hosts by their shape: an extra host (the dependency step's) shaped like the agent's own (a
    # Bedrock or S3 endpoint, a function URL) would land on the agent's proxy, so none may be.
    shaped = [host for host in extra if _AGENT_HOST_RE.match(host) or FUNCTION_URL_RE.match(host)]
    if shaped:
        raise RuntimeRefused(f'extra egress host {shaped[0]!r} is shaped like an AWS service endpoint or a function URL '
                             'the agent reaches: extra hosts are for the dependency step only')
    hosts = set(aws_hosts(region, bucket, *([workspace_bucket] if workspace_bucket else [])))
    hosts.update(service_host(url) for url in service_urls)
    if role in CODE_ROLES:
        hosts.update(REGISTRY_HOSTS[language], extra)
    return tuple(sorted(hosts))


#: The hosts only the agent itself reaches: Bedrock, its buckets' own S3 endpoints (``aws_hosts``), and the platform's
#: function URLs (``service_host``).
_AGENT_HOST_RE: Final = re.compile(
    r'^(?:bedrock-runtime\.[a-z0-9-]+|[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\.s3\.[a-z0-9-]+)\.amazonaws\.com\Z')


def split(hosts: Iterable[str]) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """``egress_allowlist``'s hosts parted by who reaches them, each through a proxy of its own in the session: the
    agent's (Bedrock, its buckets, the board's and the broker's function URLs) and the dependency step's (its language's
    registries and the deployment's extra hosts). The agent never reaches a registry; repository code never reaches
    Bedrock, a bucket, the board or the broker. It parts them by their shape, which is why ``egress_allowlist`` refuses an extra host shaped
    like one of the agent's (the limit: a registry mirror on an S3 bucket's endpoint cannot be an extra host)."""
    agent, code = [], []
    for host in hosts:
        (agent if _AGENT_HOST_RE.match(host) or FUNCTION_URL_RE.match(host) else code).append(host)
    return tuple(sorted(agent)), tuple(sorted(code))
