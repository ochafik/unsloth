// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

// What MCP Apps (2026-01-26) asks of a host, checked against the frame. The frame
// pulls in React and the runtime store, so its pure helpers are lifted out of the
// source and its wiring is asserted in the source, like mcp-app-frame-bridge.test.ts.
// The behaviour in a real browser is tests/studio/playwright_mcp_app_spec_e2e.py.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import {
  MAX_LIVE_WIDGETS,
  WIDGET_CONTEXT_TOOL_NAME,
  joinWidgetContextCalls,
  widgetContextCallId,
  widgetContextMessages,
  MAX_MODEL_CONTEXT_CHARS,
  MAX_SNAPSHOT_CHARS,
  mcpAppContextNote,
  pruneMcpAppContextForMessages,
  pruneMcpAppContextForThreads,
  mcpAppContextSnapshot,
  prepareMcpAppContext,
  resetMcpAppContextForTests,
  setMcpAppContextStore,
  setMcpAppModelContext,
  type McpAppContextSnapshot,
} from "../src/features/chat/mcp-apps/model-context.ts";

const FRAME = fileURLToPath(
  new URL("../src/features/chat/mcp-apps/mcp-app-frame.tsx", import.meta.url),
);
const text = readFileSync(FRAME, "utf8");
const permissionsCsp = readFileSync(
  new URL("../src/features/chat/mcp-apps/permissions-csp.ts", import.meta.url),
  "utf8",
);
const adapter = readFileSync(
  new URL("../src/features/chat/api/chat-adapter.ts", import.meta.url),
  "utf8",
);

