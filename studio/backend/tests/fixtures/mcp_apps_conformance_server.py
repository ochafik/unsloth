# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"""A stdio MCP Apps server whose widget probes the host it is rendered in.

The widget is a real ext-apps View: it loads the published SDK bundle (given by
``MCP_APPS_SDK_BUNDLE``) from a blob: URL and connects with ``App.connect()``, so the
handshake, the notifications and every request are exactly what a published app
sends. It then checks what the spec and the host promise -- the tool input and
result, host capabilities and context, storage that persists, IndexedDB, a Worker, a
nested frame's storage, a declared fetch and the Origin it carries, that the host
document is out of reach, an app-only tool, ping, display mode, model context -- and
writes the verdicts into ``window.__probe`` and the page.

Server-side events (the handshake's capabilities, every tool call, including the
``save_state`` the widget makes while being torn down) are appended as JSON lines to
``MCP_APPS_LOG``.

Env:
  MCP_APPS_SDK_BUNDLE   path to @modelcontextprotocol/ext-apps dist/src/app-with-deps.js
  MCP_APPS_CONNECT      origin the widget may fetch (declared in connectDomains)
  MCP_APPS_LOG          JSONL event log
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path

import mcp.types as types
from mcp.server.lowlevel import NotificationOptions, Server
from mcp.server.lowlevel.helper_types import ReadResourceContents
from mcp.server.stdio import stdio_server

UI_URI = "ui://conformance/probe.html"
MIME = "text/html;profile=mcp-app"
EXTENSION = "io.modelcontextprotocol/ui"

CONNECT = os.environ.get("MCP_APPS_CONNECT", "")
LOG = os.environ.get("MCP_APPS_LOG", "")

server = Server("mcp-apps-conformance")


def log(event: dict) -> None:
    if not LOG:
        return
    event = {"t": time.time(), **event}
    with open(LOG, "a", encoding = "utf-8") as fh:
        fh.write(json.dumps(event) + "\n")


def client_ui_capability():
    try:
        caps = server.request_context.session.client_params.capabilities
    except Exception:  # noqa: BLE001
        return None
    dumped = caps.model_dump(by_alias = True, exclude_none = True)
    return (dumped.get("extensions") or {}).get(EXTENSION)


