// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"use client";

import { Button } from "@/components/ui/button";
import { useTheme } from "@/features/settings/stores/theme-store";
import { apiUrl, getApiBase, isTauri } from "@/lib/api-base";
import { mcpBareToolName } from "../utils/mcp-tool-name";
import { openLink } from "@/lib/open-link";
import { cn } from "@/lib/utils";
import { useAui } from "@assistant-ui/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  McpUiApprovalRequired,
  callMcpUiTool,
  getMcpAppSandboxPort,
  readMcpUiResource,
  type McpUiResource,
  type McpUiToolCallResult,
} from "../api/mcp-servers-api";
import {
  RESIZE_FALLBACK,
  bridgeShim,
  cspFrameQuery,
  newBridgeToken,
  toolApprovalScope,
  withBridgeShim,
  type McpUiEnvelope,
} from "./mcp-ui";
import {
  allowAttribute,
  externalDomains,
  grantablePermissions,
  hostHoldsFeature,
  sandboxOriginFor,
} from "./permissions-csp";
import { useChatRuntimeStore } from "../stores/chat-runtime-store";
import { FullscreenChatBar } from "./fullscreen-chat-bar";
import { registerLiveMcpApp } from "./live-apps";
import { parsePartialToolArgs } from "./streaming-args";
import { setMcpAppModelContext } from "./model-context";
import {
  MCP_APP_TOOL_DECLINED,
  mcpAppArgsPreview,
  mcpAppToolKey,
} from "./tool-approval";

// A widget cannot stack prompts faster than they can be read.
const MAX_PENDING_TOOL_CALLS = 8;

// A widget's tool call parked until the user answers it.
interface PendingToolCall {
  key: number;
  name: string;
  args: Record<string, unknown>;
  decide: (allow: boolean) => void;
}

// A widget's ui/message, parked until the user says it may go into the chat.
interface PendingMessage {
  text: string;
  decide: (send: boolean) => void;
}

// The versions this bridge speaks, newest first. A view that asks for one of these
// gets it back; any other request is answered with the newest, as MCP negotiates.
const SUPPORTED_PROTOCOL_VERSIONS = ["2026-01-26"];
const UI_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
const HOST_NAME = "Unsloth";
// No build-stamped version here, so this tracks the bridge itself.
const HOST_VERSION = "1.1.0";

const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 120;
// Past this a widget scrolls rather than pushing the conversation off screen.
const MAX_HEIGHT = 900;

// The sandbox proxy has this long to say it is ready before the frame falls back
// to the opaque-origin shell (a port the browser cannot reach, say).
const PROXY_READY_TIMEOUT_MS = 10_000;
// How long a widget being torn down may take to answer ui/resource-teardown.
const TEARDOWN_GRACE_MS = 3_000;
// How long a parked frame keeps serving after its card re-keyed. The successor
// card intermittently does not re-mount, and the parked document is then the
// only thing still polling its server and rendering pages; killing it at once
// is how a viewer ends up on screen but dead to its server. The cap exists so
// a parked frame cannot poll a deleted server forever.
const PARKED_FRAME_LIFETIME_MS = 60_000;

// The standard JSON-RPC codes, plus the implementation-defined -32000 the spec
// uses for a request the host or the user declined.
const INVALID_PARAMS = -32602;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;
const DECLINED = -32000;

// What the host can show a View as. Fullscreen lifts the widget's own container
// into the top layer (a popover) in place: moving the iframe anywhere would reload it.
type DisplayMode = "inline" | "fullscreen";
/** Where the tool call this widget draws stands: arguments still streaming, its
 *  result arrived, or the call was stopped before it produced one. */
export type McpAppPhase = "streaming" | "settled" | "cancelled";
const HOST_DISPLAY_MODES: readonly DisplayMode[] = ["inline", "fullscreen"];
// The host's own bar above a fullscreen View, with the way back out.
const FULLSCREEN_BAR_PX = 40;

const SANDBOX_PROXY_READY = "ui/notifications/sandbox-proxy-ready";
// The view answers tools/list from its own registration; a call gets the SDK's
// request budget, and both are bounded so a stuck view cannot pin the frame.
const SANDBOX_RESOURCE_READY = "ui/notifications/sandbox-resource-ready";

type JsonRpcId = string | number;

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

function isJsonRpc(data: unknown): data is JsonRpcMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { jsonrpc?: unknown }).jsonrpc === "2.0"
  );
}

// Frames being torn down wait here for the view's answer, out of the layout and
// out of React's tree, so they outlive the component that drew them.
let parkingLot: HTMLDivElement | null = null;

function parkFrame(frame: HTMLIFrameElement): boolean {
  const move = (
    document.body as HTMLElement & {
      moveBefore?: (node: Node, child: Node | null) => void;
    }
  ).moveBefore;
  if (typeof move !== "function" || !frame.isConnected) return false;
  if (!parkingLot || !parkingLot.isConnected) {
    parkingLot = document.createElement("div");
    parkingLot.setAttribute("aria-hidden", "true");
    parkingLot.inert = true;
    // Behind the app rather than off it: Chromium suspends rendering for
    // offscreen or zero-area frames, and a parked PDF viewer must still be
    // able to render a page for the model's get_screenshot -- its long-poll
    // and text extraction survive parking either way, the render loop does
    // not. Onscreen and sized, under the app's opaque background, nothing is
    // visible and nothing is clickable, but the frame keeps painting.
    parkingLot.setAttribute("data-mcp-app-parking-lot", "true");
    parkingLot.style.cssText =
      "position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden;";
    document.body.appendChild(parkingLot);
  }
  const { width, height } = frame.getBoundingClientRect();
  try {
    // A state-preserving move: a plain remove and insert would reload the frame.
    move.call(parkingLot, frame, null);
  } catch {
    return false;
  }
  frame.style.width = `${Math.max(width, 1)}px`;
  frame.style.height = `${Math.max(height, 1)}px`;
  return true;
}

/** Remove every parked frame: called when the user truly leaves, after the
 *  announced teardown was answered (chat-page blocker). Re-key parks are NOT
 *  cleared -- the parked document is there precisely to keep serving. */
export function clearParkedMcpAppFrames(): void {
  if (!parkingLot || !parkingLot.isConnected) return;
  for (const frame of [...parkingLot.children]) {
    frame.remove();
  }
}

let teardownSeq = 0;

