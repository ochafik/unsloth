# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"""End to end: a real MCP Apps widget, through the real Studio, against the spec.

Nothing is stubbed between the model's tool call and the widget. A deterministic
OpenAI-compatible model (_fake_openai_tool_model.py) is registered as a provider and
answers "run the conformance probe" with a call to the fixture server's
``show_probe``; Studio executes it against the stdio fixture
(studio/backend/tests/fixtures/mcp_apps_conformance_server.py), renders the widget,
and the widget -- a real ext-apps View built on the published SDK -- probes the host
it landed in and reports into ``window.__probe``.

Checked, per the MCP Apps spec (2026-01-26) and what the host advertises:

  * the host tells the server it renders MCP Apps (the extensions capability);
  * the View sits behind a sandbox proxy on another origin, runs at a real origin,
    and cannot reach the host document;
  * that origin gives it persistent localStorage, IndexedDB, a Worker, storage in a
    nested frame, and a declared fetch that carries its real Origin; an undeclared
    domain stays blocked;
  * ui/initialize, tool-input then tool-result, ping, display mode, an app-only tool
    (which the model is never offered), the requested clipboard permission;
  * ui/update-model-context reaches the model on the next turn, attached to the
    result it describes;
  * ui/message needs the user's Send and becomes an ordinary user turn;
  * ui/resource-teardown is sent when the widget goes away, and the View's answer is
    waited for -- the fixture saves state from its teardown handler;
  * the widget's origin survives a remount, so its storage does;
  * with no second origin available, the widget still works in the opaque fallback.

Run against a Studio already up at BASE_URL (see the workflow), or locally:
  BASE_URL=http://127.0.0.1:18892 STUDIO_OLD_PW=... STUDIO_NEW_PW=... \\
  MCP_APPS_SDK_BUNDLE=/path/to/app-with-deps.js python tests/studio/playwright_mcp_app_spec_e2e.py
MCP_APPS_SDK_BUNDLE defaults to downloading @modelcontextprotocol/ext-apps with npm.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import Frame, Page, expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _fake_openai_tool_model import MODEL_ID, FakeToolModel  # noqa: E402
from _playwright_robust import (  # noqa: E402
    chromium_launch_args,
    install_view_transition_killer,
    install_wall_clock_watchdog,
    wait_for_health,
)

BASE = os.environ["BASE_URL"].rstrip("/")
OLD = os.environ.get("STUDIO_OLD_PW", "")
NEW = os.environ["STUDIO_NEW_PW"]
ART = Path(os.environ.get("PW_ART_DIR", "logs/playwright-mcp-app-spec")) / os.environ.get(
    "STUDIO_PLAYWRIGHT_BROWSER", "chromium"
).lower()
WALL_TIMEOUT_S = float(os.environ.get("STUDIO_UI_WALL_TIMEOUT_S", "600"))
MCP_PYTHON = os.environ.get("STUDIO_MCP_PYTHON", sys.executable)
BROWSER = os.environ.get("STUDIO_PLAYWRIGHT_BROWSER", "chromium").lower()
EXT_APPS_VERSION = os.environ.get("MCP_APPS_SDK_VERSION", "2.0.0")
# Delay between the fake model's argument chunks, so the widget really is up
# while the call is still streaming.
ARG_CHUNK_DELAY = float(os.environ.get("STUDIO_MCP_ARG_CHUNK_DELAY", "1.2"))
FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "studio"
    / "backend"
    / "tests"
    / "fixtures"
    / "mcp_apps_conformance_server.py"
)
SERVER_NAME = "MCP Apps conformance"
PROVIDER_NAME = "Fake tool model"
TRIGGER = "run the conformance probe"
MODEL_CONTEXT_MARK = "PROBE-STATE-7f3a"
PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
APP_MESSAGE = "hello from the probe app"


def info(message: str) -> None:
    print(f"[mcp-app-spec] {message}", flush = True)


def api(path: str, payload=None, token: str | None = None, method: str = "POST"):
    request = urllib.request.Request(
        BASE + path,
        data = json.dumps(payload).encode() if payload is not None else None,
        headers = {
            "Content-Type": "application/json",
            **({"Authorization": f"Bearer {token}"} if token else {}),
        },
        method = method,
    )
    with urllib.request.urlopen(request, timeout = 60) as response:
        body = response.read()
        return json.loads(body) if body else {}


