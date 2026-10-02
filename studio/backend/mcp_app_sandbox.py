# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"""The MCP Apps sandbox origin.

MCP Apps (spec 2026-01-26, "Sandbox proxy") requires a web host to render a View
through an intermediate sandbox proxy that has a DIFFERENT origin from the host and
runs with ``allow-scripts allow-same-origin``. The host is then protected by being
another origin, and the View keeps a real origin of its own -- which is what gives it
IndexedDB, cookies, storage in nested frames, Workers, and an ``Origin`` header a
declared API can allowlist. An opaque-origin iframe has none of those.

A port is part of an origin, so a listener on another port of the address the browser
already reaches Studio on is a second origin at no configuration cost. Each MCP server
gets its own port: one server's widgets then cannot read another's storage, and the
port is remembered so a widget's storage survives a restart.

Listeners are started on first use, from the request that asks for one, on the local
address that request arrived on -- loopback for the desktop app and a default launch,
the LAN address for a LAN visitor. They run on the primary server's event loop with
``lifespan="off"``, like the LAN listener, and serve exactly one static document: no
API, no auth, no cookies. Anything else is a 404.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import re
import socket
import urllib.parse
from pathlib import Path
from typing import Any, Optional

import uvicorn

from loggers import get_logger

logger = get_logger(__name__)

_START_TIMEOUT = 10.0
# The proxy is a relay the host creates per widget; no sandbox page needs a queue.
_LISTEN_BACKLOG = 128
_PORTS_FILE = "mcp_app_sandbox_ports.json"
_SERVER_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")

# (local address, server id) -> _Listener
_listeners: dict[tuple[str, str], "_Listener"] = {}
_locks: dict[tuple[str, str], asyncio.Lock] = {}


class _Listener:
    def __init__(self, server: Any, task: "asyncio.Task", sock: socket.socket, port: int):
        # {"allow_local": bool}: read per request, refreshed whenever the route is asked
        # for the port, so an edited server URL takes effect without a restart.
        self.policy: dict = {"allow_local": False}
        self.server = server
        self.task = task
        self.socket = sock
        self.port = port


# --- the proxy document ------------------------------------------------------

# The spec's sandbox proxy, and only a relay: it forwards every message between the
# host and the View except the reserved ``ui/notifications/sandbox-*`` pair, and
# originates nothing but ``sandbox-proxy-ready``.
#
# The host's channel is a MessagePort handed over with ``sandbox-resource-ready``,
# and the View's is the port its bridge shim hands over on load: both are bound to
# the documents that created them, so a page either frame is navigated to can
# neither send over them nor receive an in-flight reply. Window messages are only
# ever accepted for those two handshakes, and each is taken once.
_PROXY_HTML = """<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>MCP App sandbox</title>
<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:transparent}
iframe{display:block;border:0;width:100%;height:100%}</style>
</head>
<body>
<script>
(() => {
  "use strict";
  const HOST = __HOST_ORIGIN__;
  const OWN = location.origin;
  const RESERVED = "ui/notifications/sandbox-";
  if (window.parent === window) return;
  const isReserved = (data) =>
    !!data && typeof data.method === "string" && data.method.startsWith(RESERVED);
  const FEATURES = [
    ["camera", "camera"],
    ["microphone", "microphone"],
    ["geolocation", "geolocation"],
    ["clipboardWrite", "clipboard-write"],
  ];
  const allowFor = (permissions) =>
    permissions && typeof permissions === "object"
      ? FEATURES.filter(([key]) => permissions[key]).map(([, name]) => name).join("; ")
      : "";

  let hostPort = null;
  let viewPort = null;
  let inner = null;
  let token = null;
  const toView = [];

  const deliverToView = (data) => {
    if (isReserved(data)) return;
    if (viewPort) viewPort.postMessage(data);
    else toView.push(data);
  };

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (event.source === window.parent) {
      if (event.origin !== HOST || hostPort) return;
      if (!data || data.method !== "ui/notifications/sandbox-resource-ready") return;
      const params = data.params || {};
      const port = event.ports && event.ports[0];
      if (!port || typeof params.html !== "string") return;
      hostPort = port;
      token = typeof params.bridgeToken === "string" ? params.bridgeToken : null;
      hostPort.onmessage = (message) => deliverToView(message.data);
      inner = document.createElement("iframe");
      inner.setAttribute(
        "sandbox",
        typeof params.sandbox === "string" ? params.sandbox : "allow-scripts allow-same-origin",
      );
      const allow = allowFor(params.permissions);
      if (allow) inner.setAttribute("allow", allow);
      inner.setAttribute("title", "MCP App");
      document.body.appendChild(inner);
      const doc = inner.contentDocument;
      doc.open();
      doc.write(params.html);
      doc.close();
      return;
    }
    if (inner && event.source === inner.contentWindow) {
      if (event.origin !== OWN || viewPort || !hostPort) return;
      if (!data || data.__unslothMcpAppPort !== true) return;
      if (token === null || data.__unslothMcpApp !== token) return;
      const port = event.ports && event.ports[0];
      if (!port) return;
      viewPort = port;
      viewPort.onmessage = (message) => {
        if (!isReserved(message.data)) hostPort.postMessage(message.data);
      };
      for (const queued of toView.splice(0)) viewPort.postMessage(queued);
    }
  });

  window.parent.postMessage(
    { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} },
    HOST,
  );
})();
</script>
</body>
</html>
"""


