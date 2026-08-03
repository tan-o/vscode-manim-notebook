"""Jupyter kernel gateway for ``*.manim.ipynb``.

The extension owns the VS Code ``NotebookController`` while this small process
owns a real IPykernel launched through ``jupyter_client``.  Ordinary Python
cells therefore use Jupyter's normal execute request / IOPub reply protocol.
Manim bootstrap code is sent only when an explicitly tagged Manim cell runs.

The extension-host transport is deliberately tiny: JSON lines prefixed with a
marker.  Kernel stdout never shares that control channel because user streams
arrive through Jupyter IOPub messages.
"""

from __future__ import annotations

import base64
import json
import os
import queue
import sys
import threading
import traceback
from typing import Any

from jupyter_client import KernelManager
from jupyter_client.kernelspec import NoSuchKernel


_PROTOCOL = "__MANIM_JUPYTER_JSON__"
_protocol_stdout = sys.stdout
_requests: queue.Queue[dict[str, Any] | None] = queue.Queue()
_shutdown = threading.Event()
_kernel: KernelManager | None = None


def _send(payload: dict[str, Any]) -> None:
    _protocol_stdout.write(_PROTOCOL + json.dumps(payload, ensure_ascii=False) + "\n")
    _protocol_stdout.flush()


def _value(mime: str, value: Any) -> dict[str, Any]:
    if isinstance(value, bytes):
        return {
            "mime": mime,
            "value": base64.b64encode(value).decode("ascii"),
            "base64": True,
        }
    if isinstance(value, str):
        # Jupyter sends raster image bundles as base64 strings.  VS Code wants
        # the decoded bytes while SVG and textual MIME values stay as UTF-8.
        if mime.startswith("image/") and mime != "image/svg+xml":
            try:
                base64.b64decode(value, validate=True)
            except (ValueError, TypeError):
                pass
            else:
                return {"mime": mime, "value": value, "base64": True}
        return {"mime": mime, "value": value}
    try:
        json.dumps(value)
        return {"mime": mime, "value": value}
    except TypeError:
        return {"mime": mime, "value": repr(value)}


def _error_item(name: str, message: str, stack: str) -> dict[str, Any]:
    return {
        "mime": "application/vnd.code.notebook.error",
        "value": json.dumps(
            {"name": name, "message": message, "stack": stack},
            ensure_ascii=False,
        ),
    }


def _execute(request: dict[str, Any], client: Any) -> dict[str, Any]:
    code = str(request.get("code", ""))
    outputs: list[dict[str, Any]] = []
    execution_order: int | None = None
    clear_on_next_output = False
    message_id = client.execute(
        code,
        silent=False,
        store_history=bool(request.get("storeHistory", False)),
        allow_stdin=False,
        stop_on_error=False,
    )

    while True:
        message = client.get_iopub_msg(timeout=900)
        if message.get("parent_header", {}).get("msg_id") != message_id:
            continue
        message_type = message.get("header", {}).get("msg_type")
        content = message.get("content", {})
        if message_type == "status" and content.get("execution_state") == "idle":
            break
        if message_type == "execute_input":
            value = content.get("execution_count")
            execution_order = value if isinstance(value, int) else execution_order
            continue
        if message_type == "clear_output":
            if content.get("wait"):
                clear_on_next_output = True
            else:
                outputs.clear()
            continue

        output: dict[str, Any] | None = None
        if message_type == "stream":
            stream = "stderr" if content.get("name") == "stderr" else "stdout"
            output = {
                "items": [{
                    "mime": f"application/x.notebook.stream.{stream}",
                    "value": str(content.get("text", "")),
                }]
            }
        elif message_type in {"display_data", "execute_result", "update_display_data"}:
            data = content.get("data", {})
            items = [
                _value(str(mime), value)
                for mime, value in data.items()
            ] if isinstance(data, dict) else []
            if items:
                output = {
                    "items": items,
                    "metadata": content.get("metadata", {}) or {},
                }
        elif message_type == "error":
            stack = "\n".join(str(line) for line in content.get("traceback", []))
            output = {
                "items": [_error_item(
                    str(content.get("ename", "Error")),
                    str(content.get("evalue", "Python execution failed")),
                    stack,
                )]
            }

        if output is not None:
            if clear_on_next_output:
                outputs.clear()
                clear_on_next_output = False
            outputs.append(output)

    # Drain the matching shell reply so requests cannot accumulate on the
    # channel.  IOPub already carries the complete visible output/error data.
    while True:
        shell = client.get_shell_msg(timeout=30)
        if shell.get("parent_header", {}).get("msg_id") == message_id:
            status = shell.get("content", {}).get("status")
            break
    return {
        "id": request.get("id"),
        "ok": status == "ok",
        "outputs": outputs,
        "executionOrder": execution_order,
    }


def _read_requests() -> None:
    """Read control messages while the main thread waits on kernel output."""
    for line in sys.stdin:
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue
        message_type = request.get("type")
        if message_type == "interrupt":
            try:
                if _kernel is not None:
                    _kernel.interrupt_kernel()
            except BaseException:
                pass
            continue
        if message_type == "shutdown":
            _shutdown.set()
            try:
                if _kernel is not None:
                    _kernel.interrupt_kernel()
            except BaseException:
                pass
            _requests.put(None)
            return
        _requests.put(request)
    _shutdown.set()
    _requests.put(None)


def _start_kernel() -> tuple[KernelManager, Any]:
    # ``kernel_cmd`` pins the child kernel to the exact interpreter selected
    # in VS Code instead of resolving an unrelated global kernelspec.
    manager = KernelManager(
        kernel_cmd=[
            sys.executable,
            "-m",
            "ipykernel_launcher",
            "-f",
            "{connection_file}",
        ]
    )
    manager.start_kernel(cwd=os.getcwd())
    client = manager.client()
    client.start_channels()
    client.wait_for_ready(timeout=30)
    return manager, client


def main() -> None:
    global _kernel
    client: Any | None = None
    try:
        _kernel, client = _start_kernel()
        threading.Thread(target=_read_requests, name="manim-jupyter-stdin", daemon=True).start()
        _send({"type": "ready"})
        while not _shutdown.is_set():
            request = _requests.get()
            if request is None:
                break
            try:
                _send(_execute(request, client))
            except BaseException as error:  # keep the kernel gateway alive
                _send({
                    "id": request.get("id"),
                    "ok": False,
                    "outputs": [{
                        "items": [_error_item(
                            type(error).__name__,
                            str(error),
                            traceback.format_exc(),
                        )]
                    }],
                })
    except (ImportError, NoSuchKernel) as error:
        _send({"type": "startupError", "message": str(error)})
        raise
    finally:
        if client is not None:
            try:
                client.stop_channels()
            except BaseException:
                pass
        if _kernel is not None:
            try:
                _kernel.shutdown_kernel(now=True)
            except BaseException:
                pass


if __name__ == "__main__":
    main()