/** Send ui/resource-teardown down `port`; resolves on the View's answer, or after
 *  `timeoutMs`. Everything else the View says meanwhile -- a last tool call, a final
 *  model-context update -- still reaches the bridge, which answers on this port. */
function requestTeardown(
  port: MessagePort,
  reason: string,
  timeoutMs: number,
): Promise<void> {
  teardownSeq += 1;
  const id = `unsloth-teardown-${teardownSeq}`;
  return new Promise((resolve) => {
    const forward = port.onmessage;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      port.onmessage = forward;
      resolve();
    };
    port.onmessage = (event: MessageEvent) => {
      const data = event.data as { id?: unknown; method?: unknown } | null;
      if (data && data.id === id && data.method === undefined) {
        finish();
        return;
      }
      forward?.call(port, event);
    };
    port.postMessage({
      jsonrpc: "2.0",
      id,
      method: "ui/resource-teardown",
      params: { reason },
    });
    const timer = setTimeout(finish, timeoutMs);
  });
}

/** Retire one loaded frame: ui/resource-teardown first, then the frame.
 *
 * The spec: the host MUST send this before tearing the resource down, and SHOULD
 * wait for the answer so the view can save what it holds. Leaving a conversation
 * announces it earlier, from the chat page, while the frame is still mounted (see
 * live-apps.ts); here the frame is kept alive for the answer, moved aside
 * where its render loop keeps running, and removed on the answer or after a
 * short grace.
 */
function retireFrame(frame: HTMLIFrameElement, port: MessagePort | null): void {
  // Nothing to keep without a port.
  if (!port) {
    frame.remove();
    return;
  }
  // Parked, silently. The card re-keys as the model's turn settles and this
  // frame's successor intermittently does not re-mount, so the parked document
  // is often the only one still answering its server -- tearing it down here
  // (or removing it) is exactly how a viewer ends up on screen yet "never
  // connected": its PDF fetch is cancelled mid-load and its poll never starts.
  // The real teardown, announced and waited for, happens before a conversation
  // switch (live-apps.ts); a card re-key is a host implementation detail the
  // app is never told about.
  parkFrame(frame);
  setTimeout(() => {
    if (frame.isConnected && frame.closest("[data-mcp-app-parking-lot]")) {
      port.close();
      frame.remove();
    }
  }, PARKED_FRAME_LIFETIME_MS);
}

export interface McpAppFrameProps {
  /** Every call the widget makes is scoped to this server. */
  serverId: string;
  toolName: string;
  ui: McpUiEnvelope;
  /** The tool call this widget draws; keys what it tells the model about itself. */
  toolCallId?: string;
  /** "streaming" mounts the widget while the model is still writing the call's
   *  arguments (tool-input-partial); "cancelled" tells it the call was stopped. */
  phase?: McpAppPhase;
  /** What the model had written when a streaming call was stopped, for the partial. */
  argsText?: string;
  /** The arguments the model called the tool with. */
  toolArgs?: Record<string, unknown>;
  /** Images the tool returned, replayed alongside that text. */
  resultImages?: { data: string; mimeType: string }[];
  /** Scopes stdio sessions to the conversation's own server process. */
  threadId?: string;
  sessionId?: string;
  className?: string;
}