def proxy_html(host_origin: str) -> str:
    # `</` inside a JSON string would still close the inline script.
    return _PROXY_HTML.replace("__HOST_ORIGIN__", json.dumps(host_origin).replace("</", "<\\/"))


# --- who may embed it --------------------------------------------------------

_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "[::1]"})
_TAURI_ORIGINS = frozenset({"tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"})


def allowed_host_origin(host_origin: str, request_host: str, primary_port: Optional[int]) -> Optional[str]:
    """The embedding origin if Studio could be serving the page from it, else None.

    Accepted: the desktop app, any loopback origin (the backend itself and a dev
    server), and the primary server on the very hostname this request was sent to,
    which is how a LAN visitor reaches Studio. The result becomes the proxy's only
    ``frame-ancestors`` source and the only origin it accepts messages from."""
    origin = (host_origin or "").strip()
    if origin in _TAURI_ORIGINS:
        return origin
    try:
        parsed = urllib.parse.urlsplit(origin)
    except ValueError:
        return None
    if parsed.scheme != "http" or not parsed.hostname or parsed.path or parsed.query:
        return None
    if parsed.username or parsed.password or parsed.fragment:
        return None
    try:
        port = parsed.port
    except ValueError:
        return None
    netloc_host = parsed.netloc.rsplit(":", 1)[0] if port is not None else parsed.netloc
    canonical = f"http://{netloc_host}" + (f":{port}" if port is not None else "")
    if canonical != origin:
        return None
    if netloc_host.lower() in _LOOPBACK_HOSTS:
        return origin
    request_hostname = urllib.parse.urlsplit(f"http://{request_host}").hostname or ""
    if primary_port and parsed.hostname == request_hostname and port == primary_port:
        return origin
    return None


# --- the listener app ----------------------------------------------------------


