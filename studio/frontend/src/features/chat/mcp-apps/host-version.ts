// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

// The version Studio tells a widget it is hosted by (hostInfo.version, and the user agent
// in the host context): Studio's own release, as the existing /api/health reports it
// (`studio_version`, authed callers only). Not the frontend package's version, which is a
// placeholder. Until that answers, or when it cannot be had, "dev" -- the backend's own
// word for a build with no release version.

import { getAuthToken } from "@/features/auth";
import { apiUrl } from "@/lib/api-base";

const UNKNOWN_VERSION = "dev";

let known: string | null = null;
let pending: Promise<string> | null = null;

export function getHostVersion(): string {
  return known ?? UNKNOWN_VERSION;
}

/** Ask once; a failed ask is not cached, so a later widget tries again. */
export function loadHostVersion(): Promise<string> {
  if (known) return Promise.resolve(known);
  pending ??= (async () => {
    try {
      const token = getAuthToken();
      const res = await fetch(apiUrl("/api/health"), {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (res.ok) {
        const data = (await res.json()) as { studio_version?: unknown };
        const version = data.studio_version;
        if (typeof version === "string" && version.trim()) {
          known = version.trim();
        }
      }
    } catch {
      // Offline or unauthenticated: the widget gets the placeholder.
    }
    pending = null;
    return getHostVersion();
  })();
  return pending;
}
