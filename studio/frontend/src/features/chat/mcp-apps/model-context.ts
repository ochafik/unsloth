// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/**
 * What MCP App widgets tell the model about themselves (ui/update-model-context).
 *
 * The spec: each update overwrites the View's previous one, the host SHOULD give it to
 * the model in future turns, and of several updates before the next user message only
 * the last SHOULD reach the model. So the state is captured per user turn:
 *
 *   - each widget's latest update is kept, in memory, until a message is sent;
 *   - sending a message captures a snapshot of every widget whose state changed since
 *     it was last captured, and binds it to that user message, for good;
 *   - the snapshot is replayed with that message on every later request, as part of
 *     it, so history is append-only: an earlier turn never changes (and neither does the
 *     prompt cache up to it), and a message sent with no new update carries nothing new.
 *
 * Snapshots are persisted per message (IndexedDB, see model-context-db.ts), so a reload
 * replays the same history.
 *
 * A leaf module: the chat adapter imports it, and the adapter must not be pulled into
 * the tool card's import graph (tests/tool-fallback-module-cycle.test.ts).
 */

export interface McpAppModelContext {
  /** The widget's own label for itself, for the model's benefit. */
  toolName: string;
  content?: unknown[];
  structuredContent?: Record<string, unknown>;
}

export interface McpAppContextImage {
  data: string;
  mimeType: string;
}

/** One widget's state, as captured when a message was sent. */
export interface McpAppContextEntry {
  toolCallId: string;
  toolName: string;
  text: string;
  images: McpAppContextImage[];
  /** Identity of the state, so an unchanged widget is not captured again. */
  signature: string;
}

export interface McpAppContextSnapshot {
  messageId: string;
  entries: McpAppContextEntry[];
  createdAt: number;
}

// Keeps a runaway widget from growing every later request without bound.
export const MAX_MODEL_CONTEXT_CHARS = 16_000;
// Per update; the request as a whole is bounded again in the adapter.
export const MAX_MODEL_CONTEXT_IMAGES = 4;
export const MAX_MODEL_CONTEXT_IMAGE_CHARS = 8_000_000;
const MODEL_CONTEXT_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

// ---- live state -------------------------------------------------------------------

const live = new Map<string, McpAppModelContext>();

export function setMcpAppModelContext(
  toolCallId: string,
  context: McpAppModelContext,
): void {
  live.set(toolCallId, context);
}

/** What one update says, bounded: text blocks and structured content as text, and the
 *  raster images the model can read. */
export function describeMcpAppContext(context: McpAppModelContext): {
  text: string;
  images: McpAppContextImage[];
} {
  const parts: string[] = [];
  const images: McpAppContextImage[] = [];
  let imageChars = 0;
  for (const block of context.content ?? []) {
    if (typeof block !== "object" || block === null) continue;
    const { type, text, data, mimeType } = block as {
      type?: unknown;
      text?: unknown;
      data?: unknown;
      mimeType?: unknown;
    };
    if (type === "text" && typeof text === "string") {
      parts.push(text);
      continue;
    }
    if (
      type === "image" &&
      typeof data === "string" &&
      data &&
      typeof mimeType === "string" &&
      MODEL_CONTEXT_IMAGE_TYPES.has(mimeType) &&
      images.length < MAX_MODEL_CONTEXT_IMAGES &&
      imageChars + data.length <= MAX_MODEL_CONTEXT_IMAGE_CHARS
    ) {
      imageChars += data.length;
      images.push({ data, mimeType });
    }
  }
  if (context.structuredContent !== undefined) {
    try {
      parts.push(JSON.stringify(context.structuredContent));
    } catch {
      // A cycle cannot come off the wire; nothing to report if one did.
    }
  }
  const body = parts.join("\n").trim();
  return {
    text:
      body.length > MAX_MODEL_CONTEXT_CHARS
        ? `${body.slice(0, MAX_MODEL_CONTEXT_CHARS)}\n[truncated]`
        : body,
    images,
  };
}

