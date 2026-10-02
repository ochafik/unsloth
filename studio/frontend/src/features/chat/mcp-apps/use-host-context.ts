// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"use client";

// The host context a View is told about: theme, display mode, the room it is laid out
// in, the footprint of the host's own overlay. AppBridge diffs what it is given against
// what the View last heard and notifies only the difference, so this just hands it a
// fresh snapshot whenever one of those could have changed.

import { isTauri } from "@/lib/api-base";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

// What the host can show a View as. Fullscreen lifts the widget's own container
// into the top layer (a popover) in place: moving the iframe anywhere would reload it.
export type DisplayMode = "inline" | "fullscreen";
export const HOST_DISPLAY_MODES: readonly DisplayMode[] = [
  "inline",
  "fullscreen",
];
// The host's own bar above a fullscreen View, with the way back out.
export const FULLSCREEN_BAR_PX = 40;
// Past this a widget scrolls rather than pushing the conversation off screen.
export const MAX_HEIGHT = 900;

export const HOST_NAME = "Unsloth";

export function useHostContext(options: {
  holderRef: RefObject<HTMLDivElement | null>;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  theme: string;
  /** The View said `initialized`: only now may it be told anything. */
  ready: boolean;
  hostVersion: string;
  /** Hand the bridge a fresh snapshot. */
  push: (context: McpUiHostContext) => void;
}) {
  const { holderRef, iframeRef, theme, ready, hostVersion, push } = options;
  const [displayMode, setDisplayMode] = useState<DisplayMode>("inline");
  const displayModeRef = useRef(displayMode);
  displayModeRef.current = displayMode;
  // Set at once as well as in state, so what the host reports back to the View's
  // request is the mode it asked for and not the one still on screen.
  const changeDisplayMode = useCallback((mode: DisplayMode) => {
    displayModeRef.current = mode;
    setDisplayMode(mode);
  }, []);
  // The fullscreen overlay (chat bar, prompts), so its size can be reported to
  // the View as insets it should lay out around.
  const overlayRef = useRef<HTMLDivElement | null>(null);
  // Bumped when the room the View is laid out in changed size.
  const [layoutTick, setLayoutTick] = useState(0);
  const themeRef = useRef(theme);
  themeRef.current = theme;

  // Inline, the width is fixed and the height follows the View up to a cap;
  // fullscreen, both are fixed to what the frame is given.
  const containerDimensions = useCallback(() => {
    if (displayModeRef.current === "fullscreen") {
      const box = iframeRef.current?.getBoundingClientRect();
      return {
        width: Math.round(box?.width ?? window.innerWidth),
        height: Math.round(box?.height ?? window.innerHeight),
      };
    }
    const width = Math.round(
      holderRef.current?.getBoundingClientRect().width ?? 0,
    );
    return width > 0
      ? { width, maxHeight: MAX_HEIGHT }
      : { maxHeight: MAX_HEIGHT };
  }, [holderRef, iframeRef]);

  // The overlay's footprint, as insets: the host bar above, the floating chat
  // below. Measured when asked, not held in state, so a mode change always
  // reports the sizes as they are at that moment (the spec's safeAreaInsets).
  const insetsNow = useCallback(() => {
    if (displayModeRef.current !== "fullscreen") {
      return { top: 0, right: 0, bottom: 0, left: 0 };
    }
    return {
      top: FULLSCREEN_BAR_PX,
      right: 0,
      bottom:
        Math.round(overlayRef.current?.getBoundingClientRect().height ?? 0) +
        16,
      left: 0,
    };
  }, []);

  const hostContext = useCallback(
    (): McpUiHostContext => ({
      theme: themeRef.current === "dark" ? "dark" : "light",
      displayMode: displayModeRef.current,
      availableDisplayModes: [...HOST_DISPLAY_MODES],
      containerDimensions:
        containerDimensions() as McpUiHostContext["containerDimensions"],
      safeAreaInsets: insetsNow(),
      locale: typeof navigator === "undefined" ? "en" : navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      userAgent: `${HOST_NAME}/${hostVersion}`,
      platform: isTauri ? "desktop" : "web",
      deviceCapabilities: {
        touch: typeof window !== "undefined" && "ontouchstart" in window,
        hover:
          typeof window !== "undefined" &&
          window.matchMedia("(hover: hover)").matches,
      },
    }),
    [containerDimensions, insetsNow, hostVersion],
  );

  // The width the widget is laid out in: a window resize, a sidebar.
  useEffect(() => {
    const holder = holderRef.current;
    if (!holder || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setLayoutTick((n) => n + 1));
    observer.observe(holder);
    return () => observer.disconnect();
  }, [holderRef]);

  // The overlay grew or shrank (a reply opened, a prompt answered): the View hears
  // about the insets alone, mode and dimensions unchanged.
  useEffect(() => {
    const overlay = overlayRef.current;
    if (
      !overlay ||
      displayMode !== "fullscreen" ||
      typeof ResizeObserver === "undefined"
    ) {
      return;
    }
    const observer = new ResizeObserver(() => setLayoutTick((n) => n + 1));
    observer.observe(overlay);
    return () => observer.disconnect();
  }, [displayMode]);

  // Theme flips, mode changes (whoever made them: the View's own request, or the
  // user leaving fullscreen from the host's bar) and layout changes all reach the
  // View as host context. A frame later, so a mode change reports the box it landed in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: layoutTick and theme are triggers -- the snapshot is read when the frame runs
  useEffect(() => {
    if (!ready) return;
    const request = requestAnimationFrame(() => push(hostContext()));
    return () => cancelAnimationFrame(request);
  }, [ready, theme, displayMode, layoutTick, push, hostContext]);

  // Fullscreen: the container goes into the top layer where it is, above every
  // stacking context and transformed ancestor, without the iframe moving. Where the
  // browser has no popovers, fixed positioning does most of the same.
  useLayoutEffect(() => {
    const holder = holderRef.current;
    if (!holder || displayMode !== "fullscreen") return;
    const topLayer = typeof holder.showPopover === "function";
    if (topLayer) {
      holder.setAttribute("popover", "manual");
      holder.showPopover();
    }
    iframeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") changeDisplayMode("inline");
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (topLayer) {
        if (holder.matches(":popover-open")) holder.hidePopover();
        holder.removeAttribute("popover");
      }
    };
  }, [displayMode, holderRef, iframeRef, changeDisplayMode]);

  return {
    displayMode,
    displayModeRef,
    setDisplayMode: changeDisplayMode,
    overlayRef,
    hostContext,
  };
}
