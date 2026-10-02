# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"""An MCP App widget's calls run side by side on a stdio session; the model's queue.

The published PDF viewer long-polls poll_pdf_commands (up to 30s) while it reads
pages with read_pdf_bytes. Queued behind the poll on the session's call lock, every
page read waited it out, and page turns took 30s or failed at 60s. JSON-RPC over
stdio multiplexes by request id, so a widget's calls need no lock; the model's calls
keep theirs, which is what orders them for a stateful server.
"""

from __future__ import annotations

import shlex
import sys
import threading
import time
from pathlib import Path

import pytest

_BACKEND_DIR = str(Path(__file__).resolve().parent.parent)
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from core.inference import mcp_client  # noqa: E402

SLOW_S = 3.0

_SERVER = f'''
import asyncio
from fastmcp import FastMCP

server = FastMCP("slow-and-fast")

@server.tool
async def long_poll() -> str:
    await asyncio.sleep({SLOW_S})
    return "polled"

@server.tool
def read_page() -> str:
    return "page"

server.run()
'''


@pytest.fixture
def server_url(tmp_path, monkeypatch):
    monkeypatch.setenv("UNSLOTH_STUDIO_HOME", str(tmp_path))
    monkeypatch.setenv("UNSLOTH_STUDIO_ALLOW_STDIO_MCP", "1")
    script = tmp_path / "slow_and_fast.py"
    script.write_text(_SERVER)
    yield f"{shlex.quote(sys.executable)} {shlex.quote(str(script))}"
    mcp_client.close_mcp_sessions()


def _race(url: str, slow_call, fast_call) -> tuple[float, float]:
    """Start the slow call, then the fast one on the same session; when did each end?"""
    started = time.monotonic()
    ended = {}

    def slow():
        slow_call()
        ended["slow"] = time.monotonic() - started

    thread = threading.Thread(target = slow)
    thread.start()
    time.sleep(0.8)  # the long poll is in flight
    fast_call()
    ended["fast"] = time.monotonic() - started
    thread.join()
    return ended["fast"], ended["slow"]


def test_a_widget_read_does_not_wait_out_the_widgets_long_poll(server_url):
    scope = "s=:t=thread-1"
    # Warm the session so the race measures calls, not the subprocess start.
    mcp_client.call_tool_structured_sync(url = server_url, headers = None, name = "read_page", args = {}, scope = scope)
    fast, slow = _race(
        server_url,
        lambda: mcp_client.call_tool_structured_sync(
            url = server_url, headers = None, name = "long_poll", args = {}, scope = scope
        ),
        lambda: mcp_client.call_tool_structured_sync(
            url = server_url, headers = None, name = "read_page", args = {}, scope = scope
        ),
    )
    assert fast < slow - 1.0, (fast, slow)
    assert fast < SLOW_S


def test_the_models_calls_on_a_stdio_session_still_run_in_order(server_url):
    scope = "s=:t=thread-2"
    mcp_client.call_tool_sync(url = server_url, headers = None, name = "read_page", args = {}, scope = scope)
    fast, slow = _race(
        server_url,
        lambda: mcp_client.call_tool_sync(url = server_url, headers = None, name = "long_poll", args = {}, scope = scope),
        lambda: mcp_client.call_tool_sync(url = server_url, headers = None, name = "read_page", args = {}, scope = scope),
    )
    # Queued behind the first, as before: this change is for widget traffic only.
    assert fast >= slow - 0.2, (fast, slow)
