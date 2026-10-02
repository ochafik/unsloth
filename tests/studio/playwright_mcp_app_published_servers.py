# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"""Published MCP Apps, unmodified, through the real Studio.

Where playwright_mcp_app_spec_e2e.py probes the host with a fixture, this runs the
ext-apps project's own example servers as a user would get them from npm:

  * server-pdf -- PDF.js parses in a blob: Worker (falling back to a data: module)
    and the viewer pulls the document through a stream of app-only tool calls;
  * server-map -- CesiumJS: WebGL, Workers, and OpenStreetMap tiles, whose servers
    refuse a request that carries no Referer;
  * server-threejs -- a WebGL scene;
  * server-basic-react -- a React app calling back into its server.

Each passes when it has drawn itself, at a real origin that is not Studio's, with no
errors in the console. Needs npm and network access (the packages, the PDF --
MCP_APPS_PDF_URL, arXiv by default -- and the map tiles). Otherwise run like
playwright_mcp_app_spec_e2e.py; MCP_APPS_EXAMPLES narrows the list.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
import playwright_mcp_app_spec_e2e as spec  # noqa: E402
from _playwright_robust import chromium_launch_args, install_wall_clock_watchdog  # noqa: E402

PDF_URL = os.environ.get("MCP_APPS_PDF_URL", "https://arxiv.org/pdf/1706.03762")
PDF_TITLE = os.environ.get("MCP_APPS_PDF_TITLE", "Attention Is All You Need")
VERSION = os.environ.get("MCP_APPS_EXAMPLES_VERSION", "2.0.0")
SERVER_PREFIX = "Published MCP App: "
TRIGGER = "show me the example"
# package, the tool that draws it, its arguments, and what "drawn" means in the View
CASES = [
    (
        "server-pdf",
        "display_pdf",
        {"url": PDF_URL},
        f"() => (document.body && document.body.innerText || '').toLowerCase().includes({json.dumps(PDF_TITLE.lower())})",
    ),
    (
        "server-map",
        "show-map",
        {},
        "() => [...document.querySelectorAll('canvas')].some((c) => c.width > 200 && c.height > 100)",
    ),
    (
        "server-threejs",
        "show_threejs_scene",
        {},
        "() => [...document.querySelectorAll('canvas')].some((c) => c.width > 100 && c.height > 100)",
    ),
    (
        "server-basic-react",
        "get-time",
        {},
        r"() => /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(document.body && document.body.innerText || '')",
    ),
]


def info(message: str) -> None:
    print(f"[mcp-app-published] {message}", flush = True)


def remove_prior(token: str) -> None:
    for server in spec.api("/api/mcp/servers/", token = token, method = "GET"):
        if str(server.get("display_name", "")).startswith(SERVER_PREFIX):
            spec.api(f"/api/mcp/servers/{server['id']}", token = token, method = "DELETE")
    for provider in spec.api("/api/providers/", token = token, method = "GET"):
        if provider.get("display_name") == spec.PROVIDER_NAME:
            spec.api(f"/api/providers/{provider['id']}", token = token, method = "DELETE")


def install_servers(workdir: Path, packages: list[str]) -> Path:
    subprocess.run(["npm", "init", "-y"], cwd = workdir, check = True, capture_output = True)
    subprocess.run(
        ["npm", "install", "--no-audit", "--no-fund", *(f"@modelcontextprotocol/{p}@{VERSION}" for p in packages)],
        cwd = workdir,
        check = True,
        capture_output = True,
    )
    return workdir / "node_modules" / "@modelcontextprotocol"