def authenticate() -> dict:
    try:
        session = api("/api/auth/login", {"username": "unsloth", "password": NEW})
        if not session.get("must_change_password"):
            return session
    except urllib.error.HTTPError:
        pass
    initial = api("/api/auth/login", {"username": "unsloth", "password": OLD})
    try:
        api(
            "/api/auth/change-password",
            {"current_password": OLD, "new_password": NEW},
            initial["access_token"],
        )
    except urllib.error.HTTPError as exc:
        if exc.code not in (400, 401, 403):
            raise
    return api("/api/auth/login", {"username": "unsloth", "password": NEW})


def sdk_bundle(workdir: Path) -> Path:
    given = os.environ.get("MCP_APPS_SDK_BUNDLE")
    if given:
        return Path(given)
    subprocess.run(
        ["npm", "pack", f"@modelcontextprotocol/ext-apps@{EXT_APPS_VERSION}", "--silent"],
        cwd = workdir,
        check = True,
        capture_output = True,
    )
    tarball = next(workdir.glob("modelcontextprotocol-ext-apps-*.tgz"))
    subprocess.run(["tar", "-xzf", tarball.name], cwd = workdir, check = True)
    return workdir / "package" / "dist" / "src" / "app-with-deps.js"


class OriginRecorder:
    """The domain the widget declares in connectDomains: answers and records Origin."""

    def __init__(self):
        self.origins: list[str] = []
        recorder = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                return

            def do_GET(self):  # noqa: N802
                origin = self.headers.get("Origin", "(none)")
                recorder.origins.append(origin)
                body = f"origin={origin}".encode()
                self.send_response(200)
                self.send_header("Access-Control-Allow-Origin", origin if origin != "(none)" else "*")
                self.send_header("Content-Type", "text/plain")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target = self._server.serve_forever, daemon = True).start()
        self.origin = f"http://127.0.0.1:{self._server.server_address[1]}"

    def stop(self):
        self._server.shutdown()
        self._server.server_close()


def read_events(log: Path) -> list[dict]:
    if not log.exists():
        return []
    return [json.loads(line) for line in log.read_text().splitlines() if line.strip()]


def wait_until(predicate, timeout: float, what: str, interval: float = 0.25):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = predicate()
        if last:
            return last
        time.sleep(interval)
    raise AssertionError(f"timed out waiting for {what} (last: {last!r})")


def view_frame(page: Page) -> Frame | None:
    """The frame running the probe: behind the proxy it is the proxy's child."""
    for frame in page.frames:
        try:
            if frame.evaluate("() => typeof window.__probe === 'object'"):
                return frame
        except Exception:  # noqa: BLE001 - detached or cross-origin mid-navigation
            continue
    return None


def wait_for_probe(page: Page, timeout: float = 60) -> tuple[Frame, dict]:
    def ready():
        frame = view_frame(page)
        if frame is None:
            return None
        report = frame.evaluate("() => window.__probe")
        return (frame, report) if report and report.get("done") else None

    return wait_until(ready, timeout, "the probe to finish")


def remove_prior(token: str) -> None:
    for server in api("/api/mcp/servers/", token = token, method = "GET"):
        if server.get("display_name") == SERVER_NAME:
            api(f"/api/mcp/servers/{server['id']}", token = token, method = "DELETE")
    for provider in api("/api/providers/", token = token, method = "GET"):
        if provider.get("display_name") == PROVIDER_NAME:
            api(f"/api/providers/{provider['id']}", token = token, method = "DELETE")


def send(page: Page, text: str) -> None:
    # A fresh Studio shows an update notice whose rail can cover the Send button.
    snooze = page.locator('[data-testid="web-update-snooze-button"]')
    if snooze.count() and snooze.first.is_visible():
        snooze.first.click()
    composer = page.locator('textarea[aria-label="Message input"]')
    composer.wait_for(state = "visible", timeout = 60_000)
    composer.click()
    composer.fill(text)
    page.locator('button[aria-label="Send message"]').click()


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)
    info(f"ok  {message}")


