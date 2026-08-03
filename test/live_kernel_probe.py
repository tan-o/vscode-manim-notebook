"""Execute a small diagnostic in an already-running Jupyter kernel."""

from __future__ import annotations

import json
import sys
import time

from jupyter_client import BlockingKernelClient


connection_file = sys.argv[1]
code = sys.argv[2]
client = BlockingKernelClient(connection_file=connection_file)
client.load_connection_file()
client.start_channels()
try:
    client.wait_for_ready(timeout=10)
    message_id = client.execute(code, allow_stdin=False, stop_on_error=False)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        message = client.get_iopub_msg(timeout=max(0.1, deadline - time.monotonic()))
        if message.get("parent_header", {}).get("msg_id") != message_id:
            continue
        message_type = message.get("header", {}).get("msg_type")
        content = message.get("content", {})
        if message_type in {"stream", "error", "execute_result", "display_data"}:
            print(json.dumps({"type": message_type, "content": content}, default=str))
        if message_type == "status" and content.get("execution_state") == "idle":
            break
finally:
    client.stop_channels()
