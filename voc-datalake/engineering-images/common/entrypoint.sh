#!/bin/sh
# Every engineering image's entry point, the container of an AgentCore Runtime session (each session its own
# microVM): serve the runner on port 8080 (/ping and /invocations for the service, behind its own IAM
# authentication; /exec and /status for the agent's harness on loopback), sandbox on. The session has no AWS
# credential of the run's at start (its runtime's execution role reads only its image and writes its logs): the
# launcher hands the agent user a 15-minute role session through the runner (the `session` invocation), kept in
# /run/voc (only root writes there), and the runner then mounts the connection's cache read-only with it
# (Mountpoint for Amazon S3; nothing is written through it).
#
# The egress firewall, first in OUTPUT, over IPv4 and IPv6: the agent (user `unit`) reaches only the runner's agent API
# (8081: /exec, /status; never 8080, the AgentCore service's port, whose invocations hand the role session, start,
# hold and wake) and its own egress proxy (3128) on loopback, and repository code (user `code`, which has the session's network only in the
# dependency step) only its own proxy (3129): nothing on any other address or port, no link-local address (a
# credential endpoint), no name lookup (each proxy resolves its allowlisted hosts itself). The proxies (root's, in the
# runner) let an HTTPS CONNECT through only to a host of their own allowlist, on port 443: the agent's to Bedrock, its
# buckets and the board, never a registry; the dependency step's to its language's registries and the deployment's
# extra hosts, never Bedrock, a bucket or the board. Only when every rule is in place does the
# runner start an agent (--egress-firewall) or accept the dependency step (--code-firewall). Every other
# repository-code command runs in a network namespace of its own, with only its own loopback. The session's VPC lets
# nothing out but TCP 443: the second wall.
#
# umask 0002 is for repository code (group `work` shares the checkout's working tree); the runner starts the
# agent's own commands with 0022, so nothing the agent writes is writable by `code`.
set -eu
umask 0002
mkdir -p /run/voc
# The hard-link guard: the session lives on a file system of its own, or hard links to files a user does not own
# are refused, so repository code cannot link the session into the checkout. Only when one of the two holds does
# the runner run any repository code (--hardlink-guard).
/usr/bin/mount -t tmpfs -o mode=0711,nosuid,nodev,noexec,size=1m tmpfs /run/voc || true
echo 1 > /proc/sys/fs/protected_hardlinks || true
chown root:root /run/voc && chmod 0711 /run/voc
guard=''
if [ "$(/usr/bin/stat -c %d /run/voc)" != "$(/usr/bin/stat -c %d /work)" ] \
  || [ "$(/usr/bin/cat /proc/sys/fs/protected_hardlinks 2>/dev/null)" = 1 ]; then
  guard='--hardlink-guard'
fi
firewall=''
if /usr/sbin/iptables -I OUTPUT 1 -o lo -p tcp --dport 3129 -m owner --uid-owner code -j ACCEPT \
  && /usr/sbin/iptables -I OUTPUT 2 -m owner --uid-owner code -j REJECT \
  && /usr/sbin/iptables -I OUTPUT 3 -o lo -p tcp --dport 8081 -m owner --uid-owner unit -j ACCEPT \
  && /usr/sbin/iptables -I OUTPUT 4 -o lo -p tcp --dport 3128 -m owner --uid-owner unit -j ACCEPT \
  && /usr/sbin/iptables -I OUTPUT 5 -m owner --uid-owner unit -j REJECT \
  && /usr/sbin/ip6tables -I OUTPUT 1 -o lo -p tcp --dport 3129 -m owner --uid-owner code -j ACCEPT \
  && /usr/sbin/ip6tables -I OUTPUT 2 -m owner --uid-owner code -j REJECT \
  && /usr/sbin/ip6tables -I OUTPUT 3 -o lo -p tcp --dport 8081 -m owner --uid-owner unit -j ACCEPT \
  && /usr/sbin/ip6tables -I OUTPUT 4 -o lo -p tcp --dport 3128 -m owner --uid-owner unit -j ACCEPT \
  && /usr/sbin/ip6tables -I OUTPUT 5 -m owner --uid-owner unit -j REJECT; then
  firewall='--code-firewall --egress-firewall'
fi
# shellcheck disable=SC2086 # $firewall and $guard are flags or nothing
exec /usr/bin/python3 /opt/voc/unit_runner.py --host 0.0.0.0 --port 8080 --agent-port 8081 --proxy-port 3128 \
  --code-proxy-port 3129 --workdir /work --agent-home /home/unit --secrets-dir /run/voc --sandbox $firewall $guard