def frame_height(page: Page) -> float:
    return page.locator('[data-slot="mcp-app-frame"]').first.bounding_box()["height"]


def run(page: Page, model: FakeToolModel, recorder: OriginRecorder, events: Path) -> str:
    page.goto(f"{BASE}/chat", wait_until = "domcontentloaded", timeout = 60_000)

    # 1. The model calls the tool; the widget comes up while it is still writing
    # the arguments, is told them as they parse, and is not reloaded by its own
    # result.
    send(page, TRIGGER)
    def partials():
        f = view_frame(page)
        if not f:
            return 0
        try:
            return len(f.evaluate("() => (window.__probe && window.__probe.toolInputPartials) || []"))
        except Exception:  # noqa: BLE001
            return 0
    wait_until(lambda: partials() >= 1, 60, "ui/notifications/tool-input-partial")
    loaded_while_streaming = view_frame(page).evaluate("() => window.__loadedAt")
    page.screenshot(path = str(ART / "00-streaming.png"), full_page = True)
    frame, report = wait_for_probe(page)
    page.screenshot(path = str(ART / "01-widget.png"), full_page = True)
    (ART / "probe-proxy.json").write_text(json.dumps(report, indent = 1))

    # 2. The negotiated extension, as the server saw it. The call only executes
    # once the model's arguments finish streaming, so wait for it rather than
    # assuming the widget's readiness implies it.
    shown = wait_until(
        lambda: [e for e in read_events(events) if e.get("name") == "show_probe"] or None,
        60,
        "the streamed call to execute",
    )
    check(bool(shown) and shown[-1]["ui_capability"] == {"mimeTypes": ["text/html;profile=mcp-app"]},
          "the host advertised io.modelcontextprotocol/ui to the server")

    # 3. The origin: behind a proxy, real, not the host's, and the host out of reach.
    origin = report["origin"]
    check(origin not in ("null", BASE) and origin.startswith("http://"), f"the view has its own real origin ({origin})")
    check(str(report["hostIsolated"]).startswith("isolated"), f"the host document is out of reach ({report['hostIsolated']})")

    # 4. The handshake and the seed.
    host = report["host"]
    check(host["name"] == "Unsloth", "ui/initialize answered with hostInfo")
    caps = host["caps"] or {}
    for capability in ("openLinks", "serverTools", "logging", "message", "updateModelContext"):
        check(capability in caps, f"host advertises {capability}")
    check(caps.get("sandbox", {}).get("permissions") == {"clipboardWrite": {}}, "the requested clipboard permission is granted")
    ctx = host["ctx"] or {}
    check(ctx.get("displayMode") == "inline", "display mode context")
    dims = ctx.get("containerDimensions") or {}
    check(dims.get("width", 0) > 0 and dims.get("maxHeight") == 900, f"container dimensions sent ({dims})")
    report = wait_until(
        lambda: (lambda r: r if r.get("toolInput") is not None else None)(view_frame(page).evaluate("() => window.__probe")),
        30,
        "the seeded tool input",
    )
    report = wait_until(
        lambda: (lambda r: r if r.get("toolInput") is not None else None)(
            view_frame(page).evaluate("() => window.__probe")
        ),
        30,
        "the seeded tool input",
    )
    check(report.get("toolInput") == {"label": "e2e"}, "tool-input carries the model's arguments")
    partial_list = report.get("toolInputPartials") or []
    check(
        len(partial_list) >= 1
        and any(json.dumps(p, sort_keys = True) != json.dumps({"label": "e2e"}, sort_keys = True) for p in partial_list),
        f"tool-input-partial carried the arguments mid-stream ({partial_list[-1] if partial_list else None})",
    )
    check(
        frame.evaluate("() => window.__loadedAt") == loaded_while_streaming,
        "the frame was not reloaded by its own result",
    )
    check((report.get("toolResult") or {}).get("label") == "e2e", "tool-result carries the structured content")

    # 5. What a real origin buys, and what the CSP still refuses.
    for key in ("indexedDB", "worker", "nestedStorage"):
        check(report[key] == "ok", f"{key}: {report[key]}")
    check(report["cookie"] in ("ok", "dropped"), f"document.cookie does not throw ({report['cookie']})")
    check(report["fetchDeclared"] == f"origin={origin}", f"a declared fetch carries the real Origin ({report['fetchDeclared']})")
    check(origin in recorder.origins, "the declared API saw the widget's origin")
    check(report["fetchUndeclared"] == "blocked", "an undeclared domain is blocked")
    # WebKit and Firefox have no policy API for the View to ask.
    caption = page.get_by_text("This app can connect to", exact = False).first
    check(caption.is_visible() and recorder.origin.split("://", 1)[1] in caption.inner_text(),
          "the user is shown the outside host the widget can reach")
    check(report["clipboardPolicy"] in (True, "unknown"),
          f"clipboard-write is allowed by Permission Policy ({report['clipboardPolicy']})")

    # 6. Requests the host answers.
    check(report["connect"] == "ok", "App.connect() completed")
    check(report["appOnlyTool"] == "echo:x1", "an app-only tool is callable from the widget")
    check(report["ping"] == "ok", "ping is answered")
    check(report["displayMode"] == "fullscreen,fullscreen,inline",
          f"request-display-mode grants fullscreen, refuses pip, returns the resulting mode ({report['displayMode']})")
    check(ctx.get("availableDisplayModes") == ["inline", "fullscreen"], "the host offers inline and fullscreen")
    check(report["modelContext"] == "ok", "ui/update-model-context is accepted")
    check(frame_height(page) > 320, f"size-changed resized the frame ({frame_height(page)}px)")

    # 6b. Fullscreen, asked for by the View: the widget covers the window, the frame
    # is not reloaded, and the host's own bar takes it back out.
    loaded_at = frame.evaluate("() => window.__loadedAt")
    frame.evaluate("() => { window.__probe.contextChanges = []; window.__app.requestDisplayMode({ mode: 'fullscreen' }); }")
    holder = page.locator('[data-slot="mcp-app-frame"]').first
    expect(holder).to_have_attribute("data-display-mode", "fullscreen", timeout = 10_000)
    viewport = page.viewport_size
    wait_until(lambda: (holder.bounding_box() or {}).get("height", 0) >= viewport["height"] - 2, 10, "the widget to fill the window")
    box = holder.bounding_box()
    check(box["x"] <= 1 and box["y"] <= 1 and box["width"] >= viewport["width"] - 2,
          f"fullscreen covers the window ({box})")
    check(wait_until(lambda: "containerDimensions,displayMode,safeAreaInsets" in (view_frame(page).evaluate("() => window.__probe.contextChanges") or []), 10, "the mode change"),
          "the View was told its new mode and dimensions")
    # The host bar above and the floating chat below arrive as insets, so the
    # View can keep its content clear of both.
    insets = wait_until(
        lambda: (view_frame(page).evaluate("() => window.__probe.lastInsets") if view_frame(page) else None),
        10,
        "safeAreaInsets",
    )
    check(
        insets and insets.get("top") == 40 and insets.get("bottom", 0) >= 56,
        f"safeAreaInsets name the host bar and the floating chat ({insets})",
    )
    # The chat floats over the fullscreen widget: the thread's own composer.
    before = len(model.requests)
    bar_input = page.get_by_role("textbox", name = "Message the chat")
    # Typed key by key, as a person types: a box bound straight to the composer's
    # asynchronous state kept only the last character.
    bar_input.press_sequentially("what page is it on?", delay = 15)
    page.get_by_role("button", name = "Send to the chat").click()
    wait_until(lambda: len(model.requests) > before, 30, "the fullscreen chat's turn")
    last_user = [m for m in model.requests[-1]["messages"] if m.get("role") == "user"][-1]
    check("what page is it on?" in json.dumps(last_user.get("content")), "the fullscreen chat bar sent an ordinary user turn")
    # The widget's last update before this message was captured onto it: the note
    # ahead of the user's text, and the image with it, as this turn's own parts.
    check(MODEL_CONTEXT_MARK in json.dumps(last_user.get("content")) and "[State of the show_probe app" in json.dumps(last_user.get("content")),
          "the widget's state rode the message it preceded, as a note ahead of the text")
    check(isinstance(last_user.get("content"), list) and any(p.get("type") == "image_url" and PIXEL in json.dumps(p) for p in last_user["content"]),
          "its image came with that message as image input")
    captured_note = next(p["text"] for p in last_user["content"] if p.get("type") == "text")
    (ART / "captured-message.json").write_text(json.dumps(last_user, indent = 1))
    expect(page.locator('[data-slot="mcp-app-fullscreen-chat"]')).to_contain_text("what page is it on?", timeout = 30_000)
    check(True, "its reply shows above the bar, still in fullscreen")
    check(holder.get_attribute("data-display-mode") == "fullscreen", "the widget stayed fullscreen through the turn")
    page.screenshot(path = str(ART / "01b-fullscreen.png"))
    page.get_by_role("button", name = "Exit full screen").click()
    expect(holder).to_have_attribute("data-display-mode", "inline", timeout = 10_000)
    check(view_frame(page).evaluate("() => window.__loadedAt") == loaded_at,
          "the frame survived fullscreen and back without reloading")

    # 7. The model is never offered an app-only tool.
    offered = {
        (tool.get("function") or {}).get("name", "")
        for tool in (model.requests[0].get("tools") or [])
    }
    check(any(name.endswith("show_probe") for name in offered), "the model was offered show_probe")
    check(not any(name.endswith(("app_echo", "save_state")) for name in offered),
          "the model was not offered the app-only tools")

    # 8. The widget's last model-context update rides the tool result next turn.
    before = len(model.requests)
    send(page, "what does the probe show now?")
    wait_until(lambda: len(model.requests) > before, 60, "the follow-up turn")
    history = model.requests[-1]["messages"]
    users = [m for m in history if m.get("role") == "user"]
    check("[State of" not in json.dumps(users[-1].get("content")), "no update since: the new message carries nothing")
    check(any(captured_note == (p.get("text") if isinstance(p, dict) else None) or captured_note == c
              for m in users for c in [m.get("content")] for p in (c if isinstance(c, list) else [c])),
          "the earlier turn replays its note byte for byte")
    check(PIXEL not in json.dumps(history), "the earlier turn's image is not uploaded again")
    check(not any(MODEL_CONTEXT_MARK in str(m.get("content")) for m in history if m.get("role") == "tool"),
          "no tool result carries widget state: history is append-only")
    page.wait_for_function(
        "() => !document.querySelector('button[aria-label=\"Stop generating\"]')",
        timeout = 60_000,
    )

    # 9. ui/message: refused without the user's Send, an ordinary turn with it.
    frame = view_frame(page)
    frame.evaluate("() => { window.__probe.message = undefined; window.__sendMessage(); }")
    card = page.get_by_role("group", name = "Message from this app")
    expect(card).to_be_visible(timeout = 15_000)
    card.get_by_role("button", name = "Don't send").click()
    wait_until(lambda: view_frame(page).evaluate("() => window.__probe.message"), 15, "the declined message's answer")
    check(str(view_frame(page).evaluate("() => window.__probe.message")).startswith("FAIL"), "a declined message is refused")
    before = len(model.requests)
    view_frame(page).evaluate("() => { window.__probe.message = undefined; window.__sendMessage(); }")
    expect(card).to_be_visible(timeout = 15_000)
    card.get_by_role("button", name = "Send", exact = True).click()
    wait_until(lambda: len(model.requests) > before, 60, "the app's message to reach the model")
    last_user = [m for m in model.requests[-1]["messages"] if m.get("role") == "user"][-1]
    check(APP_MESSAGE in json.dumps(last_user.get("content")), "the app's message became a user turn")
    wait_until(lambda: view_frame(page).evaluate("() => window.__probe.message") == "ok", 15, "the sent message's answer")
    check(True, "ui/message resolved for the view")
    page.wait_for_function(
        "() => !document.querySelector('button[aria-label=\"Stop generating\"]')",
        timeout = 60_000,
    )
    page.screenshot(path = str(ART / "02-after-message.png"), full_page = True)

    # 10. Teardown: leaving the thread tells the widget, and waits for it to save.
    saves_before = len([e for e in read_events(events) if e.get("name") == "save_state"])
    new_chat = page.locator('[data-sidebar="menu-button"]').filter(has_text = "New Chat").first
    new_chat.click()
    saved = wait_until(
        lambda: [e for e in read_events(events) if e.get("name") == "save_state"][saves_before:],
        15,
        "the widget to save its state during teardown",
    )
    # Announced from the navigation, while the frame is still mounted -- the path
    # that works in every browser. (Unmounting without a navigation says "closed".)
    reason = saved[-1]["arguments"].get("reason")
    check(reason in ("The user left this conversation.", "The widget was closed."),
          f"ui/resource-teardown reached the view, which saved before the frame went ({reason})")

    # 11. Back again, the way a user does: the same origin, so the widget's own
    # storage is still there.
    page.locator('[data-testid="recent-thread"]').filter(has_text = TRIGGER).first.click()
    _, again = wait_for_probe(page)
    check(again["origin"] == origin, "the server's widget origin is stable across a remount")
    check(int(again["runs"]) >= 2, f"localStorage persisted across the remount (runs={again['runs']})")

    wait_until(lambda: "thread=" in page.url, 15, "the thread's own URL")
    return page.url


