// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

// The scope is mcp-ui.ts's toolApprovalScope: what the chat adapter records, so "Always
// allow" given to the model's call of a tool covers a widget's call of it in the same
// chat, and back. The key below is the name the model's call of that tool carries.

export function mcpAppToolKey(serverId: string, toolName: string): string {
  return `mcp__${serverId}__${toolName}`;
}

export const MCP_APP_TOOL_DECLINED = "The user declined to run this tool call.";

const ARGS_PREVIEW_CHARS = 600;

export function mcpAppArgsPreview(args: Record<string, unknown>): string {
  if (Object.keys(args).length === 0) return "";
  let text: string;
  try {
    text = JSON.stringify(args, null, 2);
  } catch {
    return "";
  }
  return text.length > ARGS_PREVIEW_CHARS
    ? `${text.slice(0, ARGS_PREVIEW_CHARS)}…`
    : text;
}