@server.list_tools()
async def list_tools() -> list[types.Tool]:
    return [
        types.Tool(
            name = "show_probe",
            description = "Show the MCP Apps conformance probe widget.",
            inputSchema = {
                "type": "object",
                "properties": {"label": {"type": "string"}},
            },
            _meta = {"ui": {"resourceUri": UI_URI}},
        ),
        types.Tool(
            name = "app_echo",
            description = "App-only: echo a value back to the widget.",
            inputSchema = {
                "type": "object",
                "properties": {"value": {"type": "string"}},
            },
            _meta = {"ui": {"resourceUri": UI_URI, "visibility": ["app"]}},
        ),
        types.Tool(
            name = "save_state",
            description = "App-only: persist the widget's state before teardown.",
            inputSchema = {
                "type": "object",
                "properties": {"note": {"type": "string"}, "reason": {"type": "string"}},
            },
            _meta = {"ui": {"resourceUri": UI_URI, "visibility": ["app"]}},
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict):
    ui_cap = client_ui_capability()
    log({"event": "call_tool", "name": name, "arguments": arguments, "ui_capability": ui_cap})
    if name == "show_probe":
        label = str(arguments.get("label", ""))
        text = f"Probe shown for {label!r}. Host advertised MCP Apps: {bool(ui_cap)}."
        return (
            [types.TextContent(type = "text", text = text)],
            {"label": label, "uiCapability": ui_cap},
        )
    if name == "app_echo":
        return [types.TextContent(type = "text", text = f"echo:{arguments.get('value', '')}")]
    if name == "save_state":
        return [types.TextContent(type = "text", text = "saved")]
    raise ValueError(f"unknown tool {name}")


@server.list_resources()
async def list_resources() -> list[types.Resource]:
    return [types.Resource(uri = UI_URI, name = "probe", mimeType = MIME)]


@server.read_resource()
async def read_resource(uri):
    if str(uri) != UI_URI:
        raise ValueError(f"unknown resource {uri}")
    log({"event": "read_resource", "uri": str(uri)})
    return [
        ReadResourceContents(
            content = probe_html(),
            mime_type = MIME,
            meta = {
                "ui": {
                    "csp": {
                        "connectDomains": [CONNECT] if CONNECT else [],
                        # blob: for the SDK module, the Worker and the nested frame.
                        "resourceDomains": ["blob:"],
                        "frameDomains": ["blob:"],
                    },
                    "permissions": {"clipboardWrite": {}},
                    "prefersBorder": True,
                }
            },
        )
    ]


def probe_html() -> str:
    bundle_path = os.environ.get("MCP_APPS_SDK_BUNDLE", "")
    bundle = Path(bundle_path).read_text(encoding = "utf-8") if bundle_path else ""
    # `</script` inside the bundle would end the inline script early.
    bundle_json = json.dumps(bundle).replace("</", "<\\/")
    connect_json = json.dumps(CONNECT)
    return _PROBE.replace("__BUNDLE__", bundle_json).replace("__CONNECT__", connect_json)


_PROBE = """<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>MCP Apps conformance probe</title>
<style>body{font:12px ui-monospace,monospace;margin:8px}pre{white-space:pre-wrap;margin:0}</style>
</head>
<body>
<b>MCP Apps conformance probe</b>
<pre id="out">starting</pre>
<script>window.__SDK_SRC = __BUNDLE__; window.__CONNECT = __CONNECT__;</script>
<script type="module">
const report = { done: false };
window.__probe = report;
const out = document.getElementById("out");
const show = () => { out.textContent = JSON.stringify(report, null, 1); };
const fail = (e) => "FAIL: " + (e && e.name ? e.name + ": " + e.message : String(e));
const step = async (name, fn) => {
  try { report[name] = await fn(); } catch (e) { report[name] = fail(e); }
  show();
};
const timeout = (ms, what) => new Promise((_, rej) => setTimeout(() => rej(new Error(what + " timed out")), ms));

// A count that only a real, persistent origin keeps across a reload of the widget.
await step("runs", () => {
  const n = Number(localStorage.getItem("probe-runs") || "0") + 1;
  localStorage.setItem("probe-runs", String(n));
  return n;
});

const { App } = await import(URL.createObjectURL(new Blob([window.__SDK_SRC], { type: "text/javascript" })));
const app = new App({ name: "conformance-probe", version: "1.0.0" }, {}, { autoResize: true });
window.__app = app;
app.ontoolinput = (p) => { report.toolInput = p.arguments; show(); };
app.ontoolinputpartial = (p) => { (report.toolInputPartials ||= []).push(p.arguments); show(); };
app.ontoolcancelled = (p) => { report.toolCancelled = p && p.reason; show(); };
app.ontoolresult = (p) => { report.toolResult = p.structuredContent ?? p.content; show(); };
app.onhostcontextchanged = (p) => {
  (report.contextChanges ||= []).push(Object.keys(p).sort().join(","));
  if (p.safeAreaInsets) report.lastInsets = p.safeAreaInsets;
  show();
};
// The SDK (2.0) validates teardown params against an empty schema and strips the
// spec's `reason`, so the raw message is read first, off the same window events.
let teardownReason = null;
addEventListener("message", (e) => {
  if (e.data && e.data.method === "ui/resource-teardown") {
    teardownReason = e.data.params && e.data.params.reason;
  }
});
app.onteardown = async () => {
  report.teardown = teardownReason;
  show();
  // The point of the grace: state reaches the server before the frame goes.
  await app.callServerTool({ name: "save_state", arguments: { note: "saved-during-teardown", reason: String(teardownReason) } });
  return {};
};

await step("connect", async () => { await Promise.race([app.connect(), timeout(10000, "connect")]); return "ok"; });
await step("host", () => ({
  name: app.getHostVersion() && app.getHostVersion().name,
  caps: app.getHostCapabilities(),
  ctx: app.getHostContext(),
}));
// self.origin, not location.origin: an opaque sandbox keeps its URL's origin in
// location but reports "null" here, which is the one the browser enforces.
await step("origin", () => self.origin);

await step("indexedDB", () => new Promise((res, rej) => {
  let r;
  try { r = indexedDB.open("probe", 1); } catch (e) { return rej(e); }
  r.onupgradeneeded = () => r.result.createObjectStore("kv");
  r.onsuccess = () => {
    const tx = r.result.transaction("kv", "readwrite");
    tx.objectStore("kv").put("v", "k");
    tx.oncomplete = () => res("ok");
    tx.onerror = () => rej(tx.error);
  };
  r.onerror = () => rej(r.error);
  setTimeout(() => rej(new Error("IDB timeout")), 3000);
}));
await step("cookie", () => { document.cookie = "probe=1; SameSite=Lax"; return document.cookie.includes("probe=1") ? "ok" : "dropped"; });
await step("worker", () => new Promise((res, rej) => {
  let w;
  try { w = new Worker(URL.createObjectURL(new Blob(["postMessage('pong')"], { type: "text/javascript" }))); } catch (e) { return rej(e); }
  w.onmessage = (e) => res(e.data === "pong" ? "ok" : "wrong");
  w.onerror = () => rej(new Error("worker error"));
  setTimeout(() => rej(new Error("worker timeout")), 3000);
}));
await step("nestedStorage", () => new Promise((res) => {
  const inner = "<script>let r='ok';try{localStorage.setItem('n','1');indexedDB.open('n')}catch(e){r='FAIL: '+e.name}parent.postMessage({nested:r},'*')<\\/script>";
  const f = document.createElement("iframe");
  f.style.display = "none";
  f.src = URL.createObjectURL(new Blob([inner], { type: "text/html" }));
  const onMessage = (e) => { if (e.data && e.data.nested) { removeEventListener("message", onMessage); res(e.data.nested); } };
  addEventListener("message", onMessage);
  document.body.appendChild(f);
  setTimeout(() => res("FAIL: nested frame never reported"), 3000);
}));
await step("fetchDeclared", async () => {
  if (!window.__CONNECT) return "skipped";
  const r = await fetch(window.__CONNECT + "/probe");
  return r.ok ? await r.text() : "FAIL: " + r.status;
});
await step("fetchUndeclared", async () => {
  try { await fetch("https://example.com/"); return "REACHED - undeclared domain allowed"; }
  catch (e) { return "blocked"; }
});
await step("hostIsolated", () => {
  // Behind the proxy the widget shares the proxy's origin (by design); the host
  // must still be out of reach. In the opaque fallback even the proxy is.
  let proxy = null;
  try { proxy = window.frameElement && window.frameElement.ownerDocument.defaultView; } catch (e) { proxy = null; }
  const host = proxy ? proxy.parent : null;
  try {
    const d = host ? host.document : null;
    if (d && d.title !== undefined) return "REACHABLE - not isolated";
    return "isolated (no handle)";
  } catch (e) { return "isolated: " + e.name; }
});
await step("appOnlyTool", async () => {
  const r = await app.callServerTool({ name: "app_echo", arguments: { value: "x1" } });
  return r.content && r.content[0] && r.content[0].text;
});
await step("ping", () => new Promise((res, rej) => {
  // Raw, through the same window.parent the SDK uses.
  const onMessage = (e) => {
    if (e.data && e.data.id === "probe-ping") { removeEventListener("message", onMessage); res(e.data.error ? "FAIL: " + e.data.error.message : "ok"); }
  };
  addEventListener("message", onMessage);
  window.parent.postMessage({ jsonrpc: "2.0", id: "probe-ping", method: "ping" }, "*");
  setTimeout(() => rej(new Error("ping timeout")), 3000);
}));
await step("displayMode", async () => {
  const full = (await app.requestDisplayMode({ mode: "fullscreen" })).mode;
  const pip = (await app.requestDisplayMode({ mode: "pip" })).mode;  // not offered: stays put
  const back = (await app.requestDisplayMode({ mode: "inline" })).mode;
  return [full, pip, back].join(",");
});
window.__loadedAt = performance.timeOrigin;
await step("modelContext", async () => {
  await app.updateModelContext({
    content: [
      { type: "text", text: "PROBE-STATE-7f3a" },
      // One red pixel: the host advertises image support, so a screenshot of the view rides along.
      { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
    ],
    structuredContent: { probeState: "7f3a" },
  });
  return "ok";
});
await step("clipboardPolicy", () => {
  const policy = document.permissionsPolicy || document.featurePolicy;
  return policy && policy.allowsFeature ? policy.allowsFeature("clipboard-write") : "unknown";
});
window.__sendMessage = () => app.sendMessage({ role: "user", content: [{ type: "text", text: "hello from the probe app" }] })
  .then((r) => { report.message = r && r.isError ? "isError" : "ok"; }, (e) => { report.message = fail(e); })
  .then(show);
report.done = true;
show();
</script>
</body>
</html>
"""


async def main() -> None:
    async with stdio_server() as (read, write):
        init = server.create_initialization_options(NotificationOptions(), {})
        await server.run(read, write, init)


if __name__ == "__main__":
    asyncio.run(main())