def run_cancelled(context, model: FakeToolModel, token: str) -> None:
    """A call the user stops: the widget it had drawn is told, not left hanging."""
    page = context.new_page()
    page.set_default_timeout(20_000)
    try:
        page.goto(f"{BASE}/chat", wait_until = "domcontentloaded", timeout = 60_000)
        send(page, TRIGGER)
        wait_until(
            lambda: next(
                (
                    len(f.evaluate("() => (window.__probe && window.__probe.toolInputPartials) || []"))
                    for f in page.frames
                    if (lambda x: x and x.evaluate("() => !!window.__probe"))(f)
                ),
                0,
            )
            >= 1,
            60,
            "the widget to be up mid-stream",
        )
        page.locator('button[aria-label="Stop generating"]').click()
        told = wait_until(
            lambda: next(
                (f.evaluate("() => window.__probe.toolCancelled") for f in page.frames if f.evaluate("() => window.__probe && window.__probe.toolCancelled")),
                None,
            ),
            15,
            "ui/notifications/tool-cancelled",
        )
        check(told == "The user stopped this tool call.", f"the stopped call's widget was told ({told})")
        res = api("/api/chat/threads", token = token, method = "GET")
        threads = res.get("threads", res) if isinstance(res, dict) else res
        ids = [t["id"] for t in threads if t.get("title") == TRIGGER and t["id"] not in (page.url,)]
        page.screenshot(path = str(ART / "03-cancelled.png"), full_page = True)
    finally:
        page.close()


