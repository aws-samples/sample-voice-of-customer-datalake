"""The harness: how an agent runs inside its session (docs/autonomous-engineering.md → Runtime → The harness).

One interface (``interface.Adapter``) with two adapters, chosen per agent in its skill: a plain Bedrock
Converse loop (``converse_loop``) and a coding-agent CLI in its headless mode (``cli``), which reaches the
platform's tools through the harness's own tool server (``tool_server``) with every built-in tool of its
own off. Either way the agent gets only its task brief, its knowledge-pack and memory slices and the
platform's tools (``tools``): repository code runs only as the sandbox user, through the runner; files are
read and written only inside the checkout, never through a link; every host write goes through the broker.

The harness runs as the agent user (``unit``) from ``/opt/voc``, outside the checkout, imports nothing but
the standard library, boto3 and the runtime's own pure modules, and ends with the runtime's exit codes:
0 done, 75 paused after its checkpoint, anything else a crash (``liveness.ended``).
"""
