// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/** Best-effort arguments from a tool call whose JSON is still streaming.
 *
 * The spec's ui/notifications/tool-input-partial carries "best-effort recovery of
 * incomplete JSON, with unclosed structures automatically closed", which is exactly
 * what assistant-stream's parser does for the live stream. A leaf module so the tool
 * card can use it without pulling in the chat adapter (module-cycle rule). */

import { parsePartialJsonObject } from "assistant-stream/utils";

export function parsePartialToolArgs(
  argsText: string | undefined,
): Record<string, unknown> | undefined {
  if (!argsText) return undefined;
  let candidate = argsText.trimStart();
  if (!candidate.startsWith("{")) {
    const brace = candidate.indexOf("{");
    if (brace < 0) return undefined;
    candidate = candidate.slice(brace);
  }
  const parsed = parsePartialJsonObject(candidate) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    // The parser stamps partial results with symbol metadata; the wire wants a
    // plain object, and JSON round-tripping drops symbol-keyed properties.
    try {
      return JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