def run_fallback(page: Page, thread_url: str, model: FakeToolModel | None = None) -> None:
    # No second origin available: the frame must still work, opaquely.
    page.route(
        "**/api/mcp/servers/app-sandbox**",
        lambda route: route.fulfill(status = 200, content_type = "application/json", body = '{"port": null}'),
    )
    page.goto(thread_url, wait_until = "domcontentloaded", timeout = 60_000)
    _, report = wait_for_probe(page)
    (ART / "probe-fallback.json").write_text(json.dumps(report, indent = 1))
    check(report["origin"] == "null", "the fallback runs at an opaque origin")
    check(
        page.get_by_text("stricter isolated mode", exact = False).first.is_visible(),
        "the fallback says so, where the user can see it",
    )
    check(report["connect"] == "ok" and (report.get("toolResult") or {}).get("label") == "e2e",
          "the fallback still connects and is seeded")
    check(report["appOnlyTool"] == "echo:x1" and report["ping"] == "ok", "the fallback still answers requests")
    check(str(report["indexedDB"]).startswith("FAIL"), "IndexedDB is unavailable at the opaque origin, as expected")
    check(str(report["hostIsolated"]).startswith("isolated"), "the fallback keeps the host out of reach")
    if model is not None:
        # A fresh page is a reload: the widget re-sent the same state on load, and the
        # captured note was persisted. Nothing new, and the history unchanged.
        before = len(model.requests)
        send(page, "anything new after the reload?")
        wait_until(lambda: len(model.requests) > before, 60, "the turn after the reload")
        users = [m for m in model.requests[-1]["messages"] if m.get("role") == "user"]
        check("[State of" not in json.dumps(users[-1].get("content")), "after a reload, unchanged state adds nothing")
        check(any("[State of the show_probe app" in json.dumps(m.get("content")) for m in users[:-1]),
              "after a reload, the earlier turn still carries its note (persisted)")