def _handle(scope: dict, primary_port: Optional[int], policy: Optional[dict] = None):
    if scope.get("method") not in ("GET", "HEAD") or scope.get("path") != "/":
        return (404, b"Not found", [(b"content-type", b"text/plain; charset=utf-8")])
    query = urllib.parse.parse_qs(scope.get("query_string", b"").decode("latin-1"))

    def one(name: str) -> Optional[str]:
        values = query.get(name)
        return values[0] if values else None

    request_host = ""
    for key, value in scope.get("headers") or []:
        if key == b"host":
            request_host = value.decode("latin-1")
            break
    host_origin = allowed_host_origin(one("host") or "", request_host, primary_port)
    if host_origin is None:
        return (400, b"Unknown host origin", [(b"content-type", b"text/plain; charset=utf-8")])

    from routes.inference import _mcp_app_csp, _mcp_app_domains

    # Whether this listener's server is itself local is the server's own fact, set from
    # its stored row by the route -- never from the query, which the page builds from
    # what the server declared.
    local = bool((policy or {}).get("allow_local"))
    csp = _mcp_app_csp(
        _mcp_app_domains(one("connect"), allow_local = local),
        _mcp_app_domains(one("resource"), allow_local = local),
        _mcp_app_domains(one("frame"), allow_local = local),
        _mcp_app_domains(one("base_uri"), local_schemes = False, allow_local = local),
        # 'self' too: a document the View makes (a blob: frame, say) inherits this
        # policy, and its ancestors then include this origin. WebKit enforces that.
        frame_ancestors = f"{host_origin} 'self'",
        opaque = False,
    )
    # The spec's audit trail: the host SHOULD log the CSP each View is given.
    logger.info("MCP App sandbox policy for %s: %s", host_origin, csp)
    return (
        200,
        proxy_html(host_origin).encode("utf-8"),
        [
            (b"content-type", b"text/html; charset=utf-8"),
            (b"content-security-policy", csp.encode("latin-1")),
            (b"cache-control", b"no-store"),
            # The browser default, stated: a cross-origin request carries only this
            # listener's origin -- no path, no query -- which reveals nothing, and some
            # APIs the View declares insist on one (OpenStreetMap's tile servers answer
            # a request with no Referer with an "Access blocked" tile).
            (b"referrer-policy", b"strict-origin-when-cross-origin"),
            (b"x-content-type-options", b"nosniff"),
            (b"cross-origin-opener-policy", b"same-origin"),
        ],
    )


def _sandbox_app(primary_port: Optional[int], policy: Optional[dict] = None):
    async def app(scope, receive, send):
        if scope["type"] != "http":
            return
        status, body, headers = _handle(scope, primary_port, policy)
        headers = [*headers, (b"content-length", str(len(body)).encode())]
        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": b"" if scope.get("method") == "HEAD" else body})

    return app


# --- remembered ports ------------------------------------------------------------


def _ports_path() -> Optional[Path]:
    try:
        from utils.paths.storage_roots import studio_root

        return studio_root() / _PORTS_FILE
    except Exception:  # noqa: BLE001
        return None


_ports_cache: Optional[dict] = None
_ports_cache_path: Optional[Path] = None
_MAX_FRAME_ORIGINS = 64


def _load_ports() -> dict:
    global _ports_cache, _ports_cache_path
    path = _ports_path()
    if path is None:
        return {}
    # Every Studio response asks (for its frame-src), so read the file once per path.
    if _ports_cache is not None and _ports_cache_path == path:
        return dict(_ports_cache)
    _ports_cache = _read_ports(path)
    _ports_cache_path = path
    return dict(_ports_cache)


def _read_ports(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding = "utf-8"))
    except (OSError, ValueError):
        return {}
    return {
        str(k): int(v)
        for k, v in data.items()
        if isinstance(v, int) and 1024 <= v <= 65535
    } if isinstance(data, dict) else {}


def _remember_port(server_id: str, port: int) -> None:
    path = _ports_path()
    if path is None:
        return
    ports = _load_ports()
    if ports.get(server_id) == port:
        return
    ports[server_id] = port
    _write_ports(path, ports)


def forget_port(server_id: str) -> None:
    """Drop a deleted server's port, so the page policy stops naming it."""
    path = _ports_path()
    if path is None:
        return
    ports = _load_ports()
    if ports.pop(server_id, None) is not None:
        _write_ports(path, ports)


def reserve_port(server_id: str) -> None:
    """Give a new server a remembered port before its first widget.

    The Studio page's CSP can only name ports that exist when the page is served; a
    port picked at first use would be blocked until the next page load. A reservation
    is found by binding port 0 and releasing it (it is only a preference: if something
    takes it meanwhile, ensure_sandbox_port picks another and the opaque fallback
    covers the widget until the page reloads). Never raises."""
    if not _SERVER_ID_RE.match(server_id or "") or server_id in _load_ports():
        return
    try:
        probe = _bind("127.0.0.1", 0)
        port = probe.getsockname()[1]
        probe.close()
    except OSError:
        return
    _remember_port(server_id, port)


def frame_origins(hostname: str) -> list:
    """Exact ``http://<hostname>:<port>`` origins of every remembered sandbox port.

    This is what the Studio page's ``frame-src`` lists, in place of any port. Sorted
    and capped so the header stays bounded."""
    return [f"http://{hostname}:{port}" for port in sorted(set(_load_ports().values()))[:_MAX_FRAME_ORIGINS]]


