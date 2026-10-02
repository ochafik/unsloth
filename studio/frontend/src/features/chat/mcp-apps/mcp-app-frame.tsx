// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"use client";

// A widget (an MCP App View) in the chat thread. This is the shell: it makes the frame
// and renders around it. The pieces:
//   use-frame-source.ts   the template, its sandbox origin, grants, token and html
//   bridge-shim.ts        the handshake that delivers the view's port
//   use-app-bridge.ts     AppBridge over that port, and what each request means here
//   use-host-context.ts   display mode, fullscreen, theme and size as host context
//   pending-prompts.tsx   where the user answers a widget's requests
//   frame-lifecycle.ts    parking and teardown

import { Button } from "@/components/ui/button";
import { useTheme } from "@/features/settings/stores/theme-store";
import { cn } from "@/lib/utils";
import { useAui } from "@assistant-ui/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useChatRuntimeStore } from "../stores/chat-runtime-store";
import { FullscreenChatBar } from "./fullscreen-chat-bar";
import { listenForViewPort } from "./bridge-shim";
import { requestTeardown, retireFrame } from "./frame-lifecycle";
import { registerLiveMcpApp } from "./live-apps";
import { type McpUiEnvelope, toolApprovalScope } from "./mcp-ui";
import { externalDomains } from "./permissions-csp";
import { usePendingPrompts } from "./pending-prompts";
import { mcpAppToolKey } from "./tool-approval";
import {
  HOST_VERSION,
  type McpAppPhase,
  useAppBridge,
  useToolNotifications,
} from "./use-app-bridge";
import { useFrameSource } from "./use-frame-source";
import {
  FULLSCREEN_BAR_PX,
  MAX_HEIGHT,
  useHostContext,
} from "./use-host-context";

export { clearParkedMcpAppFrames } from "./frame-lifecycle";
export type { McpAppPhase } from "./use-app-bridge";

const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 120;

// The sandbox proxy has this long to say it is ready before the frame falls back
// to the opaque-origin shell (a port the browser cannot reach, say).
const PROXY_READY_TIMEOUT_MS = 10_000;

