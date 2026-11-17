#!/bin/sh
# Every engineering image's entry point, the container of an AgentCore Runtime session (each session its own
# microVM): serve the runner on port 8080 (/ping and /invocations for the service, behind its own IAM
# authentication; /exec and /status for the agent's harness on loopback), sandbox on. The session has no AWS
# credential of the run's at start (its runtime's execution role reads only its image and writes its logs): the
# launcher hands the agent user a 15-minute role session through the runner (the `session` invocation), kept in
# /run/voc (only root writes there), and the runner then mounts the connection's cache read-only with it
# (Mountpoint for Amazon S3; nothing is written through it).
#
# The walls, whichever the container supports (walls.sh, 7.50.03; docs/autonomous-engineering.md → Runtime): the
# egress firewall (iptables, where root has CAP_NET_ADMIN), else a user and network namespace of its own for every
# command of the agent's (user `unit`) and of repository code's (user `code`), with nothing but its loopback and a
# forwarder to the runner's sockets. Either way the agent reaches only the runner's agent API and its own egress
# proxy, repository code only its own proxy and only in the dependency step, and neither a link-local address (a
# credential endpoint) nor a name lookup; the proxies (root's, in the runner) let an HTTPS CONNECT through only to a
# host of their own allowlist, on port 443. The runner starts an agent only behind an egress wall (--egress-firewall
# or --egress-namespaces) and accepts the dependency step only behind a code wall (--code-firewall or
# --code-namespaces): with none it fails closed. The session's VPC lets nothing out but TCP 443: the second wall.
#
# umask 0002 is for repository code (group `work` shares the checkout's working tree); the runner starts the
# agent's own commands with 0022, so nothing the agent writes is writable by `code`.
set -eu
umask 0002
mkdir -p /run/voc
# The hard-link guard: the session lives on a file system of its own (a tmpfs, which needs CAP_SYS_ADMIN: AgentCore
# Runtime gives it), or the kernel's protected hard links are on (read by walls.sh, never written: /proc/sys is
# read-only there, and reads 1). Only when one of the two holds does the runner run any repository code.
/usr/bin/mount -t tmpfs -o mode=0711,nosuid,nodev,noexec,size=1m tmpfs /run/voc || true
chown root:root /run/voc && chmod 0711 /run/voc
walls=$(/bin/sh /opt/voc/walls.sh)
# shellcheck disable=SC2086 # $walls is flags or nothing
exec /usr/bin/python3 /opt/voc/unit_runner.py --host 0.0.0.0 --port 8080 --agent-port 8081 --proxy-port 3128 \
  --code-proxy-port 3129 --workdir /work --agent-home /home/unit --secrets-dir /run/voc --sandbox $walls