def run_case(browser_type, session: dict, root: Path, art: Path, case) -> None:
    package, tool, args, drawn_js = case
    token = session["access_token"]
    remove_prior(token)
    model = spec.FakeToolModel(trigger = TRIGGER, tool_suffix = tool, tool_args = args)
    base_url = model.start()
    try:
        url = spec.api(
            "/api/mcp/servers/stdio/encode",
            {"command": "node", "arguments": [str(root / package / "dist" / "index.js"), "--stdio"]},
            token,
        )["url"]
        server = spec.api(
            "/api/mcp/servers/",
            {"display_name": SERVER_PREFIX + package, "url": url, "headers": {"PATH": os.environ.get("PATH", "")}},
            token,
        )
        probe = spec.api(f"/api/mcp/servers/{server['id']}/refresh", {}, token)
        spec.check(bool(probe.get("ok")), f"{package} is up ({probe.get('tool_count')} tools)")
        provider = spec.api(
            "/api/providers/",
            {
                "provider_type": "custom",
                "display_name": spec.PROVIDER_NAME,
                "base_url": base_url,
                "models": [spec.MODEL_ID],
                "available_models": [spec.MODEL_ID],
            },
            token,
        )
        seed = (
            "(() => {"
            f"localStorage.setItem('unsloth_auth_token', {json.dumps(token)});"
            f"localStorage.setItem('unsloth_refresh_token', {json.dumps(session.get('refresh_token', ''))});"
            "localStorage.setItem('unsloth_chat_mcp_enabled', 'true');"
            "localStorage.setItem('unsloth_chat_permission_mode', 'off');"
            f"localStorage.setItem('unsloth_chat_last_external_checkpoint', {json.dumps(f'external::{provider['id']}::{spec.MODEL_ID}')});"
            "})();"
        )
        launch: dict = {"headless": True}
        if spec.BROWSER == "chromium":
            # Not the shared CI args: they turn the GPU off, and two of these are WebGL.
            launch["args"] = [a for a in chromium_launch_args() if a != "--disable-gpu"]
        browser = browser_type.launch(**launch)
        context = browser.new_context(viewport = {"width": 1280, "height": 1100})
        context.add_init_script(seed)
        page = context.new_page()
        console: list[str] = []
        page.on("console", lambda m: console.append(f"{m.type}: {m.text}"))
        try:
            page.goto(f"{spec.BASE}/chat", wait_until = "domcontentloaded", timeout = 60_000)
            spec.send(page, TRIGGER)
            holder = page.locator('[data-slot="mcp-app-frame"]').first
            holder.wait_for(timeout = 60_000)

            def drawn():
                for frame in page.frames:
                    try:
                        origin = frame.evaluate("() => self.origin")
                        if origin in ("null", spec.BASE):
                            continue
                        if frame.evaluate(drawn_js):
                            return origin
                    except Exception:  # noqa: BLE001 - a frame mid-navigation
                        continue
                return None

            origin = spec.wait_until(drawn, 90, f"{package} to draw itself")
            spec.check(True, f"{package} drew itself at its own origin ({origin})")
            page.wait_for_timeout(2_000)
            errors = [
                line for line in console
                if line.startswith("error") and "Failed to load resource" not in line
            ]
            spec.check(not errors, f"{package}: no console errors ({errors[:3]})")
            holder.screenshot(path = str(art / f"{package}.png"))
        finally:
            (art / f"{package}-console.log").write_text("\n".join(console))
            context.close()
            browser.close()
    finally:
        model.stop()
        remove_prior(token)


def main() -> int:
    art = spec.ART.parent / f"published-servers-{spec.BROWSER}"
    art.mkdir(parents = True, exist_ok = True)
    wanted = [p.strip() for p in os.environ.get("MCP_APPS_EXAMPLES", "").split(",") if p.strip()]
    cases = [case for case in CASES if not wanted or case[0] in wanted]
    spec.wait_for_health(spec.BASE, timeout = 60, info = info)
    session = spec.authenticate()
    root = install_servers(Path(tempfile.mkdtemp(prefix = "mcp-apps-published-")), [c[0] for c in cases])
    install_wall_clock_watchdog(spec.WALL_TIMEOUT_S, label = "mcp-app-published", info = info)
    with sync_playwright() as playwright:
        browser_type = getattr(playwright, spec.BROWSER)
        for case in cases:
            run_case(browser_type, session, root, art, case)
    info(f"PASS {len(cases)} published MCP Apps drew themselves at their own origins with clean consoles")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
