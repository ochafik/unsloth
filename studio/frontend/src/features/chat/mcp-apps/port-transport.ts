// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

// The view's reply channel as an MCP transport: AppBridge speaks JSON-RPC over it.
//
// Not PostMessageTransport: that one listens on a window and filters on
// `event.source`, and the view's handle on this host is a MessagePort bound to the
// document that was seeded (see bridgeShim in mcp-ui.ts), which is what keeps a page the
// frame navigated to from talking to the bridge. Holding the port is the proof of who
// is speaking, so there is no source or origin check to make here.

import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";

export class PortTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private closed = false;
  private readonly port: MessagePort;
  private readonly sideChannel?: (data: unknown) => boolean;

  /** `sideChannel` sees every message first and returns true for one that is not
   *  JSON-RPC and so is not the bridge's (the height fallback's `mcpAppHeight`). */
  constructor(port: MessagePort, sideChannel?: (data: unknown) => boolean) {
    this.port = port;
    this.sideChannel = sideChannel;
  }

  async start(): Promise<void> {
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data as { jsonrpc?: unknown } | null;
      if (this.sideChannel?.(data)) return;
      if (typeof data !== "object" || data === null || data.jsonrpc !== "2.0") {
        return;
      }
      this.onmessage?.(data as JSONRPCMessage);
    };
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error("The view's port is closed");
    this.port.postMessage(message);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.port.onmessage = null;
    this.port.close();
    this.onclose?.();
  }
}