const clampHeight = (height: number) =>
  Math.min(Math.max(height, MIN_HEIGHT), MAX_HEIGHT);

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
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const allowToolAlways = useChatRuntimeStore((s) => s.allowToolAlways);
  const approvalScope = toolApprovalScope(sessionId, threadId);

  const source = useFrameSource(serverId, ui.resourceUri, {
    threadId,
    sessionId,
  });
  const {
    resource,
    sandboxOrigin,
    permissions,
    allow,
    src,
    html,
    bridgeToken,
  } = source;

  const { controller, waiting, prompts } = usePendingPrompts({
    onAlwaysAllow: (name) =>
      allowToolAlways(approvalScope, mcpAppToolKey(serverId, name)),
  });

  // Only a parent-initiated load is fed, so a self-navigated frame can't ask to
  // be re-seeded.
  const pendingPostRef = useRef(false);
  // Once the view reports its own size the measured fallback is ignored for
  // good, or it would drag a self-sized widget back on every content change.
  const viewOwnsSizeRef = useRef(false);
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

  // host and bridge need each other: the bridge asks the host for context, the host
  // hands the bridge what changed.
  const hostRef = useRef<ReturnType<typeof useHostContext> | null>(null);
  const bridge = useAppBridge({
    serverId,
    toolName,
    toolCallId,
    threadId,
    sessionId,
    approvalScope,
    permissions,
    prompts: controller,
    hostContext: () => hostRef.current?.hostContext() ?? {},
    displayMode: () => hostRef.current?.displayModeRef.current ?? "inline",
    setDisplayMode: (mode) => hostRef.current?.setDisplayMode(mode),
    sendUserMessage: (text) => {
      if (aui.thread().getState().isRunning) return false;
      aui.thread().append({
        role: "user",
        content: [{ type: "text", text }],
        createdAt: new Date(),
      } as never);
      return true;
    },
    onHeight: (reported, fromView) => {
      if (fromView) viewOwnsSizeRef.current = true;
      else if (viewOwnsSizeRef.current) return;
      setHeight(clampHeight(reported));
    },
  });
  const { sessionRef, ready, connect, detach } = bridge;
  const host = useHostContext({
    holderRef,
    iframeRef,
    theme,
    ready,
    hostVersion: HOST_VERSION,
    push: bridge.pushHostContext,
  });
  hostRef.current = host;
  const { displayMode, setDisplayMode, overlayRef } = host;

  useToolNotifications({
    sessionRef,
    ready,
    phase,
    ui,
    toolArgs,
    argsText,
    resultImages,
  });

  // Listed while mounted, so the chat can announce teardown before a navigation
  // takes this widget away (live-apps.ts).
  useEffect(() => {
    let recheck: ReturnType<typeof setTimeout> | undefined;
    const unregister = registerLiveMcpApp(
      threadId,
      async (reason, timeoutMs) => {
        const session = sessionRef.current;
        if (!session || !session.initialized || announcedRef.current) return;
        announcedRef.current = true;
        await requestTeardown(session.bridge, reason, timeoutMs);
        // Still here once the navigation has had its turn: start the view over.
        recheck = setTimeout(() => {
          if (!unmountingRef.current && announcedRef.current) {
            setReloadNonce((n) => n + 1);
          }
        }, 1_000);
      },
    );
    return () => {
      clearTimeout(recheck);
      unregister();
    };
  }, [threadId, sessionRef]);

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
    if (!src || !html || !holder || !bridgeToken) return;
    pendingPostRef.current = true;
    viewOwnsSizeRef.current = false;
    announcedRef.current = false;
    setDisplayMode("inline");
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
      frame.contentWindow?.postMessage(
        { type: "unsloth:artifact-html", html },
        "*",
      );
    };
    // Listening before the frame exists: its first message can only follow the
    // handshake, but the listener must already be attached when it lands.
    const stopListening = listenForViewPort({
      frame: () => (iframeRef.current === frame ? frame : null),
      sandboxOrigin,
      bridgeToken,
      pendingPostRef,
      resourceReady: () => ({
        html,
        csp: resource?.ui?.csp ?? {},
        permissions,
      }),
      adopt: connect,
    });
    frame.addEventListener("load", onLoad);
    frame.src = src;
    holder.appendChild(frame);
    iframeRef.current = frame;

    const proxyTimer = sandboxOrigin
      ? window.setTimeout(() => {
          if (pendingPostRef.current && iframeRef.current === frame) {
            source.markProxyFailed();
          }
        }, PROXY_READY_TIMEOUT_MS)
      : undefined;

    return () => {
      window.clearTimeout(proxyTimer);
      stopListening();
      frame.removeEventListener("load", onLoad);
      if (iframeRef.current === frame) iframeRef.current = null;
      pendingPostRef.current = false;
      retireFrame(frame, detach());
    };
  }, [
    src,
    html,
    sandboxOrigin,
    allow,
    toolName,
    reloadNonce,
    bridgeToken,
    resource,
    permissions,
    connect,
    detach,
    setDisplayMode,
  ]);

  if (source.failure) {
    return (
      <div className="mt-2 rounded border border-border bg-muted/30 px-3 py-2 text-ui-12p5 text-muted-foreground">
        Could not load this MCP app's interface: {source.failure}
      </div>
    );
  }

  const loading = !src || !html;
  const bordered = resource?.ui?.prefersBorder !== false;
  const reaches = externalDomains(resource?.ui?.csp);
  const fullscreen = displayMode === "fullscreen";

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
              {/* Where the user answers the View's requests: inside the fullscreen
                  container, since nothing outside the top layer can be seen. */}
              {waiting ? (
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
        <div
          className="mt-1 truncate text-ui-12p5 text-muted-foreground"
          title={reaches.join(", ")}
        >
          This app can connect to {reaches.join(", ")}
        </div>
      ) : null}
      {fullscreen ? null : prompts}
    </>
  );
}