function signatureOf(text: string, images: McpAppContextImage[]): string {
  // The text, and each image's type, length and ends: exact enough to tell a
  // re-sent state from a new one without hashing megabytes.
  const imageKeys = images.map(
    (image) =>
      `${image.mimeType}:${image.data.length}:${image.data.slice(0, 64)}:${image.data.slice(-64)}`,
  );
  return JSON.stringify([text, imageKeys]);
}

// ---- snapshots ----------------------------------------------------------------------

/** Where snapshots are kept across reloads (model-context-db.ts registers IndexedDB);
 *  without one they last for the session. */
export interface McpAppContextStore {
  getMany(messageIds: readonly string[]): Promise<(McpAppContextSnapshot | undefined)[]>;
  put(snapshot: McpAppContextSnapshot): Promise<void>;
}

let store: McpAppContextStore | null = null;

export function setMcpAppContextStore(next: McpAppContextStore | null): void {
  store = next;
}

// messageId -> its snapshot, or null when it is known to have none.
const snapshots = new Map<string, McpAppContextSnapshot | null>();

export function mcpAppContextSnapshot(
  messageId: string | undefined,
): McpAppContextSnapshot | undefined {
  if (!messageId) return undefined;
  return snapshots.get(messageId) ?? undefined;
}

/**
 * Before a request: load the conversation's snapshots, then capture pending state onto
 * the newest user message (the one being answered) unless it already has a snapshot.
 *
 * `userMessageIds` is the conversation's user messages, oldest first.
 */
export async function prepareMcpAppContext(
  userMessageIds: readonly string[],
): Promise<void> {
  const unknown = userMessageIds.filter((id) => !snapshots.has(id));
  if (store && unknown.length > 0) {
    try {
      const found = await store.getMany(unknown);
      unknown.forEach((id, i) => snapshots.set(id, found[i] ?? null));
    } catch {
      for (const id of unknown) snapshots.set(id, null);
    }
  } else {
    for (const id of unknown) snapshots.set(id, null);
  }

  const newest = userMessageIds[userMessageIds.length - 1];
  if (!newest || snapshots.get(newest)) return;

  // What each widget last had captured in this conversation.
  const captured = new Map<string, string>();
  for (const id of userMessageIds) {
    for (const entry of snapshots.get(id)?.entries ?? []) {
      captured.set(entry.toolCallId, entry.signature);
    }
  }
  const entries: McpAppContextEntry[] = [];
  for (const [toolCallId, context] of live) {
    const { text, images } = describeMcpAppContext(context);
    if (!text && images.length === 0) continue;
    const signature = signatureOf(text, images);
    if (captured.get(toolCallId) === signature) continue;
    entries.push({ toolCallId, toolName: context.toolName, text, images, signature });
  }
  if (entries.length === 0) return;
  const snapshot: McpAppContextSnapshot = {
    messageId: newest,
    entries,
    createdAt: Date.now(),
  };
  snapshots.set(newest, snapshot);
  try {
    await store?.put(snapshot);
  } catch {
    // Kept for this session regardless; a reload then replays without it.
  }
}

/** The note a snapshot puts ahead of what the user wrote in its message. The same
 *  text on every request, so replaying a turn never changes it; only the message
 *  being answered carries the images themselves (see the chat adapter). */
export function mcpAppContextNote(snapshot: McpAppContextSnapshot): string {
  return snapshot.entries
    .map((entry) => {
      const n = entry.images.length;
      const pictures = n === 0 ? "" : n === 1 ? " (with an image)" : ` (with ${n} images)`;
      const body = entry.text ? `\n${entry.text}` : "";
      return `[State of the ${entry.toolName} app in this conversation when this message was sent${pictures}:]${body}`;
    })
    .join("\n\n");
}

/** For tests: forget everything held in memory. */
export function resetMcpAppContextForTests(): void {
  live.clear();
  snapshots.clear();
  store = null;
}