def main() -> int:
    ART.mkdir(parents = True, exist_ok = True)
    events = ART / "server-events.jsonl"
    events.unlink(missing_ok = True)
    wait_for_health(BASE, timeout = 60, info = info)
    session = authenticate()
    token = session["access_token"]
    remove_prior(token)

    workdir = Path(tempfile.mkdtemp(prefix = "mcp-app-spec-"))
    bundle = sdk_bundle(workdir)
    check(bundle.exists(), f"ext-apps SDK bundle at {bundle}")
    model = FakeToolModel(
        trigger = TRIGGER,
        tool_suffix = "show_probe",
        tool_args = {"label": "e2e"},
        arg_chunk_delay = ARG_CHUNK_DELAY,
    )
    base_url = model.start()
    recorder = OriginRecorder()
    install_wall_clock_watchdog(WALL_TIMEOUT_S, label = "mcp-app-spec", info = info)
    try:
        url = api(
            "/api/mcp/servers/stdio/encode",
            {"command": MCP_PYTHON, "arguments": [str(FIXTURE)]},
            token,
        )["url"]
        server = api(
            "/api/mcp/servers/",
            {
                "display_name": SERVER_NAME,
                "url": url,
                "headers": {
                    "MCP_APPS_SDK_BUNDLE": str(bundle),
                    "MCP_APPS_CONNECT": recorder.origin,
                    "MCP_APPS_LOG": str(events),
                },
            },
            token,
        )
        probe = api(f"/api/mcp/servers/{server['id']}/refresh", {}, token)
        check(probe.get("ok") and probe.get("tool_count") == 3, f"fixture server is up ({probe})")
        provider = api(
            "/api/providers/",
            {
                "provider_type": "custom",
                "display_name": PROVIDER_NAME,
                "base_url": base_url,
                "models": [MODEL_ID],
                "available_models": [MODEL_ID],
            },
            token,
        )
        seed = (
            "(() => {"
            f"localStorage.setItem('unsloth_auth_token', {json.dumps(token)});"
            f"localStorage.setItem('unsloth_refresh_token', {json.dumps(session.get('refresh_token', ''))});"
            "localStorage.setItem('unsloth_chat_mcp_enabled', 'true');"
            "localStorage.setItem('unsloth_chat_permission_mode', 'off');"
            f"localStorage.setItem('unsloth_chat_last_external_checkpoint', {json.dumps(f'external::{provider['id']}::{MODEL_ID}')});"
            "})();"
        )
        with sync_playwright() as playwright:
            if BROWSER not in ("chromium", "firefox", "webkit"):
                raise AssertionError(f"unsupported browser: {BROWSER}")
            launch: dict = {"headless": True}
            if BROWSER == "chromium":
                launch["args"] = chromium_launch_args()
            browser = getattr(playwright, BROWSER).launch(**launch)
            context = browser.new_context(viewport = {"width": 1280, "height": 1000}, reduced_motion = "reduce")
            install_view_transition_killer(context)
            context.add_init_script(seed)
            page = context.new_page()
            page.set_default_timeout(20_000)
            console = []
            page.on("console", lambda m: console.append(f"{m.type}: {m.text}"))
            page.on("pageerror", lambda e: console.append(f"PAGEERROR: {e}"))
            try:
                thread_url = run(page, model, recorder, events)
                fallback = context.new_page()
                fallback.set_default_timeout(20_000)
                run_cancelled(context, model, token)
                run_fallback(fallback, thread_url, model)
            finally:
                page.screenshot(path = str(ART / "99-final.png"), full_page = True)
                (ART / "console.log").write_text("\n".join(console))
                (ART / "model-requests.json").write_text(json.dumps(model.requests, indent = 1)[:2_000_000])
                context.close()
                browser.close()
    finally:
        model.stop()
        recorder.stop()
        remove_prior(token)
    info("PASS MCP Apps spec end to end: proxy origin, handshake, storage, requests, model context, message, teardown, persistence, fallback")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