function liftFunction<T>(signature: string, source = permissionsCsp): T {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} is no longer in the module that declared it`);
  const end = source.indexOf("\n}\n", start);
  const declaration = source.slice(start, end + 3).replace(/^export /, "");
  const name = /function (\w+)/.exec(declaration)?.[1];
  return new Function(
    `${
      ts.transpileModule(declaration, {
        compilerOptions: { target: ts.ScriptTarget.ES2020 },
      }).outputText
    }; return ${name};`,
  )() as T;
}

/** The body of one `case "<method>":` in the view's message handler. */
function caseBody(method: string): string {
  const start = text.indexOf(`case "${method}": {`);
  assert.ok(start >= 0, `the handler no longer answers ${method}`);
  const end = text.indexOf("\n        case ", start + 1);
  return text.slice(start, end > start ? end : undefined);
}

test("the sandbox proxy is served from another origin of the backend's own host", () => {
  const origin = liftFunction<
    (port: number, apiBase: string, page: { protocol: string; origin: string }) => string | null
  >("export function sandboxOriginFor(");
  const web = { protocol: "http:", origin: "http://127.0.0.1:8888" };
  assert.equal(origin(9001, "", web), "http://127.0.0.1:9001");
  // A LAN visitor reaches it on the address it already reaches Studio on.
  assert.equal(
    origin(9001, "", { protocol: "http:", origin: "http://192.168.1.5:8888" }),
    "http://192.168.1.5:9001",
  );
  // The desktop app's page is tauri://; its backend is plain loopback HTTP.
  assert.equal(
    origin(9001, "http://127.0.0.1:8888", { protocol: "tauri:", origin: "tauri://localhost" }),
    "http://127.0.0.1:9001",
  );
  // Loopback is potentially trustworthy, so a secure page may still frame it.
  assert.equal(
    origin(9001, "http://127.0.0.1:8888", {
      protocol: "https:",
      origin: "https://tauri.localhost",
    }),
    "http://127.0.0.1:9001",
  );
  // A tunnel or a TLS proxy cannot frame a plain-HTTP listener: fall back.
  assert.equal(
    origin(9001, "", { protocol: "https:", origin: "https://studio.example.com" }),
    null,
  );
  // Never the host's own origin, and never a nonsense port.
  assert.equal(origin(8888, "", web), null);
  assert.equal(origin(0, "", web), null);
  assert.equal(origin(70000, "", web), null);
});

test("requested permissions become the SDK's allow attribute", () => {
  const allow = liftFunction<(p: unknown) => string>("export function allowAttribute(");
  assert.equal(allow(undefined), "");
  assert.equal(allow({}), "");
  assert.equal(
    allow({ camera: {}, microphone: {}, geolocation: {}, clipboardWrite: {} }),
    "camera; microphone; geolocation; clipboard-write",
  );
  assert.equal(allow({ clipboardWrite: {}, bogus: {} }), "clipboard-write");
  assert.match(text, /if \(allow\) frame\.setAttribute\("allow", allow\);/);
});

test("only what the page itself holds is passed on, and only behind the proxy", () => {
  // Studio's own Permissions-Policy header turns camera and geolocation off: a
  // grant the page does not hold would be advertised and then refused.
  const start = permissionsCsp.indexOf("const PERMISSION_FEATURES");
  const end = permissionsCsp.indexOf("\n}\n", permissionsCsp.indexOf("export function grantablePermissions("));
  const grantable = new Function(
    `${ts.transpileModule(permissionsCsp.slice(start, end + 3).replace(/export /g, ""), {
      compilerOptions: { target: ts.ScriptTarget.ES2020 },
    }).outputText}; return grantablePermissions;`,
  )() as (requested: unknown, holds: (f: string) => boolean) => Record<string, object>;
  const studioHeader = (feature: string) => !["camera", "geolocation"].includes(feature);
  assert.deepEqual(
    grantable({ camera: {}, microphone: {}, geolocation: {}, clipboardWrite: {} }, studioHeader),
    { microphone: {}, clipboardWrite: {} },
  );
  assert.deepEqual(grantable(undefined, () => true), {});
  assert.deepEqual(grantable({ bogus: {} }, () => true), {});
  assert.match(
    text,
    /sandboxOrigin\s*\?\s*grantablePermissions\(resource\?\.ui\?\.permissions, hostHoldsFeature\)\s*:\s*\{\}/,
  );
});

test("the frame hands the view to the proxy the way the spec lays out", () => {
  // Sandbox: allow-scripts allow-same-origin, on an origin that is not the host's.
  assert.match(
    text,
    /sandboxOrigin \? "allow-scripts allow-same-origin" : "allow-scripts"/,
  );
  // The host waits for sandbox-proxy-ready from ITS frame, on the proxy's origin,
  // once per load, and only then sends sandbox-resource-ready.
  assert.match(text, /if \(event\.origin !== sandboxOrigin\) return;/);
  assert.match(text, /!== SANDBOX_PROXY_READY\)/);
  assert.match(text, /if \(!pendingPostRef\.current\) return;\s*pendingPostRef\.current = false;/);
  // ... addressed to the proxy's origin, never "*", with the host's port attached.
  assert.match(
    text,
    /method: SANDBOX_RESOURCE_READY,[\s\S]*?\},\s*sandboxOrigin,\s*\[channel\.port2\],/,
  );
  // A proxy that never answers is not a dead widget: the opaque shell takes over.
  assert.match(text, /setProxyFailed\(true\)/);
});

test("the host answers what a view may ask, and nothing reaches it early", () => {
  assert.match(caseBody("ping"), /respond\(id, \{\}\)/);
  // Negotiated, not a constant: a supported request is echoed.
  assert.match(
    caseBody("ui/initialize"),
    /SUPPORTED_PROTOCOL_VERSIONS\.includes\(requested\)\s*\?\s*requested\s*:\s*UI_PROTOCOL_VERSION/,
  );
  // Only what is implemented is advertised.
  const init = caseBody("ui/initialize");
  for (const capability of ["openLinks", "serverTools", "logging", "message"]) {
    assert.match(init, new RegExp(`${capability}: `), `${capability} is implemented`);
  }
  assert.match(init, /toolCallId\s*\?\s*\{\s*updateModelContext:/);
  // Display modes: never one the host lacks or the View did not declare (when it
  // declared any), and the resulting mode is always returned.
  const display = caseBody("ui/request-display-mode");
  assert.match(display, /\(HOST_DISPLAY_MODES as readonly string\[\]\)\.includes\(requested\)/);
  assert.match(display, /appModes === null \|\| appModes\.includes\(requested\)/);
  assert.match(display, /: displayModeRef\.current;/);
  assert.match(display, /respond\(id, \{ mode \}\)/);
  assert.match(text, /const HOST_DISPLAY_MODES: readonly DisplayMode\[\] = \["inline", "fullscreen"\];/);
  // Fullscreen lifts the container into the top layer in place, never moving the
  // frame (which would reload it), and every change reaches the View as context.
  assert.match(text, /holder\.setAttribute\("popover", "manual"\);\s*holder\.showPopover\(\);/);
  // Mode changes carry the display mode, dimensions, and the overlay's
  // footprint as insets (the floating chat, the host bar).
  assert.match(
    text,
    /params: \{\s*displayMode,\s*containerDimensions: dimensions,\s*safeAreaInsets: insetsNow\(\),\s*\}/,
  );
  assert.match(text, /bottom: Math\.round\(overlayRef\.current\?\.getBoundingClientRect\(\)\.height \?\? 0\) \+ 16/);
  // Measured when asked, not held in state: a mode change cannot report a stale
  // footprint, and the overlay's growth is told on its own.
  assert.match(text, /const insetsNow = useCallback/);
  assert.match(text, /params: \{ safeAreaInsets: insetsNow\(\) \}/);
  // Host-context updates wait for `initialized`.
  assert.match(
    text,
    /if \(!initializedRef\.current\) return;\s*postToView\(\{\s*jsonrpc: "2\.0",\s*method: "ui\/notifications\/host-context-changed",/,
  );
  // A log notification carries `data`, per MCP logging.
  assert.match(caseBody("notifications/message"), /\?\.data \?\?/);
});

test("teardown is announced before the frame goes, and only to an initialized view", () => {
  const request = text.slice(
    text.indexOf("function requestTeardown("),
    text.indexOf("function retireFrame("),
  );
  assert.match(request, /method: "ui\/resource-teardown",\s*params: \{ reason \}/);
  // Answered on its id, or given up on after the grace -- never waited on forever.
  assert.match(request, /data\.id === id && data\.method === undefined/);
  assert.match(request, /const timer = setTimeout\(finish, timeoutMs\)/);
  // Everything else the view says during its grace still reaches the bridge.
  assert.match(request, /forward\?\.call\(port, event\)/);

  const retire = text.slice(
    text.indexOf("function retireFrame("),
    text.indexOf("export interface McpAppFrameProps"),
  );
  // The re-key retirement parks silently and serves on: sending teardown here
  // was destroying viewers mid-load ("no poll within 8s"). The announcement is
  // requestTeardown's, sent from the navigation blocker while the stream is
  // held (live-apps.ts), never from the retire path.
  assert.match(retire, /function retireFrame\(frame: HTMLIFrameElement, port: MessagePort \| null\): void \{/);
  assert.match(retire, /parkFrame\(frame\);/);
  assert.doesNotMatch(retire, /requestTeardown/);
  // Parked, not permanent: a frame whose successor never came is bounded.
  assert.match(retire, /PARKED_FRAME_LIFETIME_MS/);
  // Every path out -- a reload, the thread switching, the message being edited
  // -- still goes through the cleanup of the effect that made the frame.
  assert.match(text, /retireFrame\(frame, port\);/);
});

test("leaving a conversation tells its widgets first, while they are mounted", () => {
  // A frame React removes is gone before a message can reach it, and only some
  // browsers can move a frame aside without reloading it; the chat page holds the
  // navigation instead.
  const page = readFileSync(
    new URL("../src/features/chat/chat-page.tsx", import.meta.url),
    "utf8",
  );
  const blocker = page.slice(page.indexOf("useBlocker({"), page.indexOf("enableBeforeUnload: false"));
  // Off /chat the page stays mounted, frozen, and so do its widgets.
  assert.match(blocker, /if \(next\.pathname !== "\/chat"\) return false;/);
  assert.match(blocker, /if \(!hasLiveMcpAppsLeaving\(nextThread\)\) return false;/);
  assert.match(
    blocker,
    /return tearDownLiveMcpApps\(\s*nextThread,\s*"The user left this conversation\.",\s*MCP_APP_NAVIGATION_GRACE_MS,\s*\)\.then\(\(\) => \{[\s\S]*clearParkedMcpAppFrames[\s\S]*return false;\s*\}\);/,
  );
  // Leaving really leaves: the parked frames are cleared once the widgets
  // answered, so nothing of the old conversation keeps serving.
  assert.match(text, /export function clearParkedMcpAppFrames\(\): void \{/);
  // Every live widget registers under its conversation, and announces at most
  // once per load.
  assert.match(text, /registerLiveMcpApp\(threadId, async \(reason, timeoutMs\) => \{/);
  assert.match(text, /if \(!port \|\| !initializedRef\.current \|\| announcedRef\.current\) return;\s*announcedRef\.current = true;/);
  // A view that was told and then stays is started over.
  assert.match(text, /setReloadNonce\(\(n\) => n \+ 1\)/);
});

test("a widget's message needs the user's say-so and becomes an ordinary user turn", () => {
  const body = caseBody("ui/message");
  assert.match(body, /setPendingMessage\(\{/);
  assert.match(body, /fail\(id, DECLINED, "Message sending denied"\)/);
  assert.match(body, /aui\.thread\(\)\.append\(\{\s*role: "user",/);
  // Nothing is appended except inside the user's own Send.
  assert.equal((text.match(/aui\.thread\(\)\.append\(/g) ?? []).length, 1);
  assert.ok(body.indexOf("if (!sendIt)") < body.indexOf("aui.thread().append("));
});

test("the live-widget registry tells only the widgets a navigation takes away", async () => {
  const { registerLiveMcpApp, hasLiveMcpAppsLeaving, tearDownLiveMcpApps } = await import(
    "../src/features/chat/mcp-apps/live-apps.ts"
  );
  assert.equal(hasLiveMcpAppsLeaving(undefined), false);
  const told: string[] = [];
  const offA = registerLiveMcpApp("thread-a", async (reason) => {
    await new Promise((r) => setTimeout(r, 20));
    told.push(`a:${reason}`);
  });
  const offB = registerLiveMcpApp("thread-a", async () => {
    throw new Error("a view that failed to answer");
  });
  // Staying on thread-a (a new chat's own ?thread= rewrite): nobody is told.
  assert.equal(hasLiveMcpAppsLeaving("thread-a"), false);
  await tearDownLiveMcpApps("thread-a", "stay", 100);
  assert.deepEqual(told, []);
  // A new chat, or another thread: both widgets are, and one throwing is survived.
  assert.equal(hasLiveMcpAppsLeaving(undefined), true);
  assert.equal(hasLiveMcpAppsLeaving("thread-b"), true);
  await tearDownLiveMcpApps("thread-b", "bye", 100);
  assert.deepEqual(told, ["a:bye"]);
  offA();
  offB();
  assert.equal(hasLiveMcpAppsLeaving("thread-b"), false);
});

test("the user is shown which outside hosts a widget can reach", () => {
  const external = liftFunction<(csp: unknown) => string[]>("export function externalDomains(");
  assert.deepEqual(external(undefined), []);
  assert.deepEqual(
    external({
      connectDomains: ["https://api.example.com", "wss://live.example.com"],
      resourceDomains: ["blob:", "cdn.example.com", "https://api.example.com"],
      frameDomains: ["data:"],
    }),
    ["api.example.com", "live.example.com", "cdn.example.com"],
  );
  assert.match(text, /This app can connect to \{reaches\.join\(", "\)\}/);
});

test("fullscreen floats the thread's own composer over the widget", () => {
  const bar = readFileSync(
    new URL("../src/features/chat/mcp-apps/fullscreen-chat-bar.tsx", import.meta.url),
    "utf8",
  );
  // The same draft and the same send as the chat's composer, not a copy of it.
  assert.match(bar, /useAuiState\(\(\{ thread \}\) => thread\.composer\.text\)/);
  assert.match(bar, /aui\.thread\(\)\.composer\(\)\.setText\(/);
  assert.match(bar, /composer\.send\(\);/);
  // Labels of its own: the chat's composer is still in the page behind it.
  assert.doesNotMatch(bar, /aria-label="Message input"|aria-label="Send message"/);
  assert.match(text, /<FullscreenChatBar \/>/);
  // Typed into locally: bound straight to the composer's async state, keystrokes were lost.
  assert.match(bar, /const \[text, setText\] = useState\(composerText\);/);
  assert.match(bar, /onChange=\{\(event\) => edit\(event\.currentTarget\.value\)\}/);
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const page = (n: number, image = false) => ({
  toolName: "viewer",
  content: [
    { type: "text", text: `page ${n}` },
    ...(image ? [{ type: "image", data: PNG + n, mimeType: "image/png" }] : []),
  ],
});

test("each message carries the last update of its own batch, and nothing when none came", async () => {
  resetMcpAppContextForTests();
  for (let n = 1; n <= 10; n++) setMcpAppModelContext("call-1", page(n));
  await prepareMcpAppContext(["u1"]);
  for (let n = 11; n <= 20; n++) setMcpAppModelContext("call-1", page(n));
  await prepareMcpAppContext(["u1", "u2"]);
  await prepareMcpAppContext(["u1", "u2", "u3"]);

  assert.equal(mcpAppContextSnapshot("u1")?.entries[0].text, "page 10");
  assert.equal(mcpAppContextSnapshot("u2")?.entries[0].text, "page 20");
  assert.equal(mcpAppContextSnapshot("u3"), undefined, "no update since u2: no new payload");
  // Earlier turns never change: preparing again (a regenerate) leaves them be.
  await prepareMcpAppContext(["u1", "u2"]);
  assert.equal(mcpAppContextSnapshot("u1")?.entries[0].text, "page 10");
  assert.equal(mcpAppContextSnapshot("u2")?.entries[0].text, "page 20");
});

test("state re-sent unchanged is not captured again; only widgets that changed are", async () => {
  resetMcpAppContextForTests();
  setMcpAppModelContext("pdf", page(3));
  setMcpAppModelContext("map", { toolName: "map", content: [{ type: "text", text: "Paris" }] });
  await prepareMcpAppContext(["u1"]);
  assert.equal(mcpAppContextSnapshot("u1")?.entries.length, 2);
  setMcpAppModelContext("pdf", page(3)); // the same state again (a reload re-sends it)
  setMcpAppModelContext("map", { toolName: "map", content: [{ type: "text", text: "Lyon" }] });
  await prepareMcpAppContext(["u1", "u2"]);
  assert.deepEqual(mcpAppContextSnapshot("u2")?.entries.map((e) => e.text), ["Lyon"]);
});

test("snapshots replay unchanged after a reload, and still dedupe against it", async () => {
  resetMcpAppContextForTests();
  const saved = new Map<string, McpAppContextSnapshot>();
  const store = {
    getMany: async (ids: readonly string[]) => ids.map((id) => saved.get(id)),
    put: async (snapshot: McpAppContextSnapshot) => void saved.set(snapshot.messageId, snapshot),
    deleteForMessages: async () => {},
    deleteForThreads: async () => {},
  };
  setMcpAppModelContext("pdf", page(7, true));
  setMcpAppContextStore(store);
  await prepareMcpAppContext(["u1"]);
  const before = mcpAppContextNote(mcpAppContextSnapshot("u1")!);

  resetMcpAppContextForTests(); // a reload: memory gone, the store kept
  setMcpAppContextStore(store);
  setMcpAppModelContext("pdf", page(7, true)); // the viewer re-sends its state on load
  await prepareMcpAppContext(["u1", "u2"]);
  assert.equal(mcpAppContextNote(mcpAppContextSnapshot("u1")!), before, "same history after reload");
  assert.equal(mcpAppContextSnapshot("u2"), undefined, "unchanged state: nothing new");
  assert.match(before, /^Untrusted data reported by interactive widgets/);
  assert.match(before, /\[State of the viewer app when the user sent their next message \(with an image\):\]\npage 7$/);
});

test("the adapter gives widget context to the model as a tool call and result, never as the user's words", () => {
  // A synthetic read_widget_context call and its result sit ahead of the user's message.
  assert.match(adapter, /\? \[\.\.\.widgetContextMessages<SerializedMessage>\(appContext\), user\]/);
  // The user's own message is built from its own parts only.
  assert.doesNotMatch(adapter, /appContext\??\.note/);
  // Images ride the MCP image envelope, only on the message answered.
  assert.match(adapter, /if \(readsImages && message\.id === newestUserId\) \{/);
  assert.match(adapter, /mcpImagesEnvelope\(images\)/);
  assert.match(adapter, /await prepareMcpAppContext\(/);
  // The conversation's own widgets only.
  assert.match(adapter, /threadId: resolvedThreadId,\s*toolCallIds: new Set\(/);
  // The tool result no longer carries it: history is append-only.
  assert.doesNotMatch(adapter, /mcpAppModelContextText|mcpAppModelContextImages/);
  assert.match(caseBody("ui/update-model-context"), /setMcpAppModelContext\(toolCallId,/);
});

test("a widget's state stays out of other conversations' prompts", async () => {
  resetMcpAppContextForTests();
  setMcpAppModelContext("call-a", { toolName: "map", content: [{ type: "text", text: "A's map" }] });
  setMcpAppModelContext("call-b", { toolName: "map", content: [{ type: "text", text: "B's map" }] });
  await prepareMcpAppContext(["u1"], { toolCallIds: new Set(["call-b"]) });
  assert.deepEqual(mcpAppContextSnapshot("u1")?.entries.map((e) => e.text), ["B's map"]);
  // With a thread id on both sides it is the thread that decides.
  resetMcpAppContextForTests();
  setMcpAppModelContext("c1", { toolName: "map", threadId: "t1", content: [{ type: "text", text: "one" }] });
  setMcpAppModelContext("c2", { toolName: "map", threadId: "t2", content: [{ type: "text", text: "two" }] });
  await prepareMcpAppContext(["u1"], { threadId: "t2" });
  assert.deepEqual(mcpAppContextSnapshot("u1")?.entries.map((e) => e.text), ["two"]);
  assert.equal(mcpAppContextSnapshot("u1")?.threadId, "t2");
  // Nothing of the conversation's own: nothing captured.
  resetMcpAppContextForTests();
  setMcpAppModelContext("c1", { toolName: "map", content: [{ type: "text", text: "x" }] });
  await prepareMcpAppContext(["u1"], { toolCallIds: new Set() });
  assert.equal(mcpAppContextSnapshot("u1"), undefined);
});

test("content is bounded when stored, per widget, per message and in widgets kept", async () => {
  resetMcpAppContextForTests();
  const big = "x".repeat(MAX_MODEL_CONTEXT_CHARS * 3);
  setMcpAppModelContext("w0", { toolName: "w", content: [{ type: "text", text: big }] });
  setMcpAppModelContext("w1", { toolName: "w", content: [{ type: "text", text: big }] });
  setMcpAppModelContext("w2", { toolName: "w", content: [{ type: "text", text: big }] });
  await prepareMcpAppContext(["u1"]);
  const entries = mcpAppContextSnapshot("u1")!.entries;
  assert.ok(entries.every((e) => e.text.length <= MAX_MODEL_CONTEXT_CHARS + 20));
  assert.ok(entries.reduce((n, e) => n + e.text.length, 0) <= MAX_SNAPSHOT_CHARS);
  resetMcpAppContextForTests();
  for (let i = 0; i < MAX_LIVE_WIDGETS + 10; i++) {
    setMcpAppModelContext(`w${i}`, { toolName: "w", content: [{ type: "text", text: `s${i}` }] });
  }
  await prepareMcpAppContext(["u1"]);
  assert.equal(mcpAppContextSnapshot("u1")!.entries.length, MAX_LIVE_WIDGETS);
});

test("snapshots are deleted with their thread or message, in memory and in the store", async () => {
  resetMcpAppContextForTests();
  const saved = new Map<string, McpAppContextSnapshot>();
  setMcpAppContextStore({
    getMany: async (ids: readonly string[]) => ids.map((id) => saved.get(id)),
    put: async (snapshot: McpAppContextSnapshot) => void saved.set(snapshot.messageId, snapshot),
    deleteForMessages: async (ids: readonly string[]) => ids.forEach((id) => saved.delete(id)),
    deleteForThreads: async (ids: readonly string[]) => {
      for (const [id, snap] of saved) if (snap.threadId && ids.includes(snap.threadId)) saved.delete(id);
    },
  });
  setMcpAppModelContext("c1", { toolName: "w", threadId: "t1", content: [{ type: "text", text: "a" }] });
  await prepareMcpAppContext(["u1"], { threadId: "t1" });
  setMcpAppModelContext("c1", { toolName: "w", threadId: "t1", content: [{ type: "text", text: "b" }] });
  await prepareMcpAppContext(["u1", "u2"], { threadId: "t1" });
  assert.equal(saved.size, 2);
  await pruneMcpAppContextForMessages(["u2"]);
  assert.deepEqual([...saved.keys()], ["u1"]);
  assert.equal(mcpAppContextSnapshot("u2"), undefined);
  await pruneMcpAppContextForThreads(["t1"]);
  assert.equal(saved.size, 0);
  assert.equal(mcpAppContextSnapshot("u1"), undefined);
});

test("partial tool arguments parse as they stream, and stop mattering once whole", async () => {
  const { parsePartialToolArgs } = await import(
    "../src/features/chat/mcp-apps/streaming-args.ts"
  );
  assert.equal(parsePartialToolArgs(undefined), undefined);
  assert.equal(parsePartialToolArgs("not json"), undefined);
  assert.deepEqual(parsePartialToolArgs('{"label": "e2'), { label: "e2" });
  assert.deepEqual(parsePartialToolArgs('{"a": {"b": [1, 2'), { a: { b: [1, 2] } });
  assert.deepEqual(parsePartialToolArgs('{"label": "e2e"}'), { label: "e2e" });
});

test("the widget mounts while the call streams, and is told partials and stops", () => {
  const card = readFileSync(
    new URL("../src/components/assistant-ui/tool-fallback.tsx", import.meta.url),
    "utf8",
  );
  // Provisional: the template comes from the server's ui-tools, the phase from
  // the call's status, and a cancelled call keeps its widget for the notice.
  assert.match(card, /getMcpUiTools\(serverId\)/);
  assert.match(card, /if \(status\.type === "running"\) return "streaming";/);
  assert.match(card, /status\.reason === "cancelled"\) \{\s*return "cancelled";/);
  assert.match(card, /parsePartialToolArgs\(argsText\)/);
  assert.match(card, /Rendered for a cancelled call too/);
  // One frame across the call's life: settling shifts props, not the element,
  // so the widget is not reloaded the moment its result arrives.
  assert.match(card, /One frame across the whole life of the call/);
  assert.match(card, /const phase = settled \? "settled" : mcpAppPhase\(status\);/);

  // The frame: partials only while streaming and never after tool-input; the
  // seed waits for the result; the cancel notice is sent once.
  assert.match(
    text,
    /method: "ui\/notifications\/tool-input-partial",\s*params: \{ arguments: parsed \}/,
  );
  assert.match(text, /if \(!viewReady \|\| phase !== "streaming" \|\| seededRef\.current\) return;/);
  assert.match(text, /if \(!viewReady \|\| phase !== "settled" \|\| seededRef\.current\) return;/);
  assert.match(
    text,
    /method: "ui\/notifications\/tool-cancelled",\s*params: \{ reason: "The user stopped this tool call\." \}/,
  );
});

test("a fallback the user can see when no app origin is available", () => {
  assert.match(text, /stricter isolated mode/);
  assert.match(text, /!fullscreen && !loading && !sandboxOrigin/);
});

test("the widget-context pair is a tool call and result that join the reply before it", () => {
  const context = { callId: widgetContextCallId("msg-1_ab/cd"), result: "Untrusted data...\npage 7" };
  assert.equal(context.callId, "call_widgetctx_msg1abcd");
  const pair = widgetContextMessages(context);
  assert.deepEqual(
    pair.map((m) => m.role),
    ["assistant", "tool"],
  );
  assert.equal(pair[0].tool_calls?.[0].function.name, WIDGET_CONTEXT_TOOL_NAME);
  assert.equal(pair[0].tool_calls?.[0].function.arguments, "{}");
  assert.equal(pair[1].tool_call_id, context.callId);
  const history = [
    { role: "user" as const, content: "show it" },
    { role: "assistant" as const, content: "Here it is." },
    ...pair,
    { role: "user" as const, content: "what page?" },
  ];
  const joined = joinWidgetContextCalls(history);
  // No two assistant turns in a row: the call rides on the reply's own message.
  assert.deepEqual(joined.map((m) => m.role), ["user", "assistant", "tool", "user"]);
  assert.equal(joined[1].content, "Here it is.");
  assert.equal(joined[1].tool_calls?.[0].id, context.callId);
  // After a user turn it stands alone; a real tool call is never rewritten.
  const first = joinWidgetContextCalls([{ role: "user" as const, content: "x" }, ...pair]);
  assert.deepEqual(first.map((m) => m.role), ["user", "assistant", "tool"]);
});

test("the synthetic widget-context call counts as Studio's own tool history", async () => {
  const { studioToolHistoryRequestFields } = await import(
    "../src/features/chat/utils/studio-tool-history.ts"
  );
  assert.deepEqual(studioToolHistoryRequestFields([]), {});
  assert.deepEqual(studioToolHistoryRequestFields([], { hasSyntheticStudioCalls: true }), {
    studio_tool_history: true,
  });
  const foreign = [{ content: [{ type: "tool-call", provenance: { source: "hosted" } }] }];
  assert.deepEqual(studioToolHistoryRequestFields(foreign, { hasSyntheticStudioCalls: true }), {});
});