export function McpAppFrame({
  serverId,
  toolName,
  ui,
  toolCallId,
  phase = "settled",
  argsText,
  toolArgs,
  resultImages,
  threadId,
  sessionId,
  className,
}: McpAppFrameProps) {
  const aui = useAui();
  const holderRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const { resolved: theme } = useTheme();
  const [resource, setResource] = useState<McpUiResource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [pendingCalls, setPendingCalls] = useState<PendingToolCall[]>([]);
  const [pendingMessage, setPendingMessage] = useState<PendingMessage | null>(
    null,
  );
  const pendingMessageRef = useRef(pendingMessage);
  pendingMessageRef.current = pendingMessage;
  const pendingKeyRef = useRef(0);
  const pendingCallsRef = useRef(pendingCalls);
  pendingCallsRef.current = pendingCalls;
  const allowToolAlways = useChatRuntimeStore((s) => s.allowToolAlways);
  const approvalScope = toolApprovalScope(sessionId, threadId);

  const { resourceUri } = ui;

  useEffect(() => {
    let cancelled = false;
    setResource(null);
    setError(null);
    readMcpUiResource(serverId, resourceUri, { threadId, sessionId })
      .then((loaded) => {
        if (!cancelled) setResource(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, resourceUri, threadId, sessionId]);

  // The server's sandbox origin: undefined while asking, null for the fallback.
  const [sandboxPort, setSandboxPort] = useState<number | null | undefined>(
    undefined,
  );
  // Set when the proxy never answered; the frame then uses the opaque shell.
  const [proxyFailed, setProxyFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setSandboxPort(undefined);
    setProxyFailed(false);
    getMcpAppSandboxPort(serverId)
      .then((port) => {
        if (!cancelled) setSandboxPort(port);
      })
      .catch(() => {
        if (!cancelled) setSandboxPort(null);
      });
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  const sandboxOrigin = useMemo(
    () =>
      typeof sandboxPort === "number" && !proxyFailed
        ? sandboxOriginFor(sandboxPort, getApiBase(), window.location)
        : null,
    [sandboxPort, proxyFailed],
  );

  // Only what the template asked for AND this page holds, and only behind the
  // proxy: an opaque origin cannot hold a Permission Policy grant worth making.
  const permissions = useMemo(
    () =>
      sandboxOrigin
        ? grantablePermissions(resource?.ui?.permissions, hostHoldsFeature)
        : {},
    [resource, sandboxOrigin],
  );
  const allow = allowAttribute(permissions);

  // The CSP is fixed at request time, so declared domains ride the URL.
  const src = useMemo(() => {
    if (!resource || sandboxPort === undefined) return null;
    const query = new URLSearchParams(cspFrameQuery(resource.ui?.csp));
    if (sandboxOrigin) query.set("host", window.location.origin);
    // Never put the auth token in the URL: in-frame code reads location.href.
    if (sandboxOrigin) return `${sandboxOrigin}/?${query.toString()}`;
    return apiUrl(
      `/api/inference/mcp-app-frame${query.size ? `?${query.toString()}` : ""}`,
    );
  }, [resource, sandboxPort, sandboxOrigin]);

  // One token per fetched template, so re-seeding cannot be replayed either.
  const bridgeToken = useMemo(
    () => (resource ? newBridgeToken() : null),
    [resource],
  );

  const html = useMemo(
    () =>
      resource && bridgeToken
        ? withBridgeShim(
            `${resource.text}\n${RESIZE_FALLBACK}`,
            bridgeShim(bridgeToken, window.location.origin),
          )
        : null,
    [resource, bridgeToken],
  );

  // Only a parent-initiated load is fed, so a self-navigated frame can't ask to
  // be re-seeded.
  const pendingPostRef = useRef(false);
  // Once the view reports its own size the measured fallback is ignored for
  // good, or it would drag a self-sized widget back on every content change.
  const viewOwnsSizeRef = useRef(false);
  // The view is ready for host-context updates only after it says `initialized`.
  const initializedRef = useRef(false);
  // The seeded document's own reply channel: handed over by the shim in the
  // opaque fallback, or created here and handed to the sandbox proxy.
  const viewPortRef = useRef<MessagePort | null>(null);
  // Width the view was last told about, so a resize is reported once.
  const reportedWidthRef = useRef(0);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("inline");
  const displayModeRef = useRef(displayMode);
  displayModeRef.current = displayMode;
  // The modes the View said it supports in ui/initialize, when it said.
  const appModesRef = useRef<string[] | null>(null);
  // `initialized` as state, so the seed/partial effects below can follow it.
  const [viewReady, setViewReady] = useState(false);
  // The seed (tool-input + tool-result) goes once, when there is a result.
  const seededRef = useRef(false);
  // The last partial sent, so re-renders do not repeat it.
  const lastPartialRef = useRef("");
  // Whether this load already told the view its call was cancelled.
  const cancelledToldRef = useRef(false);
  // The mode the View was last told about.
  const reportedModeRef = useRef<DisplayMode>("inline");
  // The fullscreen overlay (chat bar, prompts), so its size can be reported to
  // the View as insets it should lay out around.
  const overlayRef = useRef<HTMLDivElement | null>(null);
  // Set when the chat announced this load's teardown ahead of a navigation.
  const announcedRef = useRef(false);
  // Bumped to load the widget afresh: a view told it is going away that then
  // stays (a navigation that did not happen) has to start over.
  const [reloadNonce, setReloadNonce] = useState(0);
  // Set by the first cleanup to run on unmount, before the frame's own.
  const unmountingRef = useRef(false);
  useLayoutEffect(() => {
    unmountingRef.current = false;
    return () => {
      unmountingRef.current = true;
    };
  }, []);

  // Listed while mounted, so the chat can announce teardown before a navigation
  // takes this widget away (live-apps.ts).
  useEffect(() => {
    let recheck: ReturnType<typeof setTimeout> | undefined;
    const unregister = registerLiveMcpApp(threadId, async (reason, timeoutMs) => {
      const port = viewPortRef.current;
      if (!port || !initializedRef.current || announcedRef.current) return;
      announcedRef.current = true;
      await requestTeardown(port, reason, timeoutMs);
      // Still here once the navigation has had its turn: start the view over.
      recheck = setTimeout(() => {
        if (!unmountingRef.current && announcedRef.current) {
          setReloadNonce((n) => n + 1);
        }
      }, 1_000);
    });
    return () => {
      clearTimeout(recheck);
      unregister();
    };
  }, [threadId]);

  // Layout, not passive: this arms the state the load handshake reads, and the
  // iframe starts fetching the moment it is attached. A passive effect is queued
  // during that same commit and so normally wins, but the two are different task
  // sources and nothing orders them; losing once means the handshake is declined
  // and the widget sits on the empty shell for good, with nothing to retry it. A
  // layout effect runs inside the commit, before the browser can dispatch anything.
  //
  // The frame is made here rather than rendered, so that it can outlive this
  // component long enough to be told it is being torn down (see retireFrame).
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadNonce is a trigger, not an input -- bumping it loads the widget afresh
  useLayoutEffect(() => {
    const holder = holderRef.current;
    if (!src || !html || !holder) return;
    pendingPostRef.current = true;
    viewOwnsSizeRef.current = false;
    initializedRef.current = false;
    announcedRef.current = false;
    reportedWidthRef.current = 0;
    appModesRef.current = null;
    reportedModeRef.current = "inline";
    setDisplayMode("inline");
    setViewReady(false);
    seededRef.current = false;
    lastPartialRef.current = "";
    cancelledToldRef.current = false;
    viewPortRef.current = null;
    setHeight(DEFAULT_HEIGHT);

    const frame = document.createElement("iframe");
    // Behind the proxy: the spec's allow-scripts allow-same-origin, on an origin
    // that is not this app's. In the fallback: no allow-same-origin, so the widget
    // reaches neither this app's storage nor its cookies. No allow-downloads, as
    // with the HTML canvas.
    frame.setAttribute(
      "sandbox",
      sandboxOrigin ? "allow-scripts allow-same-origin" : "allow-scripts",
    );
    if (allow) frame.setAttribute("allow", allow);
    frame.referrerPolicy = "no-referrer";
    frame.title = `${toolName} app`;
    frame.className = "block h-full w-full border-0 bg-transparent";
    // The opaque shell has no handshake of its own: it is fed the template once
    // it loads, and the shim in that template then hands over its port. Only a
    // parent-initiated load is fed, so a self-navigated frame can't be re-seeded.
    const onLoad = () => {
      if (sandboxOrigin || !pendingPostRef.current) return;
      if (iframeRef.current !== frame) return;
      pendingPostRef.current = false;
      // Opaque origin, so a wildcard target is required; it still only reaches
      // this iframe's contentWindow. It carries the template the host just
      // fetched and nothing about the conversation.
      frame.contentWindow?.postMessage({ type: "unsloth:artifact-html", html }, "*");
    };
    frame.addEventListener("load", onLoad);
    frame.src = src;
    holder.appendChild(frame);
    iframeRef.current = frame;

      const proxyTimer = sandboxOrigin
      ? window.setTimeout(() => {
          if (pendingPostRef.current && iframeRef.current === frame) {
            setProxyFailed(true);
          }
        }, PROXY_READY_TIMEOUT_MS)
      : undefined;

    return () => {
      window.clearTimeout(proxyTimer);
      frame.removeEventListener("load", onLoad);
      if (iframeRef.current === frame) iframeRef.current = null;
      const port = viewPortRef.current;
      viewPortRef.current = null;
      const initialized = initializedRef.current;
      pendingPostRef.current = false;
      retireFrame(frame, port);
    };
  }, [src, html, sandboxOrigin, allow, toolName, reloadNonce]);

  // Down the seeded document's own channel, never the frame's contentWindow: the
  // window survives a navigation and would hand an in-flight tool result or
  // resource body to whatever page the frame moved to. A port cannot outlive the
  // document that made it, so there is nowhere for a reply to leak to.
  const postToView = useCallback((message: unknown) => {
    viewPortRef.current?.postMessage(message);
  }, []);

  const seedView = useCallback(() => {
    // Nothing may be sent before `initialized`, and tool-input precedes result.
    postToView({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input",
      params: { arguments: toolArgs ?? {} },
    });
    // The server's own blocks, in order, with the image bytes put back: the
    // envelope leaves those to the image sentinel rather than carrying a second
    // copy, so an image block arrives with its mimeType and no data. Anything
    // the flattened body would have shown instead is host prose -- an
    // "[1 image returned]" note, or a Python repr of structuredContent --
    // and no part of what the server returned.
    const images = [...(resultImages ?? [])];
    const content: Record<string, unknown>[] = [];
    for (const block of ui.content ?? []) {
      if (block?.type === "image" && block.data === undefined) {
        const image = images.shift();
        // Dropped by the payload budget upstream; the card says so too.
        if (!image) continue;
        content.push({ ...block, data: image.data, mimeType: image.mimeType });
        continue;
      }
      content.push({ ...block });
    }
    postToView({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: {
        content,
        ...(ui.structuredContent !== undefined
          ? { structuredContent: ui.structuredContent }
          : {}),
        ...(ui._meta ? { _meta: ui._meta } : {}),
      },
    });
  }, [
    postToView,
    toolArgs,
    resultImages,
    ui.content,
    ui.structuredContent,
    ui._meta,
  ]);

  // The seed: tool-input then tool-result, once the call has a result. A widget
  // mounted mid-stream gets neither until its call settles (the spec forbids
  // tool-result before tool-input, and tool-input only "when arguments become
  // available" -- complete ones).
  useEffect(() => {
    if (!viewReady || phase !== "settled" || seededRef.current) return;
    seededRef.current = true;
    seedView();
  }, [viewReady, phase, seedView]);

  // ui/notifications/tool-input-partial: best-effort arguments while the model is
  // still writing them. Stopped the moment tool-input is sent (phase leaves
  // "streaming"), and never repeated for the same parse.
  useEffect(() => {
    if (!viewReady || phase !== "streaming" || seededRef.current) return;
    const parsed = parsePartialToolArgs(argsText) ?? toolArgs;
    if (!parsed || typeof parsed !== "object") return;
    const asText = JSON.stringify(parsed);
    if (asText === lastPartialRef.current) return;
    lastPartialRef.current = asText;
    postToView({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input-partial",
      params: { arguments: parsed },
    });
  }, [viewReady, phase, argsText, toolArgs, postToView]);

  // ui/notifications/tool-cancelled: the call was stopped before it produced a
  // result, so the widget it drew will never be seeded.
  useEffect(() => {
    if (!viewReady || phase !== "cancelled" || cancelledToldRef.current) return;
    cancelledToldRef.current = true;
    postToView({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-cancelled",
      params: { reason: "The user stopped this tool call." },
    });
  }, [viewReady, phase, postToView]);

  const containerWidth = useCallback(
    () => Math.round(holderRef.current?.getBoundingClientRect().width ?? 0),
    [],
  );

  // Inline, the width is fixed and the height follows the View up to a cap;
  // fullscreen, both are fixed to what the frame is given.
  const containerDimensions = useCallback(() => {
    if (displayModeRef.current === "fullscreen") {
      const box = iframeRef.current?.getBoundingClientRect();
      return {
        width: Math.round(box?.width ?? window.innerWidth),
        height: Math.round(box?.height ?? window.innerHeight),
      };
    }
    const width = containerWidth();
    return width > 0 ? { width, maxHeight: MAX_HEIGHT } : { maxHeight: MAX_HEIGHT };
  }, [containerWidth]);

  // Theme flips reach a live widget as a partial host-context update.
  useEffect(() => {
    if (!initializedRef.current) return;
    postToView({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { theme },
    });
  }, [theme, postToView]);

  // So does the width the widget is laid out in: a window resize, a sidebar.
  useEffect(() => {
    const holder = holderRef.current;
    if (!holder || typeof ResizeObserver === "undefined") return;
    let frameRequest = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frameRequest);
      frameRequest = requestAnimationFrame(() => {
        const width = containerWidth();
        if (!initializedRef.current || width <= 0) return;
        // A mode change reports its own dimensions (below).
        if (reportedModeRef.current !== displayModeRef.current) return;
        if (width === reportedWidthRef.current) return;
        reportedWidthRef.current = width;
        postToView({
          jsonrpc: "2.0",
          method: "ui/notifications/host-context-changed",
          params: { containerDimensions: containerDimensions() },
        });
      });
    });
    observer.observe(holder);
    return () => {
      cancelAnimationFrame(frameRequest);
      observer.disconnect();
    };
  }, [containerWidth, containerDimensions, postToView]);

  // Fullscreen: the container goes into the top layer where it is, above every
  // stacking context and transformed ancestor, without the iframe moving. Where the
  // browser has no popovers, fixed positioning does most of the same.
  useLayoutEffect(() => {
    const holder = holderRef.current;
    if (!holder || displayMode !== "fullscreen") return;
    const topLayer = typeof holder.showPopover === "function";
    if (topLayer) {
      holder.setAttribute("popover", "manual");
      holder.showPopover();
    }
    iframeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDisplayMode("inline");
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (topLayer) {
        if (holder.matches(":popover-open")) holder.hidePopover();
        holder.removeAttribute("popover");
      }
    };
  }, [displayMode]);

  // The overlay's footprint, as insets: the host bar above, the floating chat
  // below. Measured when asked, not held in state, so a mode change always
  // reports the sizes as they are at that moment (the spec's safeAreaInsets).
  const insetsNow = useCallback((): {
    top: number;
    right: number;
    bottom: number;
    left: number;
  } => {
    if (displayMode !== "fullscreen") {
      return { top: 0, right: 0, bottom: 0, left: 0 };
    }
    return {
      top: FULLSCREEN_BAR_PX,
      right: 0,
      bottom: Math.round(overlayRef.current?.getBoundingClientRect().height ?? 0) + 16,
      left: 0,
    };
  }, [displayMode]);
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay || displayMode !== "fullscreen" || typeof ResizeObserver === "undefined") {
      return;
    }
    let last = insetsNow().bottom;
    const observer = new ResizeObserver(() => {
      const bottom = insetsNow().bottom;
      if (bottom === last) return;
      last = bottom;
      // The overlay grew or shrank (a reply opened, a prompt answered): the
      // View hears about the insets alone, mode and dimensions unchanged.
      if (initializedRef.current && reportedModeRef.current === "fullscreen") {
        postToView({
          jsonrpc: "2.0",
          method: "ui/notifications/host-context-changed",
          params: { safeAreaInsets: insetsNow() },
        });
      }
    });
    observer.observe(overlay);
    return () => observer.disconnect();
    // The overlay only exists in fullscreen; the frame's own effect order puts
    // it in the tree by the time this runs.
  }, [displayMode, insetsNow, postToView, src]);

  // Every mode change reaches the View as host context, whoever made it: the
  // View's own request, or the user leaving fullscreen from the host's bar.
  useEffect(() => {
    if (!initializedRef.current || reportedModeRef.current === displayMode) return;
    const frameRequest = requestAnimationFrame(() => {
      reportedModeRef.current = displayMode;
      const dimensions = containerDimensions();
      reportedWidthRef.current = dimensions.width ?? 0;
      postToView({
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: {
          displayMode,
          containerDimensions: dimensions,
          safeAreaInsets: insetsNow(),
        },
      });
    });
    return () => cancelAnimationFrame(frameRequest);
  }, [displayMode, containerDimensions, insetsNow, postToView]);

  // Every mode change reaches the View as host context, whoever made it: the
  // View's own request, or the user leaving fullscreen from the host's bar.
  useEffect(() => {
    if (!initializedRef.current || reportedModeRef.current === displayMode) return;
    const frameRequest = requestAnimationFrame(() => {
      reportedModeRef.current = displayMode;
      const dimensions = containerDimensions();
      reportedWidthRef.current = dimensions.width ?? 0;
      postToView({
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: {
          displayMode,
          containerDimensions: dimensions,
          safeAreaInsets: insetsNow(),
        },
      });
    });
    return () => cancelAnimationFrame(frameRequest);
  }, [displayMode, containerDimensions, insetsNow, postToView]);

  // Every mode change reaches the View as host context, whoever made it: the
  // View's own request, or the user leaving fullscreen from the host's bar.
  useEffect(() => {
    if (!initializedRef.current || reportedModeRef.current === displayMode) return;
    const frameRequest = requestAnimationFrame(() => {
      reportedModeRef.current = displayMode;
      const dimensions = containerDimensions();
      reportedWidthRef.current = dimensions.width ?? 0;
      postToView({
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: {
          displayMode,
          containerDimensions: dimensions,
          safeAreaInsets: insetsNow(),
        },
      });
    });
    return () => cancelAnimationFrame(frameRequest);
  }, [displayMode, containerDimensions, insetsNow, postToView]);

  // Every mode change reaches the View as host context, whoever made it: the
  // View's own request, or the user leaving fullscreen from the host's bar.
  useEffect(() => {
    if (!initializedRef.current || reportedModeRef.current === displayMode) return;
    const frameRequest = requestAnimationFrame(() => {
      reportedModeRef.current = displayMode;
      const dimensions = containerDimensions();
      reportedWidthRef.current = dimensions.width ?? 0;
      postToView({
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: {
          displayMode,
          containerDimensions: dimensions,
          safeAreaInsets: insetsNow(),
        },
      });
    });
    return () => cancelAnimationFrame(frameRequest);
  }, [displayMode, containerDimensions, insetsNow, postToView]);

  // Every mode change reaches the View as host context, whoever made it: the
  // View's own request, or the user leaving fullscreen from the host's bar.
  useEffect(() => {
    if (!initializedRef.current || reportedModeRef.current === displayMode) return;
    const frameRequest = requestAnimationFrame(() => {
      reportedModeRef.current = displayMode;
      const dimensions = containerDimensions();
      reportedWidthRef.current = dimensions.width ?? 0;
      postToView({
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: {
          displayMode,
          containerDimensions: dimensions,
          safeAreaInsets: insetsNow(),
        },
      });
    });
    return () => cancelAnimationFrame(frameRequest);
  }, [displayMode, containerDimensions, insetsNow, postToView]);

  // Every mode change reaches the View as host context, whoever made it: the
  // View's own request, or the user leaving fullscreen from the host's bar.
  useEffect(() => {
    if (!initializedRef.current || reportedModeRef.current === displayMode) return;
    const frameRequest = requestAnimationFrame(() => {
      reportedModeRef.current = displayMode;
      const dimensions = containerDimensions();
      reportedWidthRef.current = dimensions.width ?? 0;
      postToView({
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: {
          displayMode,
          containerDimensions: dimensions,
          safeAreaInsets: insetsNow(),
        },
      });
    });
    return () => cancelAnimationFrame(frameRequest);
  }, [displayMode, containerDimensions, insetsNow, postToView]);

  // Every mode change reaches the View as host context, whoever made it: the
  // View's own request, or the user leaving fullscreen from the host's bar.
  useEffect(() => {
    if (!initializedRef.current || reportedModeRef.current === displayMode) return;
    const frameRequest = requestAnimationFrame(() => {
      reportedModeRef.current = displayMode;
      const dimensions = containerDimensions();
      reportedWidthRef.current = dimensions.width ?? 0;
      postToView({
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: {
          displayMode,
          containerDimensions: dimensions,
          safeAreaInsets: insetsNow(),
        },
      });
    });
    return () => cancelAnimationFrame(frameRequest);
  }, [displayMode, containerDimensions, insetsNow, postToView]);

  // Every mode change reaches the View as host context, whoever made it: the
  // View's own request, or the user leaving fullscreen from the host's bar.
  useEffect(() => {
    if (!initializedRef.current || reportedModeRef.current === displayMode) return;
    const frameRequest = requestAnimationFrame(() => {
      reportedModeRef.current = displayMode;
      const dimensions = containerDimensions();
      reportedWidthRef.current = dimensions.width ?? 0;
      postToView({
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: {
          displayMode,
          containerDimensions: dimensions,
          safeAreaInsets: insetsNow(),
        },
      });
    });
    return () => cancelAnimationFrame(frameRequest);
  }, [displayMode, containerDimensions, insetsNow, postToView]);




  // Layout, for the same reason as the arming above: the view's first message can
  // only follow the handshake, but the listener must already be attached when it
  // lands, and a passive effect is not ordered against that.
  useLayoutEffect(() => {
    // Everything the view says arrives on its port, which only the document the
    // host seeded holds. Sender identity and an opaque origin both survive a
    // navigation and so prove nothing; holding the port is the proof.
    const handler = (event: MessageEvent) => {
      // Answered on the port the request came in on, so a reply that resolves
      // after a reload -- or during teardown -- reaches the document that asked.
      const replyPort =
        event.currentTarget instanceof MessagePort ? event.currentTarget : null;
      const reply = (message: unknown) =>
        replyPort ? replyPort.postMessage(message) : postToView(message);
      const respond = (id: JsonRpcId, result: unknown) =>
        reply({ jsonrpc: "2.0", id, result });
      const fail = (id: JsonRpcId, code: number, message: string) =>
        reply({ jsonrpc: "2.0", id, error: { code, message } });
      const data = event.data;
      // The resize fallback, which is not part of the widget protocol.
      if (typeof data?.mcpAppHeight === "number") {
        if (viewOwnsSizeRef.current) return;
        setHeight(Math.min(Math.max(data.mcpAppHeight, MIN_HEIGHT), MAX_HEIGHT));
        return;
      }
      if (!isJsonRpc(data) || typeof data.method !== "string") return;

      const { method, params, id } = data;

      switch (method) {
        case "ui/initialize": {
          if (id === undefined) return;
          const requested = (params as { protocolVersion?: unknown } | undefined)
            ?.protocolVersion;
          const dimensions = containerDimensions();
          reportedWidthRef.current = dimensions.width ?? 0;
          reportedModeRef.current = displayModeRef.current;
          const appModes = (
            params as
              | { appCapabilities?: { availableDisplayModes?: unknown } }
              | undefined
          )?.appCapabilities?.availableDisplayModes;
          appModesRef.current = Array.isArray(appModes)
            ? appModes.filter((m): m is string => typeof m === "string")
            : null;
          const granted = permissions;
          respond(id, {
            protocolVersion:
              typeof requested === "string" &&
              SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
                ? requested
                : UI_PROTOCOL_VERSION,
            hostInfo: { name: HOST_NAME, version: HOST_VERSION },
            hostCapabilities: {
              // Only what this host actually implements.
              openLinks: {},
              serverTools: { listChanged: false },
              logging: {},
              message: { text: {} },
              ...(toolCallId
                ? {
                    updateModelContext: {
                      text: {},
                      image: {},
                      structuredContent: {},
                    },
                  }
                : {}),
              ...(Object.keys(granted).length
                ? { sandbox: { permissions: granted } }
                : {}),
            },
            hostContext: {
              theme,
              displayMode: displayModeRef.current,
              availableDisplayModes: [...HOST_DISPLAY_MODES],
              containerDimensions: dimensions,
              ...(displayModeRef.current === "fullscreen"
                ? { safeAreaInsets: insetsNow() }
                : {}),
              locale:
                typeof navigator === "undefined" ? "en" : navigator.language,
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              userAgent: `${HOST_NAME}/${HOST_VERSION}`,
              platform: isTauri ? "desktop" : "web",
              deviceCapabilities: {
                touch:
                  typeof window !== "undefined" && "ontouchstart" in window,
                hover:
                  typeof window !== "undefined" &&
                  window.matchMedia("(hover: hover)").matches,
              },
            },
          });
          return;
        }

        case "ui/notifications/initialized": {
          // Only now is the view ready for host-context updates.
          initializedRef.current = true;
          setViewReady(true);
          return;
        }

        case "ping": {
          if (id !== undefined) respond(id, {});
          return;
        }

        case "ui/notifications/size-changed": {
          const reported = (params as { height?: unknown } | undefined)?.height;
          if (typeof reported === "number" && Number.isFinite(reported)) {
            viewOwnsSizeRef.current = true;
            setHeight(Math.min(Math.max(reported, MIN_HEIGHT), MAX_HEIGHT));
          }
          return;
        }

        case "tools/call": {
          if (id === undefined) return;
          const name = (params as { name?: unknown } | undefined)?.name;
          if (typeof name !== "string" || !name) {
            fail(id, INVALID_PARAMS, "tools/call requires a tool name");
            return;
          }
          const args = (params as { arguments?: unknown } | undefined)
            ?.arguments;
          const callArgs =
            typeof args === "object" && args !== null
              ? (args as Record<string, unknown>)
              : {};
          // serverId is the host's, from the tool part that drew the frame.
          const send = (approved: boolean) =>
            callMcpUiTool(serverId, {
              toolName: name,
              arguments: callArgs,
              threadId,
              sessionId,
              permissionMode: useChatRuntimeStore.getState().permissionMode,
              approved,
            });
          const deliver = (res: McpUiToolCallResult) =>
            respond(id, {
              content: res.content ?? [],
              ...(res.structured_content !== null
                ? { structuredContent: res.structured_content }
                : {}),
              isError: res.is_error,
              ...(res.meta ? { _meta: res.meta } : {}),
            });
          const refuse = (err: unknown) =>
            fail(
              id,
              INTERNAL_ERROR,
              err instanceof Error ? err.message : String(err),
            );
          const alwaysAllowed =
            useChatRuntimeStore
              .getState()
              .alwaysAllowToolsBySession.get(approvalScope)
              ?.has(mcpAppToolKey(serverId, name)) ?? false;
          send(alwaysAllowed)
            .then(deliver)
            .catch((err: unknown) => {
              if (!(err instanceof McpUiApprovalRequired)) {
                refuse(err);
                return;
              }
              if (pendingCallsRef.current.length >= MAX_PENDING_TOOL_CALLS) {
                fail(id, INTERNAL_ERROR, "Too many tool requests are waiting");
                return;
              }
              // The widget is untrusted HTML: it waits for the same answer the
              // model's call would.
              pendingKeyRef.current += 1;
              setPendingCalls((queue) => [
                ...queue,
                {
                  key: pendingKeyRef.current,
                  name,
                  args: callArgs,
                  decide: (allow) => {
                    if (allow) {
                      send(true).then(deliver).catch(refuse);
                      return;
                    }
                    respond(id, {
                      content: [{ type: "text", text: MCP_APP_TOOL_DECLINED }],
                      isError: true,
                    });
                  },
                },
              ]);
            });
          return;
        }

        case "resources/read": {
          if (id === undefined) return;
          const uri = (params as { uri?: unknown } | undefined)?.uri;
          if (typeof uri !== "string" || !uri) {
            fail(id, INVALID_PARAMS, "resources/read requires a uri");
            return;
          }
          // The backend restricts this to templates the server declared.
          readMcpUiResource(serverId, uri, { threadId, sessionId })
            .then((res) => {
              if (res.contents?.length) {
                respond(id, { contents: res.contents });
                return;
              }
              const body = res.blob ? { blob: res.blob } : { text: res.text };
              respond(id, {
                contents: [{ uri: res.uri, mimeType: res.mime_type, ...body }],
              });
            })
            .catch((err: unknown) => {
              fail(
                id,
                INTERNAL_ERROR,
                err instanceof Error ? err.message : String(err),
              );
            });
          return;
        }

        case "ui/open-link": {
          const url = (params as { url?: unknown } | undefined)?.url;
          if (typeof url !== "string") {
            if (id !== undefined) {
              fail(id, INVALID_PARAMS, "ui/open-link requires a url");
            }
            return;
          }
          // http(s) only: never open a javascript:, data: or file: URL.
          let safe = false;
          try {
            safe = ["http:", "https:"].includes(new URL(url).protocol);
          } catch {
            safe = false;
          }
          if (!safe) {
            if (id !== undefined) {
              fail(id, INVALID_PARAMS, "Only http(s) links can be opened");
            }
            return;
          }
          openLink(url);
          if (id !== undefined) respond(id, {});
          return;
        }

        case "ui/request-display-mode": {
          if (id === undefined) return;
          // Never a mode the host lacks, nor one the View did not declare when it
          // declared any; the resulting mode is always returned, changed or not.
          const requested = (params as { mode?: unknown } | undefined)?.mode;
          const appModes = appModesRef.current;
          const allowed =
            typeof requested === "string" &&
            (HOST_DISPLAY_MODES as readonly string[]).includes(requested) &&
            (appModes === null || appModes.includes(requested));
          const mode = allowed
            ? (requested as DisplayMode)
            : displayModeRef.current;
          displayModeRef.current = mode;
          setDisplayMode(mode);
          respond(id, { mode });
          return;
        }

        case "ui/message": {
          if (id === undefined) return;
          // Text is what a chat turn carries; anything else is refused whole
          // rather than sent with parts silently missing.
          const raw = (params as { content?: unknown } | undefined)?.content;
          const blocks = Array.isArray(raw) ? raw : raw ? [raw] : [];
          const role = (params as { role?: unknown } | undefined)?.role;
          const texts: string[] = [];
          for (const block of blocks) {
            const text = (block as { type?: unknown; text?: unknown } | null)
              ?.type === "text"
              ? (block as { text?: unknown }).text
              : undefined;
            if (typeof text !== "string") {
              fail(id, INVALID_PARAMS, "Only text messages can be sent");
              return;
            }
            texts.push(text);
          }
          const text = texts.join("\n").trim();
          if ((role !== undefined && role !== "user") || !text) {
            fail(id, INVALID_PARAMS, "ui/message needs a user role and text");
            return;
          }
          if (pendingMessageRef.current) {
            fail(id, DECLINED, "Another message from this app is waiting");
            return;
          }
          // The widget is untrusted HTML: it may put words in the user's mouth
          // only with the user's say-so.
          setPendingMessage({
            text,
            decide: (sendIt) => {
              if (!sendIt) {
                fail(id, DECLINED, "Message sending denied");
                return;
              }
              if (aui.thread().getState().isRunning) {
                fail(id, DECLINED, "The chat is busy; try again when it is idle");
                return;
              }
              aui.thread().append({
                role: "user",
                content: [{ type: "text", text }],
                createdAt: new Date(),
              } as never);
              respond(id, {});
            },
          });
          return;
        }

        case "ui/update-model-context": {
          if (id === undefined) return;
          if (!toolCallId) {
            fail(id, METHOD_NOT_FOUND, `Unsupported method: ${method}`);
            return;
          }
          const content = (params as { content?: unknown } | undefined)
            ?.content;
          const structured = (
            params as { structuredContent?: unknown } | undefined
          )?.structuredContent;
          if (
            (content !== undefined && !Array.isArray(content)) ||
            (structured !== undefined &&
              (typeof structured !== "object" || structured === null))
          ) {
            fail(id, INVALID_PARAMS, "Invalid content format");
            return;
          }
          setMcpAppModelContext(toolCallId, {
            toolName,
            ...(content !== undefined ? { content: content as unknown[] } : {}),
            ...(structured !== undefined
              ? { structuredContent: structured as Record<string, unknown> }
              : {}),
          });
          respond(id, {});
          return;
        }

        case "notifications/message": {
          const level = (params as { level?: unknown } | undefined)?.level;
          const text =
            (params as { data?: unknown; text?: unknown } | undefined)?.data ??
            (params as { text?: unknown } | undefined)?.text;
          console[level === "error" ? "error" : "info"](
            `[mcp-app ${toolName}]`,
            text,
          );
          return;
        }

        default: {
          // Notifications get no reply, but an unknown request must not hang.
          if (id !== undefined) {
            fail(id, METHOD_NOT_FOUND, `Unsupported method: ${method}`);
          }
        }
      }
    };

    const adopt = (port: MessagePort) => {
      viewPortRef.current?.close();
      viewPortRef.current = port;
      // Asked by a document that is gone.
      setPendingCalls([]);
      setPendingMessage(null);
      port.onmessage = handler;
    };

    // The handshake is the one thing that cannot come over a port, since it is
    // what delivers one. Only the frame this component made, and only once per load.
    const onHandshake = (event: MessageEvent) => {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      if (!bridgeToken || !html) return;

      if (sandboxOrigin) {
        // The spec's sandbox proxy says it is ready; the host hands it the view
        // and a port of the host's own, and every later message rides that port.
        if (event.origin !== sandboxOrigin) return;
        if ((event.data as { method?: unknown })?.method !== SANDBOX_PROXY_READY) {
          return;
        }
        // Once per load: a page the proxy frame navigated to cannot ask again.
        if (!pendingPostRef.current) return;
        pendingPostRef.current = false;
        const channel = new MessageChannel();
        adopt(channel.port1);
        frame.contentWindow?.postMessage(
          {
            jsonrpc: "2.0",
            method: SANDBOX_RESOURCE_READY,
            params: {
              html,
              csp: resource?.ui?.csp ?? {},
              permissions,
              // Not a spec field: the proxy admits the view's port only from the
              // document that carries it, which is the one this html makes.
              bridgeToken,
            },
          },
          sandboxOrigin,
          [channel.port2],
        );
        return;
      }

      // The opaque fallback: the seeded document hands over its own port, and the
      // token is what tells it from a page the frame navigated to.
      if (event.origin !== "null") return;
      const envelope = event.data as {
        __unslothMcpApp?: unknown;
        __unslothMcpAppPort?: unknown;
      };
      if (
        typeof envelope !== "object" ||
        envelope === null ||
        envelope.__unslothMcpApp !== bridgeToken ||
        envelope.__unslothMcpAppPort !== true
      ) {
        return;
      }
      const port = event.ports[0];
      if (!port) return;
      adopt(port);
    };

    // A live port keeps the handler it was given, so re-point it whenever this
    // effect rebuilds one: otherwise a theme change leaves the view answered by
    // a closure describing the previous theme.
    if (viewPortRef.current) viewPortRef.current.onmessage = handler;

    window.addEventListener("message", onHandshake);
    return () => window.removeEventListener("message", onHandshake);
  }, [
    aui,
    bridgeToken,
    containerWidth,
    html,
    permissions,
    postToView,
    resource,
    sandboxOrigin,
    seedView,
    serverId,
    threadId,
    sessionId,
    approvalScope,
    theme,
    toolCallId,
    toolName,
  ]);

  const failure =
    error ??
    (resource && !bridgeToken
      ? "this browser has no Web Crypto to isolate it with"
      : null);

  if (failure) {
    return (
      <div className="mt-2 rounded border border-border bg-muted/30 px-3 py-2 text-ui-12p5 text-muted-foreground">
        Could not load this MCP app's interface: {failure}
      </div>
    );
  }

  const loading = !src || !html;
  const asking = pendingCalls[0];
  const answer = (allow: boolean, always = false) => {
    if (!asking) return;
    if (always) allowToolAlways(approvalScope, mcpAppToolKey(serverId, asking.name));
    setPendingCalls((queue) => queue.filter((call) => call.key !== asking.key));
    asking.decide(allow);
  };
  const askingArgs = asking ? mcpAppArgsPreview(asking.args) : "";
  const answerMessage = (send: boolean) => {
    const pending = pendingMessage;
    if (!pending) return;
    setPendingMessage(null);
    pending.decide(send);
  };
  const bordered = resource?.ui?.prefersBorder !== false;
  const reaches = externalDomains(resource?.ui?.csp);

  const fullscreen = displayMode === "fullscreen";
  // Where the user answers the View's requests: under the frame inline, and inside
  // the fullscreen container, since nothing outside the top layer can be seen.
  const prompts = (
    <>
      {asking ? (
        <div
          role="group"
          aria-label="Tool request from this app"
          className="mt-1 rounded border border-border bg-muted/30 px-3 py-2 text-ui-12p5"
        >
          <div>
            This app wants to run{" "}
            <span className="font-mono">{asking.name}</span>
            {pendingCalls.length > 1
              ? ` (+${pendingCalls.length - 1} more waiting)`
              : ""}
          </div>
          {askingArgs ? (
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all text-muted-foreground">
              {askingArgs}
            </pre>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button size="xs" onClick={() => answer(true)}>
              Allow
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => answer(true, true)}
            >
              Always allow
            </Button>
            <Button
              size="xs"
              variant="destructive"
              onClick={() => answer(false)}
            >
              Deny
            </Button>
          </div>
        </div>
      ) : null}
      {pendingMessage ? (
        <div
          role="group"
          aria-label="Message from this app"
          className="mt-1 rounded border border-border bg-muted/30 px-3 py-2 text-ui-12p5"
        >
          <div>This app wants to send a message to the chat as you:</div>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
            {pendingMessage.text}
          </pre>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button size="xs" onClick={() => answerMessage(true)}>
              Send
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => answerMessage(false)}
            >
              Don't send
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );

  return (
    <>
      <div
        ref={holderRef}
        data-slot="mcp-app-frame"
        data-display-mode={displayMode}
        style={
          fullscreen
            ? {
                position: "fixed",
                inset: 0,
                width: "100vw",
                height: "100dvh",
                maxWidth: "none",
                maxHeight: "none",
                margin: 0,
                border: 0,
                borderRadius: 0,
                paddingTop: FULLSCREEN_BAR_PX,
              }
            : { height: loading ? MIN_HEIGHT : height }
        }
        className={cn(
          "relative mt-2 block w-full overflow-hidden rounded bg-background",
          bordered && !fullscreen && "border border-border",
          loading && "animate-pulse bg-muted/30",
          fullscreen && "z-[1000]",
          className,
        )}
      >
        {fullscreen ? (
          <>
            <div
              className="absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-2 border-b border-border bg-background px-3"
              style={{ height: FULLSCREEN_BAR_PX }}
            >
              <span className="truncate text-ui-12p5 text-muted-foreground">
                {toolName}
              </span>
              <Button
                size="xs"
                variant="outline"
                onClick={() => setDisplayMode("inline")}
              >
                Exit full screen
              </Button>
            </div>
            <div
              ref={overlayRef}
              className="pointer-events-none absolute inset-x-4 bottom-4 z-10 flex flex-col gap-3"
            >
              {asking || pendingMessage ? (
                <div className="pointer-events-auto mx-auto w-full max-w-2xl shadow-lg">
                  {prompts}
                </div>
              ) : null}
              <FullscreenChatBar />
            </div>
          </>
        ) : null}
      </div>
      {!fullscreen && !loading && !sandboxOrigin ? (
        <div className="mt-1 truncate text-ui-12p5 text-muted-foreground">
          This app is running in a stricter isolated mode (no app origin is
          available on this connection).
        </div>
      ) : null}
      {!fullscreen && reaches.length ? (
        <div className="mt-1 truncate text-ui-12p5 text-muted-foreground" title={reaches.join(", ")}>
          This app can connect to {reaches.join(", ")}
        </div>
      ) : null}
      {fullscreen ? null : prompts}
    </>
  );
}
