#!/bin/sh
# Ready hook: prefetch the Python gate tools into the shared pip cache so an agent starts warm (the
# versions the sample's own gate pins, voc-datalake/requirements-dev.txt).
# Reaches only the hosts of the Python egress allowlist (pypi.org, files.pythonhosted.org).
set -eu
# Hooks run as root before any repository code: never from a directory a repository can write.
cd /
python3 -m pip download --quiet --dest "${PIP_CACHE_DIR}/wheels" ruff==0.17.3 pytest==9.2.0 vulture==2.16
python3 -c 'import sys; assert sys.version_info >= (3, 12)'
chown -R code:work /opt/voc/cache
