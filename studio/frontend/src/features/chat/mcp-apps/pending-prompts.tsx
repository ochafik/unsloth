// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"use client";

// Where the user answers a widget's requests. The widget is untrusted HTML: it runs a
// tool that needs approval, speaks as the user in the chat, or opens a link only with
// the user's say-so. Each ask is a promise the bridge's handler awaits; the prompt
// itself is shown under the frame (or inside the fullscreen container, since nothing
// outside the top layer can be seen there).

import { Button } from "@/components/ui/button";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { mcpAppArgsPreview } from "./tool-approval";

// A widget cannot stack prompts faster than they can be read.
export const MAX_PENDING_TOOL_CALLS = 8;

interface PendingToolCall {
  key: number;
  name: string;
  args: Record<string, unknown>;
  decide: (allow: boolean, always: boolean) => void;
}

interface PendingAsk {
  text: string;
  decide: (yes: boolean) => void;
}

/** What the bridge's handlers ask the user. A null means the widget has too many
 *  asks waiting already and must be refused rather than queued. */
export interface PromptController {
  askTool(name: string, args: Record<string, unknown>): Promise<boolean> | null;
  askMessage(text: string): Promise<boolean> | null;
  askLink(url: string): Promise<boolean> | null;
  /** The document that asked is gone: every ask still open is declined. */
  clear(): void;
}

export function usePendingPrompts(options: {
  /** "Always allow" was chosen for this tool name. */
  onAlwaysAllow: (toolName: string) => void;
}): { controller: PromptController; waiting: boolean; prompts: ReactNode } {
  const { onAlwaysAllow } = options;
  const [calls, setCalls] = useState<PendingToolCall[]>([]);
  const [message, setMessage] = useState<PendingAsk | null>(null);
  const [link, setLink] = useState<PendingAsk | null>(null);
  const callsRef = useRef(calls);
  callsRef.current = calls;
  const messageRef = useRef(message);
  messageRef.current = message;
  const linkRef = useRef(link);
  linkRef.current = link;
  const keyRef = useRef(0);
  const alwaysRef = useRef(onAlwaysAllow);
  alwaysRef.current = onAlwaysAllow;

  const controller = useMemo<PromptController>(
    () => ({
      askTool(name, args) {
        if (callsRef.current.length >= MAX_PENDING_TOOL_CALLS) return null;
        keyRef.current += 1;
        const key = keyRef.current;
        return new Promise<boolean>((resolve) => {
          const entry: PendingToolCall = {
            key,
            name,
            args,
            decide: (allow, always) => {
              if (allow && always) alwaysRef.current(name);
              resolve(allow);
            },
          };
          callsRef.current = [...callsRef.current, entry];
          setCalls(callsRef.current);
        });
      },
      askMessage(text) {
        if (messageRef.current) return null;
        return new Promise<boolean>((resolve) => {
          messageRef.current = { text, decide: resolve };
          setMessage(messageRef.current);
        });
      },
      askLink(url) {
        if (linkRef.current) return null;
        return new Promise<boolean>((resolve) => {
          linkRef.current = { text: url, decide: resolve };
          setLink(linkRef.current);
        });
      },
      clear() {
        for (const call of callsRef.current) call.decide(false, false);
        messageRef.current?.decide(false);
        linkRef.current?.decide(false);
        callsRef.current = [];
        messageRef.current = null;
        linkRef.current = null;
        setCalls([]);
        setMessage(null);
        setLink(null);
      },
    }),
    [],
  );

  const asking = calls[0];
  const answerTool = useCallback((allow: boolean, always = false) => {
    const current = callsRef.current[0];
    if (!current) return;
    callsRef.current = callsRef.current.filter((c) => c.key !== current.key);
    setCalls(callsRef.current);
    current.decide(allow, always);
  }, []);
  const answerMessage = (send: boolean) => {
    const pending = messageRef.current;
    if (!pending) return;
    messageRef.current = null;
    setMessage(null);
    pending.decide(send);
  };
  const answerLink = (open: boolean) => {
    const pending = linkRef.current;
    if (!pending) return;
    linkRef.current = null;
    setLink(null);
    pending.decide(open);
  };

  const askingArgs = asking ? mcpAppArgsPreview(asking.args) : "";
  const prompts = (
    <>
      {asking ? (
        <div
          role="group"
          aria-label="Tool request from this app"
          className="mt-1 rounded border border-border bg-muted/30 px-3 py-2 text-ui-12p5"
        >
          <div>
            This app wants to run{" "}
            <span className="font-mono">{asking.name}</span>
            {calls.length > 1 ? ` (+${calls.length - 1} more waiting)` : ""}
          </div>
          {askingArgs ? (
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all text-muted-foreground">
              {askingArgs}
            </pre>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button size="xs" onClick={() => answerTool(true)}>
              Allow
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => answerTool(true, true)}
            >
              Always allow
            </Button>
            <Button
              size="xs"
              variant="destructive"
              onClick={() => answerTool(false)}
            >
              Deny
            </Button>
          </div>
        </div>
      ) : null}
      {message ? (
        <div
          role="group"
          aria-label="Message from this app"
          className="mt-1 rounded border border-border bg-muted/30 px-3 py-2 text-ui-12p5"
        >
          <div>This app wants to send a message to the chat as you:</div>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
            {message.text}
          </pre>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button size="xs" onClick={() => answerMessage(true)}>
              Send
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => answerMessage(false)}
            >
              Don't send
            </Button>
          </div>
        </div>
      ) : null}
      {link ? (
        <div
          role="group"
          aria-label="Link from this app"
          className="mt-1 rounded border border-border bg-muted/30 px-3 py-2 text-ui-12p5"
        >
          <div>This app wants to open a link in your browser:</div>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all text-muted-foreground">
            {link.text}
          </pre>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button size="xs" onClick={() => answerLink(true)}>
              Open
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => answerLink(false)}
            >
              Don't open
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );

  return { controller, waiting: Boolean(asking || message || link), prompts };
}
