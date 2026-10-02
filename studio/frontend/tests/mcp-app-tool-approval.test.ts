// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { toolApprovalScope as mcpAppApprovalScope } from "../src/features/chat/mcp-apps/mcp-ui.ts";
import {
  mcpAppArgsPreview,
  mcpAppToolKey,
} from "../src/features/chat/mcp-apps/tool-approval.ts";

const read = (path: string) =>
  readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

test("the scope is the one the chat adapter records an Always allow under", () => {
  assert.match(
    read("features/chat/api/chat-adapter.ts"),
    /toolConfirmationScopeId = resolvedThreadId\s*\? `\$\{sandboxSessionId \|\| "_default"\}:\$\{resolvedThreadId\}`\s*: sandboxSessionId \|\| "_default"/,
  );
  assert.equal(mcpAppApprovalScope("project-p", "t-1"), "project-p:t-1");
  assert.equal(mcpAppApprovalScope(undefined, "t-1"), "_default:t-1");
  assert.equal(mcpAppApprovalScope("", undefined), "_default");
});

test("the tool key is the name the model's call of that tool carries", () => {
  assert.equal(mcpAppToolKey("s1", "delete_item"), "mcp__s1__delete_item");
});

test("the arguments shown with the question are bounded", () => {
  assert.equal(mcpAppArgsPreview({}), "");
  const shown = mcpAppArgsPreview({ body: "x".repeat(5000) });
  assert.ok(shown.length <= 601 && shown.endsWith("…"));
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(mcpAppArgsPreview(cyclic), "");
});

test("a widget's tools/call is never sent as approved unless the user said so", () => {
  const bridge = read("features/chat/mcp-apps/use-app-bridge.ts");
  const sends = [...bridge.matchAll(/\bsend\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(sends.sort(), ["alwaysAllowed", "true"]);
  // The one unconditional approval sits behind the user's own Allow.
  assert.match(
    bridge,
    /if \(!\(await asked\)\) return declinedResult\(MCP_APP_TOOL_DECLINED\);\s*return toCallToolResult\(await send\(true\)\);/,
  );
  // And a frame nobody can see has no one to ask: it is refused, not queued.
  assert.match(
    bridge,
    /if \(session\.parked\) return declinedResult\(NOT_ON_SCREEN\);\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*const asked = ctx\.prompts\.askTool/,
  );
});
