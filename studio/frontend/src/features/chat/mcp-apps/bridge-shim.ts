// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

// Getting the view's MessagePort into the host. The ui/* protocol itself is AppBridge's
// (use-app-bridge.ts); what stays here is the one thing it cannot carry, because it is
// what delivers the port: the handshake over window.postMessage.
//
// The shim injected into the template and its token minter are mcp-ui.ts's (a leaf
// that node tests load as is), re-exported so this is the one place to look.

import {
  SANDBOX_PROXY_READY_METHOD,
  SANDBOX_RESOURCE_READY_METHOD,
} from "@modelcontextprotocol/ext-apps/app-bridge";

export {
  RESIZE_FALLBACK,
  bridgeShim,
  newBridgeToken,
  withBridgeShim,
} from "./mcp-ui";

export interface ViewHandshake {
  /** The frame this host made, or null once it is gone. */
  frame: () => HTMLIFrameElement | null;
  /** The sandbox proxy's origin; null for the opaque-origin fallback. */
  sandboxOrigin: string | null;
  /** Names the seeded document: what tells it from a page the frame navigated to. */
  bridgeToken: string;
  /** Armed when the frame is made, cleared once per load by the handshake that uses it. */
  pendingPostRef: { current: boolean };
  /** What the sandbox proxy is handed (behind the proxy only). */
  resourceReady: () => {
    html: string;
    csp: unknown;
    permissions: unknown;
  } | null;
  /** The view's port, to speak the protocol over. */
  adopt: (port: MessagePort) => void;
}

/** Listen for the view's port. Returns the listener's remover. */
export function listenForViewPort(handshake: ViewHandshake): () => void {
  const { sandboxOrigin, bridgeToken, pendingPostRef } = handshake;
  const onHandshake = (event: MessageEvent) => {
    const frame = handshake.frame();
    if (!frame || event.source !== frame.contentWindow) return;

    if (sandboxOrigin) {
      // The spec's sandbox proxy says it is ready; the host hands it the view
      // and a port of the host's own, and every later message rides that port.
      if (event.origin !== sandboxOrigin) return;
      if (
        (event.data as { method?: unknown })?.method !==
        SANDBOX_PROXY_READY_METHOD
      ) {
        return;
      }
      // Once per load: a page the proxy frame navigated to cannot ask again.
      if (!pendingPostRef.current) return;
      const ready = handshake.resourceReady();
      if (!ready) return;
      pendingPostRef.current = false;
      const channel = new MessageChannel();
      handshake.adopt(channel.port1);
      frame.contentWindow?.postMessage(
        {
          jsonrpc: "2.0",
          method: SANDBOX_RESOURCE_READY_METHOD,
          params: {
            ...ready,
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
    handshake.adopt(port);
  };
  window.addEventListener("message", onHandshake);
  return () => window.removeEventListener("message", onHandshake);
}
