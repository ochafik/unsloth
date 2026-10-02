// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/**
 * The MCP App widgets currently on screen, so the chat can tell them they are about
 * to go before it takes them away.
 *
 * The spec: the host MUST send ui/resource-teardown before tearing a View down, and
 * SHOULD wait for its answer so the View can save what it holds. A frame removed by
 * React is gone in the same commit, before any message can reach it, and only some
 * browsers can move a frame aside without reloading it. Switching conversations is
 * the common way a widget goes, and it is a navigation: the chat page holds the
 * navigation for the answers, while every widget is still mounted.
 */

/** Tell one widget it is being torn down; resolves on its answer or the timeout. */
export type AnnounceTeardown = (
  reason: string,
  timeoutMs: number,
) => Promise<void>;

interface LiveApp {
  /** The conversation the widget is drawn in; undefined when not yet known. */
  threadId: string | undefined;
  announce: AnnounceTeardown;
}

const live = new Set<LiveApp>();

export function registerLiveMcpApp(
  threadId: string | undefined,
  announce: AnnounceTeardown,
): () => void {
  const app: LiveApp = { threadId, announce };
  live.add(app);
  return () => {
    live.delete(app);
  };
}

/** The widgets that showing `nextThreadId` would take away: every one drawn in
 *  another conversation. A new chat's own ?new= -> ?thread= rewrite keeps its. */
function leaving(nextThreadId: string | undefined): LiveApp[] {
  return [...live].filter(
    (app) => app.threadId === undefined || app.threadId !== nextThreadId,
  );
}

export function hasLiveMcpAppsLeaving(
  nextThreadId: string | undefined,
): boolean {
  return leaving(nextThreadId).length > 0;
}

/** Announce teardown to every widget that `nextThreadId` takes away, at once, and
 *  wait for them all. */
export async function tearDownLiveMcpApps(
  nextThreadId: string | undefined,
  reason: string,
  timeoutMs: number,
): Promise<void> {
  await Promise.all(
    leaving(nextThreadId).map((app) =>
      app.announce(reason, timeoutMs).catch(() => undefined),
    ),
  );
}