def _write_ports(path: Path, ports: dict) -> None:
    global _ports_cache, _ports_cache_path
    _ports_cache = dict(ports)
    _ports_cache_path = path
    try:
        path.parent.mkdir(parents = True, exist_ok = True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(ports, sort_keys = True), encoding = "utf-8")
        os.replace(tmp, path)
    except OSError as exc:
        logger.info("Could not remember the MCP App sandbox port: %s", exc)


def _bind(address: str, port: int) -> socket.socket:
    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    try:
        # A remembered port may still sit in TIME_WAIT from the last run. Skipped on
        # Windows, where SO_REUSEADDR lets a socket take over a live listener.
        if os.name != "nt":
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((address, port))
        sock.listen(_LISTEN_BACKLOG)
        sock.set_inheritable(False)
    except BaseException:
        sock.close()
        raise
    return sock


def _normalise_address(address: str) -> Optional[str]:
    try:
        return str(ipaddress.ip_address(address.split("%", 1)[0]))
    except ValueError:
        return None


def _used_ports(address: str) -> set:
    return {listener.port for (addr, _), listener in _listeners.items() if addr == address}


async def ensure_sandbox_port(
    local_address: str, server_id: str, primary_port: Optional[int], allow_local: bool = False
) -> int:
    """The sandbox port for ``server_id`` on ``local_address``, started if needed.

    Must run on the primary server's event loop (an async route does)."""
    address = _normalise_address(local_address)
    if address is None:
        raise ValueError(f"not an IP address: {local_address!r}")
    if not _SERVER_ID_RE.match(server_id or ""):
        raise ValueError("invalid server id")
    key = (address, server_id)
    lock = _locks.setdefault(key, asyncio.Lock())
    async with lock:
        live = _listeners.get(key)
        if live is not None and not live.task.done():
            live.policy["allow_local"] = allow_local
            return live.port

        remembered = _load_ports().get(server_id)
        sock = None
        if remembered and remembered != primary_port and remembered not in _used_ports(address):
            try:
                sock = _bind(address, remembered)
            except OSError:
                sock = None
        if sock is None:
            sock = _bind(address, 0)
        port = sock.getsockname()[1]

        from utils.uvicorn_h11_shutdown import uvicorn_http_protocol

        policy = {"allow_local": allow_local}
        config = uvicorn.Config(
            _sandbox_app(primary_port, policy),
            host = address,
            port = port,
            # a second lifespan would re-fire the app's startup handlers
            lifespan = "off",
            # uvicorn.Config applies log_config eagerly, resetting run.py's startup log rewrite
            log_config = None,
            access_log = False,
            proxy_headers = False,
            server_header = False,
            http = uvicorn_http_protocol(),
        )
        server = uvicorn.Server(config)
        task = asyncio.get_running_loop().create_task(server.serve(sockets = [sock]))
        deadline = asyncio.get_running_loop().time() + _START_TIMEOUT
        while not server.started and not task.done():
            if asyncio.get_running_loop().time() > deadline:
                server.should_exit = True
                break
            await asyncio.sleep(0.01)
        if not server.started:
            sock.close()
            raise RuntimeError("the MCP App sandbox listener did not start")

        _listeners[key] = _Listener(server, task, sock, port)
        _listeners[key].policy = policy
        _remember_port(server_id, port)
        logger.info("MCP App sandbox for %s listening on %s:%s", server_id, address, port)
        return port


async def close_sandbox_listeners(timeout: float = 3.0) -> None:
    """Stop every sandbox listener. Never raises."""
    listeners = list(_listeners.values())
    _listeners.clear()
    for listener in listeners:
        listener.server.should_exit = True
    if not listeners:
        return
    try:
        await asyncio.wait_for(
            asyncio.gather(*(l.task for l in listeners), return_exceptions = True), timeout
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("MCP App sandbox listeners did not stop cleanly: %s", exc)
    for listener in listeners:
        try:
            listener.socket.close()
        except OSError:
            pass


def request_sandbox_shutdown() -> None:
    """Ask every sandbox listener to stop, from any thread. Never raises."""
    for listener in list(_listeners.values()):
        listener.server.should_exit = True
