// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

// How a widget's frame leaves: told first, then parked rather than destroyed, and
// bounded. Out of React's tree, so these outlive the component that drew the frame.

import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";

// How a widget being torn down may take to answer ui/resource-teardown.
export const TEARDOWN_GRACE_MS = 3_000;
// How long a parked frame keeps serving after its card re-keyed. The successor
// card intermittently does not re-mount, and the parked document is then the
// only thing still polling its server and rendering pages; killing it at once
// is how a viewer ends up on screen but dead to its server. The cap exists so
// a parked frame cannot poll a deleted server forever.
export const PARKED_FRAME_LIFETIME_MS = 60_000;

const PARKING_LOT_ATTR = "data-mcp-app-parking-lot";

/** What a frame's retirement needs of the bridge session that served it. */
export interface ParkableSession {
  /** The frame is off screen: nobody can be asked anything on its behalf. */
  park(): void;
  /** The frame is leaving the card; drop what it told the model. */
  retire?(): void;
  /** Close the bridge and the view's port. */
  close(): void;
}

// Frames being torn down wait here for the view's answer, out of the layout and
// out of React's tree, so they outlive the component that drew them.
let parkingLot: HTMLDivElement | null = null;
const parked = new Map<HTMLIFrameElement, ParkableSession>();

/** Move `frame` aside without reloading it. False where the browser cannot (no
 *  moveBefore: Safari, Firefox), when the frame stays where it is. */
export function parkFrame(frame: HTMLIFrameElement): boolean {
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
    parkingLot.setAttribute(PARKING_LOT_ATTR, "true");
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

/** Remove every parked frame and close what served it: called when the user truly
 *  leaves, after the announced teardown was answered (chat-page blocker). Re-key
 *  parks are NOT cleared -- the parked document is there precisely to keep serving. */
export function clearParkedMcpAppFrames(): void {
  for (const [frame, session] of [...parked]) {
    parked.delete(frame);
    session.close();
    frame.remove();
  }
  if (parkingLot?.isConnected) {
    for (const frame of [...parkingLot.children]) frame.remove();
  }
}

/** Send ui/resource-teardown through the bridge; resolves on the View's answer, or
 *  after `timeoutMs`. Whatever else the View says meanwhile -- a last tool call, a
 *  final model-context update -- still reaches the bridge's handlers. `reason` is not in
 *  the SDK's (empty) params type, but is what the spec's teardown carries and what a
 *  view may read; the SDK passes request params through untouched. */
export async function requestTeardown(
  bridge: Pick<AppBridge, "teardownResource">,
  reason: string,
  timeoutMs: number,
): Promise<void> {
  try {
    await bridge.teardownResource({ reason }, { timeout: timeoutMs });
  } catch {
    // No answer in time, or the port is gone: either way the frame may go.
  }
}

/** Retire one loaded frame.
 *
 * The spec: the host MUST send ui/resource-teardown before tearing the resource
 * down, and SHOULD wait for the answer so the view can save what it holds. Leaving a
 * conversation announces it earlier, from the chat page, while the frame is still
 * mounted (see live-apps.ts); a card re-key is a host implementation detail the app
 * is never told about, so here the frame is parked, silently, and keeps serving --
 * its successor intermittently does not re-mount, and tearing the parked document
 * down is how a viewer ends up on screen yet "never connected".
 *
 * Where the browser cannot park (no moveBefore), the frame cannot be kept without
 * reloading, so it goes at once with its port: a bridge nobody can see must not
 * linger answering a document that is about to disappear.
 */
export function retireFrame(
  frame: HTMLIFrameElement,
  session: ParkableSession | null,
): void {
  if (!session) {
    frame.remove();
    return;
  }
  session.retire?.();
  if (!parkFrame(frame)) {
    session.close();
    frame.remove();
    return;
  }
  session.park();
  parked.set(frame, session);
  setTimeout(() => {
    if (!parked.delete(frame)) return;
    session.close();
    frame.remove();
  }, PARKED_FRAME_LIFETIME_MS);
}
