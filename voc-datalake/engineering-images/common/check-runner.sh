#!/bin/sh
# Shared by every image's validate hook: the unit runner answers on its port and runs a command.
# Usage: check-runner.sh <program> [args...]   (the toolchain command the image's validate hook proves)
set -eu
base="http://127.0.0.1:8080"
python3 - "$base" "$@" <<'PY'
import json, sys, time, urllib.request

base, argv = sys.argv[1], sys.argv[2:]
body = json.dumps({'argv': argv, 'timeout_seconds': 120}).encode()
request = urllib.request.Request(f'{base}/exec', data=body, method='POST', headers={'Content-Type': 'application/json'})
exec_id = json.loads(urllib.request.urlopen(request, timeout=10).read())['exec_id']
for _ in range(240):
    answer = json.loads(urllib.request.urlopen(f'{base}/exec/{exec_id}', timeout=10).read())
    if answer['state'] == 'done':
        sys.exit(0 if answer['exit_code'] == 0 and not answer['timed_out'] else 1)
    time.sleep(0.5)
sys.exit(1)
PY
