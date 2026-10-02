// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"use client";

// The host side of the ui/* protocol, as the MCP Apps SDK's AppBridge. AppBridge owns
// the JSON-RPC: ui/initialize and version negotiation, ping, params validation, the
// host-context diffing, the tool-input/-partial/-result/-cancelled and teardown
// messages. What is Studio's own is what each request MEANS here: a tool call goes to
// the server through the chat's permission level, a message or a link needs the user's
// say-so, model context goes to the chat's own store, and a frame that is parked
// (on screen no longer) is refused anything that needs the user.

import { openLink } from "@/lib/open-link";
import {
  type CallToolResult,
  ProtocolError,
  type ReadResourceResult,
} from "@modelcontextprotocol/client";
import {
  AppBridge,
  type McpUiHostCapabilities,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { useCallback, useEffect, useRef, useState } from "react";
import hostPackage from "../../../../package.json";
import {
  McpUiApprovalRequired,
  callMcpUiTool,
  readMcpUiResource,
  type McpUiToolCallResult,
} from "../api/mcp-servers-api";
import { useChatRuntimeStore } from "../stores/chat-runtime-store";
import type { ParkableSession } from "./frame-lifecycle";
import { type McpUiEnvelope, toolResultParams } from "./mcp-ui";
import { setMcpAppModelContext } from "./model-context";
import { PortTransport } from "./port-transport";
import type { PromptController } from "./pending-prompts";
import type { Permissions } from "./permissions-csp";
import { parsePartialToolArgs } from "./streaming-args";
import { MCP_APP_TOOL_DECLINED, mcpAppToolKey } from "./tool-approval";
import {
  HOST_DISPLAY_MODES,
  HOST_NAME,
  type DisplayMode,
} from "./use-host-context";

/** Where the tool call this widget draws stands: arguments still streaming, its
 *  result arrived, or the call was stopped before it produced one. */
export type McpAppPhase = "streaming" | "settled" | "cancelled";

// Tracks the frontend package's own version, not a hand-stamped constant.
export const HOST_VERSION: string = hostPackage.version;

// The implementation-defined code the spec leaves for a request the host or the
// user declined.
const DECLINED = -32000;

// A widget cannot open links faster than they can be read: this many requests
// (answered or not) per window, then refusals until the window has passed.
const LINK_WINDOW_MS = 10_000;
const MAX_LINKS_PER_WINDOW = 3;

const NOT_ON_SCREEN =
  "This app is not on screen, so the user cannot be asked; try again once it is shown.";

/** What the handlers need of the frame, read fresh at each request. */
export interface BridgeHandlerContext {
  serverId: string;
  toolName: string;
  /** The tool call this widget draws; keys what it tells the model about itself. */
  toolCallId?: string;
  threadId?: string;
  sessionId?: string;
  /** What "Always allow" is recorded under. */
  approvalScope: string;
  permissions: Permissions;
  prompts: PromptController;
  hostContext: () => McpUiHostContext;
  displayMode: () => DisplayMode;
  setDisplayMode: (mode: DisplayMode) => void;
  /** Append a user turn to the chat; false when the chat is busy. */
  sendUserMessage: (text: string) => boolean;
  /** The View's size, or the height fallback's measurement (`fromView` false). */
  onHeight: (height: number, fromView: boolean) => void;
}

/** One view's bridge, from the port it was seeded over until it is closed. */
export interface ViewSession extends ParkableSession {
  bridge: AppBridge;
  /** No longer on screen: nothing needing the user, and no model context. */
  parked: boolean;
  initialized: boolean;
  seeded: boolean;
  lastPartial: string;
  cancelledTold: boolean;
}

function hostCapabilities(ctx: BridgeHandlerContext): McpUiHostCapabilities {
  return {
    // Only what this host actually implements.
    openLinks: {},
    serverTools: { listChanged: false },
    serverResources: { listChanged: false },
    logging: {},
    message: { text: {} },
    ...(ctx.toolCallId
      ? { updateModelContext: { text: {}, image: {}, structuredContent: {} } }
      : {}),
    ...(Object.keys(ctx.permissions).length
      ? { sandbox: { permissions: ctx.permissions } }
      : {}),
  };
}

function toCallToolResult(res: McpUiToolCallResult): CallToolResult {
  return {
    content: (res.content ?? []) as CallToolResult["content"],
    ...(res.structured_content !== null
      ? { structuredContent: res.structured_content }
      : {}),
    isError: res.is_error,
    ...(res.meta ? { _meta: res.meta } : {}),
  };
}

const declinedResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

function isHttpUrl(url: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Run AppBridge over the view's port. `getContext` is read per request, so a
 *  handler never answers from a closure describing a previous theme or thread. */
export function createViewSession(
  port: MessagePort,
  getContext: () => BridgeHandlerContext,
  onInitialized: (session: ViewSession) => void,
): ViewSession {
  const first = getContext();
  const bridge = new AppBridge(
    null,
    { name: HOST_NAME, version: HOST_VERSION },
    hostCapabilities(first),
    { hostContext: first.hostContext() },
  );
  const session: ViewSession = {
    bridge,
    parked: false,
    initialized: false,
    seeded: false,
    lastPartial: "",
    cancelledTold: false,
    park() {
      session.parked = true;
    },
    close() {
      void bridge.close().catch(() => {});
    },
  };
  const linkRequests: number[] = [];

  bridge.oninitialized = () => {
    session.initialized = true;
    onInitialized(session);
  };

  bridge.onsizechange = ({ height }) => {
    if (typeof height === "number" && Number.isFinite(height)) {
      getContext().onHeight(height, true);
    }
  };

  bridge.onloggingmessage = ({ level, data }) => {
    console[level === "error" ? "error" : "info"](
      `[mcp-app ${getContext().toolName}]`,
      data,
    );
  };

  bridge.oncalltool = async ({ name, arguments: args }) => {
    const ctx = getContext();
    const callArgs = (args ?? {}) as Record<string, unknown>;
    // serverId is the host's, from the tool part that drew the frame.
    const send = (approved: boolean) =>
      callMcpUiTool(ctx.serverId, {
        toolName: name,
        arguments: callArgs,
        threadId: ctx.threadId,
        sessionId: ctx.sessionId,
        permissionMode: useChatRuntimeStore.getState().permissionMode,
        approved,
      });
    const alwaysAllowed =
      useChatRuntimeStore
        .getState()
        .alwaysAllowToolsBySession.get(ctx.approvalScope)
        ?.has(mcpAppToolKey(ctx.serverId, name)) ?? false;
    try {
      return toCallToolResult(await send(alwaysAllowed));
    } catch (err) {
      if (!(err instanceof McpUiApprovalRequired)) throw err;
      // A parked frame has no card to answer on.
      if (session.parked) return declinedResult(NOT_ON_SCREEN);
      // The widget is untrusted HTML: it waits for the same answer the model's
      // call would.
      const asked = ctx.prompts.askTool(name, callArgs);
      if (!asked) throw new Error("Too many tool requests are waiting");
      if (!(await asked)) return declinedResult(MCP_APP_TOOL_DECLINED);
      return toCallToolResult(await send(true));
    }
  };

  bridge.onreadresource = async ({ uri }): Promise<ReadResourceResult> => {
    const ctx = getContext();
    // The backend restricts this to templates the server declared.
    const res = await readMcpUiResource(ctx.serverId, uri, {
      threadId: ctx.threadId,
      sessionId: ctx.sessionId,
    });
    if (res.contents?.length) {
      return { contents: res.contents as ReadResourceResult["contents"] };
    }
    const body = res.blob ? { blob: res.blob } : { text: res.text };
    return { contents: [{ uri: res.uri, mimeType: res.mime_type, ...body }] };
  };

  bridge.onopenlink = async ({ url }) => {
    // http(s) only: never open a javascript:, data: or file: URL.
    if (!isHttpUrl(url)) return { isError: true };
    const now = Date.now();
    while (linkRequests.length && now - linkRequests[0] > LINK_WINDOW_MS) {
      linkRequests.shift();
    }
    if (session.parked || linkRequests.length >= MAX_LINKS_PER_WINDOW) {
      return { isError: true };
    }
    linkRequests.push(now);
    // The URL is shown as is: the widget chose where the user goes.
    const asked = getContext().prompts.askLink(url);
    if (!asked || !(await asked)) return { isError: true };
    openLink(url);
    return {};
  };

  bridge.onrequestdisplaymode = async ({ mode: requested }) => {
    const ctx = getContext();
    // Never a mode the host lacks, nor one the View did not declare when it
    // declared any; the resulting mode is always returned, changed or not.
    const appModes = bridge.getAppCapabilities()?.availableDisplayModes ?? null;
    const allowed =
      (HOST_DISPLAY_MODES as readonly string[]).includes(requested) &&
      (appModes === null || appModes.includes(requested));
    const mode = allowed ? (requested as DisplayMode) : ctx.displayMode();
    ctx.setDisplayMode(mode);
    return { mode };
  };

  bridge.onmessage = async ({ role, content }) => {
    // Text is what a chat turn carries; anything else is refused whole rather
    // than sent with parts silently missing.
    const texts: string[] = [];
    for (const block of content ?? []) {
      if (block?.type !== "text" || typeof block.text !== "string") {
        throw new ProtocolError(-32602, "Only text messages can be sent");
      }
      texts.push(block.text);
    }
    const text = texts.join("\n").trim();
    if (role !== "user" || !text) {
      throw new ProtocolError(-32602, "ui/message needs a user role and text");
    }
    // A declined message is an error the view's own promise rejects with, as it
    // always was here; a parked frame has no one to ask.
    if (session.parked) throw new ProtocolError(DECLINED, NOT_ON_SCREEN);
    // The widget is untrusted HTML: it may put words in the user's mouth only
    // with the user's say-so.
    const asked = getContext().prompts.askMessage(text);
    if (!asked) {
      throw new ProtocolError(
        DECLINED,
        "Another message from this app is waiting",
      );
    }
    if (!(await asked)) {
      throw new ProtocolError(DECLINED, "Message sending denied");
    }
    if (!getContext().sendUserMessage(text)) {
      throw new ProtocolError(
        DECLINED,
        "The chat is busy; try again when it is idle",
      );
    }
    return {};
  };

  if (first.toolCallId) {
    bridge.onupdatemodelcontext = async ({ content, structuredContent }) => {
      const ctx = getContext();
      if (!ctx.toolCallId)
        throw new ProtocolError(-32601, "Unsupported method");
      // A parked view is not what the user is looking at: what it says now is not
      // the state of the conversation.
      if (session.parked) throw new ProtocolError(DECLINED, NOT_ON_SCREEN);
      setMcpAppModelContext(ctx.toolCallId, {
        toolName: ctx.toolName,
        ...(content !== undefined ? { content: content as unknown[] } : {}),
        ...(structuredContent !== undefined ? { structuredContent } : {}),
      });
      return {};
    };
  }

  void bridge
    .connect(
      new PortTransport(port, (data) => {
        const height = (data as { mcpAppHeight?: unknown } | null)
          ?.mcpAppHeight;
        if (typeof height !== "number") return false;
        // The resize fallback, which is not part of the widget protocol.
        getContext().onHeight(height, false);
        return true;
      }),
    )
    .catch(() => {});
  return session;
}

/** The session of the frame on screen: made when its port arrives, handed back for
 *  retirement when the frame goes. */
export function useAppBridge(context: BridgeHandlerContext) {
  const contextRef = useRef(context);
  contextRef.current = context;
  const sessionRef = useRef<ViewSession | null>(null);
  const [ready, setReady] = useState(false);

  const connect = useCallback((port: MessagePort) => {
    sessionRef.current?.close();
    // Asked by a document that is gone.
    contextRef.current.prompts.clear();
    setReady(false);
    sessionRef.current = createViewSession(
      port,
      () => contextRef.current,
      (session) => {
        if (sessionRef.current === session) setReady(true);
      },
    );
  }, []);

  /** The frame is going: the session is no longer current, and is returned. */
  const detach = useCallback((): ViewSession | null => {
    const session = sessionRef.current;
    sessionRef.current = null;
    setReady(false);
    contextRef.current.prompts.clear();
    return session;
  }, []);

  /** Hand the bridge a fresh host context; it notifies only what changed. */
  const pushHostContext = useCallback((hostContext: McpUiHostContext) => {
    const session = sessionRef.current;
    if (!session?.initialized || session.parked) return;
    void Promise.resolve(session.bridge.setHostContext(hostContext)).catch(
      () => {},
    );
  }, []);

  return { sessionRef, ready, connect, detach, pushHostContext };
}

/** tool-input, tool-result, tool-input-partial and tool-cancelled, in the order the
 *  spec allows them. Nothing goes before `initialized`. */
export function useToolNotifications(options: {
  sessionRef: { current: ViewSession | null };
  ready: boolean;
  phase: McpAppPhase;
  ui: McpUiEnvelope;
  toolArgs?: Record<string, unknown>;
  argsText?: string;
  resultImages?: { data: string; mimeType: string }[];
}) {
  const { sessionRef, ready, phase, ui, toolArgs, argsText, resultImages } =
    options;

  // The seed: tool-input then tool-result, once the call has a result. A widget
  // mounted mid-stream gets neither until its call settles (the spec forbids
  // tool-result before tool-input, and tool-input only "when arguments become
  // available" -- complete ones).
  useEffect(() => {
    const session = sessionRef.current;
    if (!ready || !session || phase !== "settled" || session.seeded) return;
    session.seeded = true;
    const { bridge } = session;
    void (async () => {
      await bridge.sendToolInput({ arguments: toolArgs ?? {} });
      await bridge.sendToolResult(
        toolResultParams(ui, resultImages) as Parameters<
          AppBridge["sendToolResult"]
        >[0],
      );
    })().catch(() => {});
  }, [sessionRef, ready, phase, toolArgs, ui, resultImages]);

  // Best-effort arguments while the model is still writing them. Stopped the moment
  // tool-input is sent (phase leaves "streaming"), and never repeated for the same parse.
  useEffect(() => {
    const session = sessionRef.current;
    if (!ready || !session || phase !== "streaming" || session.seeded) return;
    const parsed = parsePartialToolArgs(argsText) ?? toolArgs;
    if (!parsed || typeof parsed !== "object") return;
    const asText = JSON.stringify(parsed);
    if (asText === session.lastPartial) return;
    session.lastPartial = asText;
    void session.bridge
      .sendToolInputPartial({ arguments: parsed })
      .catch(() => {});
  }, [sessionRef, ready, phase, argsText, toolArgs]);

  // The call was stopped before it produced a result, so the widget it drew will
  // never be seeded.
  useEffect(() => {
    const session = sessionRef.current;
    if (!ready || !session || phase !== "cancelled" || session.cancelledTold)
      return;
    session.cancelledTold = true;
    void session.bridge
      .sendToolCancelled({ reason: "The user stopped this tool call." })
      .catch(() => {});
  }, [sessionRef, ready, phase]);
}
