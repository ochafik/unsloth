# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"""The MCP Apps sandbox origin: a second listener per server that serves only the
spec's sandbox proxy, from an origin other than the host's."""

from __future__ import annotations

import asyncio
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pytest

_BACKEND_DIR = str(Path(__file__).resolve().parent.parent)
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import mcp_app_sandbox as sandbox  # noqa: E402


@pytest.fixture(autouse = True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(sandbox, "_ports_path", lambda: tmp_path / "ports.json")
    sandbox._listeners.clear()
    sandbox._locks.clear()
    yield
    sandbox._listeners.clear()
    sandbox._locks.clear()


@pytest.mark.parametrize(
    "origin, request_host, primary, expected",
    [
        ("tauri://localhost", "127.0.0.1:9", 8888, "tauri://localhost"),
        ("http://tauri.localhost", "127.0.0.1:9", 8888, "http://tauri.localhost"),
        ("https://tauri.localhost", "127.0.0.1:9", 8888, "https://tauri.localhost"),
        ("http://127.0.0.1:8888", "127.0.0.1:9", 8888, "http://127.0.0.1:8888"),
        # a dev server on another loopback port embeds the frame too
        ("http://localhost:5173", "localhost:9", 8888, "http://localhost:5173"),
        ("http://[::1]:8888", "[::1]:9", 8888, "http://[::1]:8888"),
        # a LAN visitor: the primary server on the hostname this request used
        ("http://192.168.1.5:8888", "192.168.1.5:54000", 8888, "http://192.168.1.5:8888"),
        ("http://192.168.1.5:9999", "192.168.1.5:54000", 8888, None),
        ("http://192.168.1.6:8888", "192.168.1.5:54000", 8888, None),
        ("http://evil.example:8888", "192.168.1.5:54000", 8888, None),
        ("https://127.0.0.1:8888", "127.0.0.1:9", 8888, None),
        ("http://127.0.0.1:8888/", "127.0.0.1:9", 8888, None),
        ("http://127.0.0.1:8888 'unsafe-inline'", "127.0.0.1:9", 8888, None),
        ("http://127.0.0.1:8888;script-src *", "127.0.0.1:9", 8888, None),
        ("http://user@127.0.0.1:8888", "127.0.0.1:9", 8888, None),
        ("null", "127.0.0.1:9", 8888, None),
        ("", "127.0.0.1:9", 8888, None),
    ],
)
def test_only_an_origin_studio_could_be_served_from_may_embed_the_proxy(
    origin, request_host, primary, expected
):
    assert sandbox.allowed_host_origin(origin, request_host, primary) == expected


def test_the_proxy_names_its_host_without_letting_it_close_the_script():
    html = sandbox.proxy_html('http://127.0.0.1:1</script><script>alert(1)//')
    assert "</script><script>alert(1)" not in html
    assert 'const HOST = "http://127.0.0.1:1<\\/script>' in html


def _get(url: str):
    try:
        with urllib.request.urlopen(url, timeout = 5) as res:
            return res.status, dict(res.headers), res.read().decode()
    except urllib.error.HTTPError as err:
        return err.code, dict(err.headers), err.read().decode()


def test_listener_serves_the_proxy_from_its_own_origin(tmp_path):
    async def scenario():
        port = await sandbox.ensure_sandbox_port("127.0.0.1", "srv-a", primary_port = 8888)
        again = await sandbox.ensure_sandbox_port("127.0.0.1", "srv-a", primary_port = 8888)
        other = await sandbox.ensure_sandbox_port("127.0.0.1", "srv-b", primary_port = 8888)
        base = f"http://127.0.0.1:{port}"
        ok = await asyncio.to_thread(
            _get,
            f"{base}/?host=http%3A%2F%2F127.0.0.1%3A8888"
            "&connect=https%3A%2F%2Fapi.example.com&resource=blob%3A,cdn.example.com",
        )
        foreign = await asyncio.to_thread(_get, f"{base}/?host=http%3A%2F%2Fevil.example%3A8888")
        elsewhere = await asyncio.to_thread(_get, f"{base}/api/inference/models")
        await sandbox.close_sandbox_listeners()
        return port, again, other, ok, foreign, elsewhere

    port, again, other, ok, foreign, elsewhere = asyncio.run(scenario())
    assert again == port, "one listener per server, not one per request"
    assert other != port, "each server gets its own origin"
    assert port != 8888

    status, headers, body = ok
    assert status == 200
    csp = headers["content-security-policy"]
    # A real origin: the header must not force the opaque one back on.
    assert "sandbox" not in csp
    # The one host origin, plus the proxy's own for documents the View makes.
    assert "frame-ancestors http://127.0.0.1:8888 'self'" in csp
    assert "connect-src https://api.example.com" in csp
    assert "worker-src blob:" in csp
    assert "default-src 'none'" in csp and "object-src 'none'" in csp
    assert headers["cache-control"] == "no-store"
    assert 'const HOST = "http://127.0.0.1:8888"' in body
    assert "ui/notifications/sandbox-proxy-ready" in body

    assert foreign[0] == 400
    assert elsewhere[0] == 404, "the sandbox origin serves nothing but the proxy"


def test_a_servers_port_is_remembered_across_restarts(tmp_path):
    async def start():
        port = await sandbox.ensure_sandbox_port("127.0.0.1", "srv-keep", primary_port = 8888)
        await sandbox.close_sandbox_listeners()
        return port

    first = asyncio.run(start())
    assert json.loads((tmp_path / "ports.json").read_text()) == {"srv-keep": first}
    sandbox._locks.clear()
    # Same origin next launch, so the widget's own storage is still there.
    assert asyncio.run(start()) == first


def test_a_taken_remembered_port_falls_back_to_a_fresh_one(tmp_path):
    import socket

    blocker = socket.socket()
    blocker.bind(("127.0.0.1", 0))
    blocker.listen(1)
    taken = blocker.getsockname()[1]
    (tmp_path / "ports.json").write_text(json.dumps({"srv-x": taken}))
    try:
        async def start():
            port = await sandbox.ensure_sandbox_port("127.0.0.1", "srv-x", primary_port = 8888)
            await sandbox.close_sandbox_listeners()
            return port

        port = asyncio.run(start())
    finally:
        blocker.close()
    assert port != taken
    assert json.loads((tmp_path / "ports.json").read_text()) == {"srv-x": port}


@pytest.mark.parametrize("address, server_id", [("not-an-ip", "s"), ("127.0.0.1", "../x"), ("127.0.0.1", "")])
def test_bad_inputs_start_nothing(address, server_id):
    with pytest.raises(ValueError):
        asyncio.run(sandbox.ensure_sandbox_port(address, server_id, primary_port = 8888))
    assert not sandbox._listeners


def test_the_route_starts_a_listener_on_the_address_the_request_arrived_on(monkeypatch):
    from routes import mcp_servers as routes_mcp

    monkeypatch.setattr(routes_mcp, "_ui_server_or_404", lambda server_id, via_api_key: {"id": server_id})

    class FakeRequest:
        scope = {"server": ("127.0.0.1", 8888)}

    async def scenario():
        res = await routes_mcp.mcp_app_sandbox(FakeRequest(), "srv-r", via_api_key = False)
        live = dict(sandbox._listeners)
        await sandbox.close_sandbox_listeners()
        return res, live

    res, live = asyncio.run(scenario())
    assert res.port and ("127.0.0.1", "srv-r") in live
    assert live[("127.0.0.1", "srv-r")].port == res.port

    class NoServer:
        scope = {}

    assert asyncio.run(routes_mcp.mcp_app_sandbox(NoServer(), "srv-r", via_api_key = False)).port is None
