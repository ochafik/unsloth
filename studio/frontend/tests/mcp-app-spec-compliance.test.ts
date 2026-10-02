// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

// What MCP Apps (2026-01-26) asks of a host, checked against the frame. The frame
// pulls in React and the runtime store, so its pure helpers are imported from the
// leaf modules, its wiring is asserted in the source (like mcp-app-frame-bridge.test.ts),
// and the SDK's AppBridge is run for real over the host's port transport.
// The behaviour in a real browser is tests/studio/playwright_mcp_app_spec_e2e.py.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

const mcpApps = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../src/features/chat/mcp-apps/${name}`, import.meta.url)),
    "utf8",
  );
const text = mcpApps("mcp-app-frame.tsx");
const frameSource = mcpApps("use-frame-source.ts");
const handshake = mcpApps("bridge-shim.ts");
const bridgeSource = mcpApps("use-app-bridge.ts");
const hostContextSource = mcpApps("use-host-context.ts");
const lifecycle = mcpApps("frame-lifecycle.ts");
const adapter = readFileSync(
  new URL("../src/features/chat/api/chat-adapter.ts", import.meta.url),
  "utf8",
);
const { allowAttribute, externalDomains, grantablePermissions, sandboxOriginFor } =
  await import("../src/features/chat/mcp-apps/permissions-csp.ts");

test("the sandbox proxy is served from another origin of the backend's own host", () => {
  const origin = sandboxOriginFor;
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
  const allow = allowAttribute as (p: unknown) => string;
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
  const grantable = grantablePermissions as (
    requested: unknown,
    holds: (f: string) => boolean,
  ) => Record<string, object>;
  const studioHeader = (feature: string) => !["camera", "geolocation"].includes(feature);
  assert.deepEqual(
    grantable({ camera: {}, microphone: {}, geolocation: {}, clipboardWrite: {} }, studioHeader),
    { microphone: {}, clipboardWrite: {} },
  );
  assert.deepEqual(grantable(undefined, () => true), {});
  assert.deepEqual(grantable({ bogus: {} }, () => true), {});
  assert.match(
    frameSource,
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
  assert.match(handshake, /if \(event\.origin !== sandboxOrigin\) return;/);
  assert.match(handshake, /!==\s*SANDBOX_PROXY_READY_METHOD,?\s*\)/);
  assert.match(
    handshake,
    /if \(!pendingPostRef\.current\) return;[\s\S]*?pendingPostRef\.current = false;\s*const channel = new MessageChannel\(\);/,
  );
  // ... addressed to the proxy's origin, never "*", with the host's port attached.
  assert.match(
    handshake,
    /method: SANDBOX_RESOURCE_READY_METHOD,[\s\S]*?\},\s*sandboxOrigin,\s*\[channel\.port2\],/,
  );
  // A proxy that never answers is not a dead widget: the opaque shell takes over.
  assert.match(text, /source\.markProxyFailed\(\)/);
  assert.match(frameSource, /setProxyFailed\(true\)/);
});

test("the host answers what a view may ask, and nothing reaches it early", async () => {
  // The protocol is the SDK's AppBridge: it is constructed over the view's port, and
  // what it advertises is only what this host implements.
  assert.match(bridgeSource, /new AppBridge\(\s*null,\s*\{ name: HOST_NAME, version: HOST_VERSION \}/);
  const caps = bridgeSource.slice(
    bridgeSource.indexOf("function hostCapabilities("),
    bridgeSource.indexOf("function toCallToolResult("),
  );
  for (const capability of ["openLinks", "serverTools", "serverResources", "logging", "message"]) {
    assert.match(caps, new RegExp(`${capability}: `), `${capability} is implemented`);
  }
  assert.match(caps, /ctx\.toolCallId\s*\?\s*\{\s*updateModelContext:/);
  // The version is the package's, not a hand-stamped constant.
  assert.match(bridgeSource, /HOST_VERSION: string = hostPackage\.version/);
  // Display modes: never one the host lacks or the View did not declare (when it
  // declared any), and the resulting mode is always returned.
  assert.match(bridgeSource, /\(HOST_DISPLAY_MODES as readonly string\[\]\)\.includes\(requested\)/);
  assert.match(bridgeSource, /appModes === null \|\| appModes\.includes\(requested\)/);
  assert.match(bridgeSource, /: ctx\.displayMode\(\);/);
  assert.match(bridgeSource, /return \{ mode \};/);
  assert.match(
    hostContextSource,
    /HOST_DISPLAY_MODES: readonly DisplayMode\[\] = \[\s*"inline",\s*"fullscreen",?\s*\];/,
  );
  // Fullscreen lifts the container into the top layer in place, never moving the
  // frame (which would reload it), and every change reaches the View as context.
  assert.match(
    hostContextSource,
    /holder\.setAttribute\("popover", "manual"\);\s*holder\.showPopover\(\);/,
  );
  // The context carries the display mode, dimensions, and the overlay's footprint as
  // insets (the floating chat, the host bar), measured when asked, not held in state.
  assert.match(
    hostContextSource,
    /displayMode: displayModeRef\.current,[\s\S]*?containerDimensions:\s*containerDimensions\(\)[\s\S]*?safeAreaInsets: insetsNow\(\),/,
  );
  assert.match(hostContextSource, /bottom:\s*Math\.round\(overlayRef\.current\?\.getBoundingClientRect\(\)\.height \?\? 0\) \+\s*16/);
  assert.match(hostContextSource, /const insetsNow = useCallback/);
  // ... and the overlay's growth is told on its own.
  assert.match(hostContextSource, /observer\.observe\(overlay\)/);
  // Host-context updates wait for `initialized`, in the hook and at the bridge.
  assert.match(hostContextSource, /if \(!ready\) return;\s*const request = requestAnimationFrame\(\(\) => push\(hostContext\(\)\)\);/);
  assert.match(bridgeSource, /if \(!session\?\.initialized \|\| session\.parked\) return;\s*void Promise\.resolve\(session\.bridge\.setHostContext\(hostContext\)\)/);
  // A log notification carries `data`, per MCP logging.
  assert.match(bridgeSource, /onloggingmessage = \(\{ level, data \}\)/);

  // What AppBridge does with the port transport, run for real: negotiation echoes a
  // supported version and answers any other with the newest; ping is answered;
  // an unknown request is refused rather than left hanging; nothing is sent before
  // `initialized` (the host only speaks when the bridge is asked to).
  const { AppBridge, SUPPORTED_PROTOCOL_VERSIONS } = await import(
    "@modelcontextprotocol/ext-apps/app-bridge"
  );
  const { PortTransport } = await import("../src/features/chat/mcp-apps/port-transport.ts");
  const channel = new MessageChannel();
  const heights: number[] = [];
  const bridge = new AppBridge(null, { name: "Unsloth", version: "0.0.0" }, { openLinks: {} }, {
    hostContext: { theme: "dark" },
  });
  let initialized = 0;
  bridge.oninitialized = () => void (initialized += 1);
  await bridge.connect(
    new PortTransport(channel.port1, (data) => {
      const h = (data as { mcpAppHeight?: unknown } | null)?.mcpAppHeight;
      if (typeof h !== "number") return false;
      heights.push(h);
      return true;
    }),
  );
  const view = channel.port2;
  const inbox: Record<string, any>[] = [];
  const waiters: (() => void)[] = [];
  view.onmessage = (e) => {
    inbox.push(e.data);
    waiters.splice(0).forEach((w) => w());
  };
  const next = async (match: (m: Record<string, any>) => boolean) => {
    for (;;) {
      const found = inbox.find(match);
      if (found) return found;
      await new Promise<void>((r) => waiters.push(r));
    }
  };
  const ask = async (id: number, method: string, params: unknown) => {
    view.postMessage({ jsonrpc: "2.0", id, method, params });
    return next((m) => m.id === id);
  };
  const newest = SUPPORTED_PROTOCOL_VERSIONS[0];
  const init = await ask(1, "ui/initialize", {
    protocolVersion: newest,
    appInfo: { name: "view", version: "1" },
    appCapabilities: {},
  });
  assert.equal(init.result.protocolVersion, newest);
  assert.deepEqual(init.result.hostCapabilities, { openLinks: {} });
  assert.deepEqual(init.result.hostContext, { theme: "dark" });
  assert.equal(init.result.hostInfo.name, "Unsloth");
  const odd = await ask(2, "ui/initialize", {
    protocolVersion: "1999-01-01",
    appInfo: { name: "view", version: "1" },
    appCapabilities: {},
  });
  assert.equal(odd.result.protocolVersion, newest);
  assert.deepEqual((await ask(3, "ping", {})).result, {});
  assert.equal((await ask(4, "no/such-method", {})).error.code, -32601);
  // The height fallback is not the protocol: it never reaches the bridge.
  view.postMessage({ mcpAppHeight: 321 });
  view.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
  await ask(5, "ping", {});
  assert.deepEqual(heights, [321]);
  assert.equal(initialized, 1);
  assert.equal(inbox.filter((m) => m.method).length, 0, "the host sent nothing unasked");
  await bridge.close();
  view.close();
});

test("teardown is announced before the frame goes, and only to an initialized view", () => {
  const request = lifecycle.slice(
    lifecycle.indexOf("export async function requestTeardown("),
    lifecycle.indexOf("/** Retire one loaded frame."),
  );
  // The spec's ui/resource-teardown, through AppBridge, carrying the reason.
  assert.match(request, /bridge\.teardownResource\(\{ reason \}, \{ timeout: timeoutMs \}\)/);
  // Answered, or given up on after the grace -- never waited on forever.
  assert.match(request, /catch \{/);

  const retire = lifecycle.slice(lifecycle.indexOf("export function retireFrame("));
  // The re-key retirement parks silently and serves on: sending teardown here
  // was destroying viewers mid-load ("no poll within 8s"). The announcement is
  // requestTeardown's, sent from the navigation blocker while the stream is
  // held (live-apps.ts), never from the retire path.
  assert.match(retire, /session: ParkableSession \| null,\s*\): void \{/);
  assert.match(retire, /parkFrame\(frame\)/);
  assert.doesNotMatch(retire, /requestTeardown/);
  // Where the frame cannot be parked, nothing keeps it: the bridge goes with it.
  assert.match(retire, /if \(!parkFrame\(frame\)\) \{\s*session\.close\(\);\s*frame\.remove\(\);\s*return;\s*\}/);
  // A parked frame has no one to ask; and it is bounded -- one whose successor
  // never came does not serve forever.
  assert.match(retire, /session\.park\(\);/);
  assert.match(retire, /PARKED_FRAME_LIFETIME_MS/);
  // Every path out -- a reload, the thread switching, the message being edited
  // -- still goes through the cleanup of the effect that made the frame.
  assert.match(text, /retireFrame\(frame, detach\(\)\);/);
});

test("a parked frame's bridge refuses what needs the user, and leaves model context alone", () => {
  assert.match(bridgeSource, /park\(\) \{\s*session\.parked = true;/);
  // tools/call needing approval, ui/message, ui/open-link: refused, never queued.
  assert.match(bridgeSource, /if \(session\.parked\) return declinedResult\(NOT_ON_SCREEN\);/);
  assert.match(bridgeSource, /if \(session\.parked\) throw new ProtocolError\(DECLINED, NOT_ON_SCREEN\);\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*const asked = getContext\(\)\.prompts\.askMessage/);
  assert.match(bridgeSource, /if \(session\.parked \|\| linkRequests\.length >= MAX_LINKS_PER_WINDOW\) \{\s*return \{ isError: true \};/);
  const update = bridgeSource.slice(bridgeSource.indexOf("bridge.onupdatemodelcontext"));
  assert.ok(
    update.indexOf("if (session.parked) throw") < update.indexOf("setMcpAppModelContext("),
    "a parked view must not update model context",
  );
});

test("a retiring frame clears its model context, scoped to the thread it was set in", () => {
  assert.match(bridgeSource, /retire\(\) \{[^}]*clearMcpAppModelContext\(toolCallId\)/s);
  assert.match(bridgeSource, /setMcpAppModelContext\(ctx\.toolCallId, \{\s*toolName: ctx\.toolName,\s*\.\.\.\(ctx\.threadId \? \{ threadId: ctx\.threadId \} : \{\}\)/);
  const retire = lifecycle.slice(lifecycle.indexOf("export function retireFrame("));
  assert.ok(
    retire.indexOf("session.retire?.()") !== -1 &&
      retire.indexOf("session.retire?.()") < retire.indexOf("parkFrame(frame)"),
    "context is cleared before the frame is parked, whichever way it goes",
  );
});

test("a widget's link is shown to the user and rate limited", () => {
  const open = bridgeSource.slice(
    bridgeSource.indexOf("bridge.onopenlink"),
    bridgeSource.indexOf("bridge.onrequestdisplaymode"),
  );
  // http(s) only, then the rate limit, then the user's confirmation of the URL itself.
  assert.match(open, /if \(!isHttpUrl\(url\)\) return \{ isError: true \};/);
  assert.ok(open.indexOf("MAX_LINKS_PER_WINDOW") < open.indexOf("askLink(url)"));
  assert.ok(open.indexOf("askLink(url)") < open.indexOf("openLink(url)"));
  assert.match(open, /if \(!asked \|\| !\(await asked\)\) return \{ isError: true \};\s*openLink\(url\);/);
  assert.equal((bridgeSource.match(/openLink\(/g) ?? []).length, 1);
  const prompts = mcpApps("pending-prompts.tsx");
  assert.match(prompts, /aria-label="Link from this app"/);
  assert.match(prompts, /\{link\.text\}/);
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
  assert.match(lifecycle, /export function clearParkedMcpAppFrames\(\): void \{/);
  // Every live widget registers under its conversation, and announces at most
  // once per load.
  assert.match(text, /registerLiveMcpApp\(\s*threadId,\s*async \(reason, timeoutMs\) => \{/);
  assert.match(text, /if \(!session \|\| !session\.initialized \|\| announcedRef\.current\) return;\s*announcedRef\.current = true;/);
  // A view that was told and then stays is started over.
  assert.match(text, /setReloadNonce\(\(n\) => n \+ 1\)/);
});

test("a widget's message needs the user's say-so and becomes an ordinary user turn", () => {
  const body = bridgeSource.slice(
    bridgeSource.indexOf("bridge.onmessage"),
    bridgeSource.indexOf("if (first.toolCallId)"),
  );
  assert.match(body, /prompts\.askMessage\(text\)/);
  // Declined: an error the view's promise rejects with, not a sent message.
  assert.match(body, /if \(!\(await asked\)\) \{\s*throw new ProtocolError\(DECLINED, "Message sending denied"\);/);
  assert.match(text, /aui\.thread\(\)\.append\(\{\s*role: "user",/);
  // Nothing is appended except on behalf of the user's own Send.
  const sources = ["mcp-app-frame.tsx", "use-app-bridge.ts", "pending-prompts.tsx"].map(mcpApps);
  assert.equal(sources.join("\n").match(/thread\(\)\.append\(/g)?.length, 1);
  assert.ok(body.indexOf("if (!(await asked))") < body.indexOf("sendUserMessage(text)"));
  // Only text is a chat turn; the role is the user's.
  assert.match(body, /Only text messages can be sent/);
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
  const external = externalDomains as (csp: unknown) => string[];
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
  assert.match(bridgeSource, /setMcpAppModelContext\(ctx\.toolCallId,/);
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
  assert.match(bridgeSource, /sendToolInputPartial\(\{ arguments: parsed \}\)/);
  assert.match(bridgeSource, /if \(!ready \|\| !session \|\| phase !== "streaming" \|\| session\.seeded\) return;/);
  assert.match(bridgeSource, /if \(!ready \|\| !session \|\| phase !== "settled" \|\| session\.seeded\) return;/);
  // tool-input precedes tool-result.
  assert.match(bridgeSource, /await bridge\.sendToolInput\(\{ arguments: toolArgs \?\? \{\} \}\);\s*await bridge\.sendToolResult\(/);
  assert.match(
    bridgeSource,
    /sendToolCancelled\(\{ reason: "The user stopped this tool call\." \}\)/,
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
