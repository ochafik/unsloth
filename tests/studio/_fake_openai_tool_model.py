# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"""A deterministic OpenAI-compatible chat model for browser tests that need a tool call.

Scripted by the conversation it is sent, not by chance:

  * a user turn containing TRIGGER, answered by nothing yet: a call to the first
    offered tool whose name ends in ``TOOL_SUFFIX``;
  * a tool result as the last message: a short closing sentence;
  * anything else: an echo of the last user text.

Every request body is kept (``requests``), so a test can assert on exactly what the
host replayed to the model -- which tools it offered, and what a tool message said.

Speaks both the streaming (SSE) and plain JSON forms of /v1/chat/completions, and
answers /v1/models.
"""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

MODEL_ID = "fake-tool-model"


class FakeToolModel:
    def __init__(
        self,
        trigger: str,
        tool_suffix: str,
        tool_args: dict[str, Any],
        arg_chunk_delay: float = 0.0,
    ):
        self.trigger = trigger
        self.tool_suffix = tool_suffix
        self.tool_args = tool_args
        # A host draws a UI tool's widget while the arguments stream; a delay
        # between chunks is what gives it time to (tool-input-partial).
        self.arg_chunk_delay = arg_chunk_delay
        self.requests: list[dict[str, Any]] = []
        self._server: ThreadingHTTPServer | None = None
        self._lock = threading.Lock()

    # -- scripting -----------------------------------------------------------------

    def _reply(self, body: dict[str, Any]) -> dict[str, Any]:
        messages = body.get("messages") or []
        last = messages[-1] if messages else {}
        if last.get("role") == "tool":
            return {"content": "The probe is on screen."}
        user_text = _text_of(last) if last.get("role") == "user" else ""
        if self.trigger in user_text:
            for tool in body.get("tools") or []:
                name = (tool.get("function") or {}).get("name", "")
                if name.endswith(self.tool_suffix):
                    return {
                        "tool_call": {
                            "id": f"call_{int(time.time() * 1000)}",
                            "name": name,
                            "arguments": json.dumps(self.tool_args),
                        }
                    }
            return {"content": "No matching tool was offered."}
        return {"content": f"You said: {user_text[:200]}"}

    # -- http ------------------------------------------------------------------------

    def start(self, port: int = 0) -> str:
        model = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):  # noqa: D401 - silence the default logging
                return

            def _json(self, code: int, payload: Any) -> None:
                data = json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):  # noqa: N802
                if self.path.rstrip("/").endswith("/models"):
                    self._json(200, {"object": "list", "data": [{"id": MODEL_ID, "object": "model", "owned_by": "test"}]})
                    return
                self._json(404, {"error": "not found"})

            def do_POST(self):  # noqa: N802
                length = int(self.headers.get("content-length") or 0)
                try:
                    body = json.loads(self.rfile.read(length) or b"{}")
                except ValueError:
                    self._json(400, {"error": "bad json"})
                    return
                if not self.path.rstrip("/").endswith("/chat/completions"):
                    self._json(404, {"error": "not found"})
                    return
                with model._lock:
                    model.requests.append(body)
                import time as _t

                def _log(what):
                    import os as _os

                    path = _os.environ.get("FAKE_MODEL_LOG")
                    if path:
                        with open(path, "a") as fh:
                            fh.write(f"{_t.strftime('%X')} {what}\n")
                _log(f"POST body-stream={body.get('stream')} tools={[t.get('function',{}).get('name') for t in body.get('tools') or []]}")
                reply = model._reply(body)
                _log(f"reply={'tool_call' if 'tool_call' in reply else 'text'}")
                if body.get("stream"):
                    self._stream(reply)
                else:
                    self._json(200, _completion(reply))

            def _stream(self, reply: dict[str, Any]) -> None:
                delay = model.arg_chunk_delay

                def _log(what):
                    import os as _os
                    import time as _t

                    path = _os.environ.get("FAKE_MODEL_LOG")
                    if path:
                        with open(path, "a") as fh:
                            fh.write(f"{_t.strftime('%X')} {what}\n")
                try:
                    self._stream_inner(reply, delay, _log)
                except BaseException as exc:  # noqa: BLE001
                    _log(f"STREAM CRASH {exc!r}")
                    raise

            def _stream_inner(self, reply, delay, _log):
                _log(f"stream start delay={delay} reply={'tool_call' if 'tool_call' in reply else 'text'}")
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("cache-control", "no-cache")
                self.send_header("connection", "close")
                self.end_headers()
                for i, chunk in enumerate(_chunks(reply, delay)):
                    self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
                    self.wfile.flush()
                    _log(f"chunk {i} sent")
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
                _log("DONE sent")
                self.close_connection = True

        self._server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        threading.Thread(target = self._server.serve_forever, daemon = True).start()
        return f"http://127.0.0.1:{self._server.server_address[1]}/v1"

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()


def _text_of(message: dict[str, Any]) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            part.get("text", "") for part in content if isinstance(part, dict) and part.get("type") == "text"
        )
    return ""


def _completion(reply: dict[str, Any]) -> dict[str, Any]:
    message: dict[str, Any] = {"role": "assistant", "content": reply.get("content")}
    finish = "stop"
    if "tool_call" in reply:
        call = reply["tool_call"]
        message = {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {"id": call["id"], "type": "function", "function": {"name": call["name"], "arguments": call["arguments"]}}
            ],
        }
        finish = "tool_calls"
    return {
        "id": "chatcmpl-fake",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": MODEL_ID,
        "choices": [{"index": 0, "message": message, "finish_reason": finish}],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    }


def _chunks(reply: dict[str, Any], arg_chunk_delay: float = 0.0):
    base = {"id": "chatcmpl-fake", "object": "chat.completion.chunk", "created": int(time.time()), "model": MODEL_ID}
    yield {**base, "choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}, "finish_reason": None}]}
    if "tool_call" in reply:
        call = reply["tool_call"]
        # The name first, then the arguments in thirds, as a real model writes
        # them: a host that mounts the widget mid-stream gets something to parse.
        yield {
            **base,
            "choices": [
                {
                    "index": 0,
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": call["id"],
                                "type": "function",
                                "function": {"name": call["name"], "arguments": ""},
                            }
                        ]
                    },
                    "finish_reason": None,
                }
            ],
        }
        arguments = call["arguments"]
        third = max(1, len(arguments) // 3)
        for start in range(0, len(arguments), third):
            yield {
                **base,
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "function": {"arguments": arguments[start : start + third]},
                                }
                            ]
                        },
                        "finish_reason": None,
                    }
                ],
            }
            if arg_chunk_delay:
                import time as _time

                _time.sleep(arg_chunk_delay)
        yield {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]}
    else:
        yield {**base, "choices": [{"index": 0, "delta": {"content": reply.get("content") or ""}, "finish_reason": None}]}
        yield {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
    yield {**base, "choices": [], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}
