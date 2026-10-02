// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAui, useAuiState } from "@assistant-ui/react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

/** The text of the newest assistant turn, or null when the newest turn is not one. */
function latestReplyText(
  messages: readonly { role: string; content: readonly unknown[] }[],
): string | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return null;
  return last.content
    .map((part) =>
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("")
    .trim();
}

/**
 * The chat, floating over a fullscreen MCP App widget.
 *
 * A fullscreen widget covers the page, the composer with it, and the point of an
 * app is often to talk about what it shows. This is the thread's own composer --
 * the same draft the chat's composer holds, sent the same way -- in a slim bar,
 * with the reply to what it sent shown above it. Attachments and the composer's
 * pills stay in the chat; a run in progress can be stopped but not queued behind.
 */
export function FullscreenChatBar() {
  const aui = useAui();
  const composerText = useAuiState(({ thread }) => thread.composer.text);
  // Typed into locally and pushed to the composer, never read back per keystroke:
  // the composer's state lands asynchronously, and a box bound to it straight
  // dropped every character typed before the last update came back.
  const [text, setText] = useState(composerText);
  const pushedRef = useRef(composerText);
  useEffect(() => {
    // A change that did not come from here: the draft cleared on send, or text
    // typed into the chat's own composer.
    if (composerText === pushedRef.current) return;
    pushedRef.current = composerText;
    setText(composerText);
  }, [composerText]);
  const edit = (value: string) => {
    setText(value);
    pushedRef.current = value;
    aui.thread().composer().setText(value);
  };
  const isRunning = useAuiState(({ thread }) => thread.isRunning);
  const reply = useAuiState(({ thread }) =>
    latestReplyText(
      thread.messages as readonly { role: string; content: readonly unknown[] }[],
    ),
  );
  // The reply panel belongs to what was sent from here, not to older turns.
  const [showReply, setShowReply] = useState(false);

  const send = () => {
    const composer = aui.thread().composer();
    if (isRunning || !text.trim()) return;
    if (composer.getState().text !== text) composer.setText(text);
    composer.send();
    setShowReply(true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    send();
  };

  return (
    <div
      data-slot="mcp-app-fullscreen-chat"
      className="pointer-events-auto mx-auto flex w-full max-w-2xl flex-col gap-2 px-1 pb-2"
    >
      {showReply && (reply || isRunning) ? (
        <div className="relative max-h-[40vh] overflow-auto rounded-lg border border-border bg-background/95 px-3 py-2 text-ui-12p5 shadow-lg backdrop-blur">
          <button
            type="button"
            aria-label="Hide reply"
            className="absolute right-2 top-1 text-muted-foreground hover:text-foreground"
            onClick={() => setShowReply(false)}
          >
            ×
          </button>
          <div className="whitespace-pre-wrap break-words pr-4">
            {reply || (isRunning ? "…" : "")}
          </div>
        </div>
      ) : null}
      <div className="flex items-end gap-2 rounded-xl border border-border bg-background/95 p-2 shadow-lg backdrop-blur">
        <textarea
          aria-label="Message the chat"
          data-fullscreen-chat="true"
          rows={1}
          value={text}
          placeholder="Message the chat…"
          onChange={(event) => edit(event.currentTarget.value)}
          onKeyDown={onKeyDown}
          className={cn(
            "max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-ui-13 outline-none",
            "placeholder:text-muted-foreground",
          )}
        />
        {isRunning ? (
          <Button
            size="sm"
            variant="outline"
            aria-label="Stop the reply"
            onClick={() => aui.thread().cancelRun()}
          >
            Stop
          </Button>
        ) : (
          <Button
            size="sm"
            aria-label="Send to the chat"
            disabled={!text.trim()}
            onClick={send}
          >
            Send
          </Button>
        )}
      </div>
    </div>
  );
}
