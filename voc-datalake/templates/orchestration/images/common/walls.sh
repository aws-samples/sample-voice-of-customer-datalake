#!/bin/sh
# The session's walls, whichever the container supports (7.50.03): run as root by entrypoint.sh, before the runner,
# it sets up what it can and prints the runner's flags for what holds, on one line (nothing printed: no wall, and the
# runner, failing closed, starts no agent and runs no repository code). Diagnostics go to stderr, the runtime's log.
#
# 1. The egress firewall (--egress-firewall --code-firewall): iptables owner rules, first in OUTPUT, over IPv4 and
#    IPv6. The agent (user `unit`) reaches only the runner's agent API (8081: /exec, /status; never 8080, the AgentCore
#    service's port, whose invocations hand the role session, start, hold and wake) and its own egress proxy (3128) on
#    loopback, and repository code (user `code`) only its own proxy (3129): nothing on any other address or port, no
#    link-local address (a credential endpoint), no name lookup (each proxy resolves its allowlisted hosts itself).
#    It needs CAP_NET_ADMIN, which AgentCore Runtime does not give (2026-11-17: "Permission denied (you must be
#    root)", and no nft): kept for a container that has it.
# 2. Otherwise the namespaces (--egress-namespaces, --code-namespaces): each user may make a user and network
#    namespace of its own, with nothing but its loopback (unit_runner.own_namespaces), checked here exactly as the
#    runner will make them, once per user: the drop to the user, `unshare --user --map-root-user --net`, the loopback
#    up, one interface only, every capability dropped. The runner then runs every command of that user's in one.
#
# The hard-link guard (--hardlink-guard <guards>): the session's secrets (/run/voc) on a file system of their own
# (own_device: entrypoint.sh mounts a tmpfs there), or the kernel's protected hard links on (protected_hardlinks:
# read, never written; /proc/sys is read-only on AgentCore Runtime, where it reads 1 already). Either keeps repository
# code from hard-linking the session into the checkout; without one the runner runs no repository code.
#
# The tools by absolute path (a directory `code` can write may be on PATH). The test harness (test_engineering_walls.py)
# rewrites only these assignments, to stubs, to walk the decision tree.
IPTABLES=/usr/sbin/iptables
IP6TABLES=/usr/sbin/ip6tables
SETPRIV=/usr/bin/setpriv
UNSHARE=/usr/bin/unshare
IP=/usr/sbin/ip
SH=/bin/sh
WC=/usr/bin/wc
TRUE=/usr/bin/true
STAT=/usr/bin/stat
CAT=/usr/bin/cat
HARDLINKS=/proc/sys/fs/protected_hardlinks
SECRETS=/run/voc
WORK=/work
set -u

firewall() {
  "$IPTABLES" -I OUTPUT 1 -o lo -p tcp --dport 3129 -m owner --uid-owner code -j ACCEPT \
    && "$IPTABLES" -I OUTPUT 2 -m owner --uid-owner code -j REJECT \
    && "$IPTABLES" -I OUTPUT 3 -o lo -p tcp --dport 8081 -m owner --uid-owner unit -j ACCEPT \
    && "$IPTABLES" -I OUTPUT 4 -o lo -p tcp --dport 3128 -m owner --uid-owner unit -j ACCEPT \
    && "$IPTABLES" -I OUTPUT 5 -m owner --uid-owner unit -j REJECT \
    && "$IP6TABLES" -I OUTPUT 1 -o lo -p tcp --dport 3129 -m owner --uid-owner code -j ACCEPT \
    && "$IP6TABLES" -I OUTPUT 2 -m owner --uid-owner code -j REJECT \
    && "$IP6TABLES" -I OUTPUT 3 -o lo -p tcp --dport 8081 -m owner --uid-owner unit -j ACCEPT \
    && "$IP6TABLES" -I OUTPUT 4 -o lo -p tcp --dport 3128 -m owner --uid-owner unit -j ACCEPT \
    && "$IP6TABLES" -I OUTPUT 5 -m owner --uid-owner unit -j REJECT
}

# Inside the probe's namespace: the loopback up and the only interface up (no way to the session's network: a new
# network namespace has nothing else, bar the kernel's fallback tunnels, down and with no underlay), then every
# capability gone before a last command runs. Its arguments are the tools' paths, never text to parse.
# shellcheck disable=SC2016 # expanded by the probe's own shell, from its positional arguments
PROBE='"$1" link set lo up && [ "$("$1" -o link show up | "$2" -l)" -eq 1 ] && exec "$3" --inh-caps=-all --bounding-set=-all --no-new-privs -- "$4"'

namespaces() {
  "$SETPRIV" --reuid="$1" --regid=work --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs -- \
    "$UNSHARE" --user --map-root-user --net -- "$SH" -c "$PROBE" probe "$IP" "$WC" "$SETPRIV" "$TRUE"
}

flags=''
if firewall; then
  flags='--code-firewall --egress-firewall'
  echo 'walls: the egress firewall (iptables) is in place' >&2
else
  echo 'walls: no egress firewall here (iptables refused: no CAP_NET_ADMIN); trying the namespaces' >&2
  if namespaces unit; then
    flags='--egress-namespaces'
  else
    echo 'walls: the agent user cannot make its own user and network namespace: no agent starts' >&2
  fi
  if namespaces code; then
    flags="${flags:+$flags }--code-namespaces"
  else
    echo 'walls: repository code cannot make its own user and network namespace: no dependency step' >&2
  fi
fi

guards=''
if [ "$("$STAT" -c %d "$SECRETS")" != "$("$STAT" -c %d "$WORK")" ]; then
  guards='own_device'
fi
if [ "$("$CAT" "$HARDLINKS" 2>/dev/null)" = 1 ]; then
  guards="${guards:+$guards,}protected_hardlinks"
fi
if [ -n "$guards" ]; then
  flags="${flags:+$flags }--hardlink-guard $guards"
else
  echo 'walls: no hard-link guard (the secrets share /work'"'"'s file system and protected hard links are off): no repository code runs' >&2
fi
echo "$flags"
