"""Stand-in for `aidlc` during the AI-DLC leg, first on PATH.

`aidlc engine orchestrate ...` runs the real aidlc, passes its stdout through
unchanged, and appends the arguments and output as one JSON line to
$E2E_ORCHESTRATE_LOG. Every other command runs the real aidlc directly.

The model often saves a directive to a file (`... > /tmp/d.json`), so a hook on
the shell tool would see no output. The shim sees it whatever the model does
with it, in every harness.
"""

from __future__ import annotations

import fcntl
import json
import os
import subprocess
import sys


def main() -> int:
    real = os.environ["E2E_AIDLC_REAL"]
    args = sys.argv[1:]
    log = os.environ.get("E2E_ORCHESTRATE_LOG")
    if not log or args[:2] != ["engine", "orchestrate"]:
        os.execv(real, [real, *args])
    result = subprocess.run([real, *args], stdout=subprocess.PIPE)
    sys.stdout.buffer.write(result.stdout)
    sys.stdout.flush()
    line = json.dumps({"argv": args, "exit": result.returncode, "stdout": result.stdout.decode("utf-8", "replace")})
    try:
        with open(log, "a", encoding="utf-8") as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            f.write(line + "\n")
    except OSError:
        pass  # Logging must never change what aidlc does.
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
