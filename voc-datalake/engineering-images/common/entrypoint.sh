#!/bin/sh
# Every engineering image's entry point: serve the runner on the MicroVM's endpoint, sandbox on. The MicroVM
# has no AWS credentials at start: the launcher hands the agent user a 15-minute role session through the runner
# (POST /session), kept in /run/voc (only root writes there), and the runner then mounts the connection's cache
# read-only with it (Mountpoint for Amazon S3; nothing is written through it). The runner listens on every
# interface of the MicroVM: the service's endpoint, behind its auth token, is the way in from outside.
#
# The code firewall, for the dependency step (the one repository-code command that shares the MicroVM's network):
# repository code (user `code`) may not reach anything on loopback, the runner's port on any address, nor link-local
# addresses (a credential endpoint), over IPv4 or IPv6, but name lookups (port 53, wherever the resolver is: a
# loopback stub or a link-local one) pass, so registries resolve. The rules go first in OUTPUT. Only when every rule is in
# place does the runner accept that step. Every other repository-code command runs in a network namespace of its
# own, with only its own loopback.
#
# umask 0002 is for repository code (group `work` shares the checkout's working tree); the runner starts the
# agent's own commands with 0022, so nothing the agent writes is writable by `code`.
set -eu
umask 0002
mkdir -p /run/voc && chown root:root /run/voc && chmod 0711 /run/voc
firewall=''
if /usr/sbin/iptables -I OUTPUT 1 -p udp --dport 53 -m owner --uid-owner code -j ACCEPT \
  && /usr/sbin/iptables -I OUTPUT 2 -p tcp --dport 53 -m owner --uid-owner code -j ACCEPT \
  && /usr/sbin/iptables -I OUTPUT 3 -o lo -m owner --uid-owner code -j REJECT \
  && /usr/sbin/iptables -I OUTPUT 4 -p tcp --dport 8080 -m owner --uid-owner code -j REJECT \
  && /usr/sbin/iptables -I OUTPUT 5 -d 169.254.0.0/16 -m owner --uid-owner code -j REJECT \
  && /usr/sbin/ip6tables -I OUTPUT 1 -p udp --dport 53 -m owner --uid-owner code -j ACCEPT \
  && /usr/sbin/ip6tables -I OUTPUT 2 -p tcp --dport 53 -m owner --uid-owner code -j ACCEPT \
  && /usr/sbin/ip6tables -I OUTPUT 3 -o lo -m owner --uid-owner code -j REJECT \
  && /usr/sbin/ip6tables -I OUTPUT 4 -p tcp --dport 8080 -m owner --uid-owner code -j REJECT \
  && /usr/sbin/ip6tables -I OUTPUT 5 -d fe80::/10 -m owner --uid-owner code -j REJECT; then
  firewall='--code-firewall'
fi
# shellcheck disable=SC2086 # $firewall is one flag or nothing
exec /usr/bin/python3 /opt/voc/unit_runner.py --host 0.0.0.0 --port 8080 --workdir /work --agent-home /home/unit \
  --secrets-dir /run/voc --sandbox $firewall
