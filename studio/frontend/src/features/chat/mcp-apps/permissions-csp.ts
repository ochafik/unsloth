// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

// What a widget's template asks for -- outside hosts (CSP), Permission Policy
// features -- and where its sandbox proxy is served. No React, no store: node tests
// load this as is.

import { buildAllowAttribute } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpUiResource } from "../api/mcp-servers-api";

/** The outside hosts a template declared it will reach, for the user to see: the
 *  spec has the host warn when a UI requires external domain access. The local
 *  schemes (blob:, data:) reach nothing outside. */
export function externalDomains(
  csp: McpUiResource["ui"]["csp"] | undefined,
  blocked: readonly string[] = [],
): string[] {
  if (!csp) return [];
  const refused = new Set(blocked.map((d) => d.trim()));
  const all = [
    ...(csp.connectDomains ?? []),
    ...(csp.resourceDomains ?? []),
    ...(csp.frameDomains ?? []),
    ...(csp.baseUriDomains ?? []),
  ];
  const hosts = new Set<string>();
  for (const value of all) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || ["blob:", "data:"].includes(trimmed.toLowerCase()))
      continue;
    // The backend dropped it from the frame's policy: the app cannot reach it.
    if (refused.has(trimmed)) continue;
    hosts.add(trimmed.replace(/^[a-z]+:\/\//i, ""));
  }
  return [...hosts];
}

/** Declared hosts the host's policy refuses (private network, loopback on a remote
 *  server ...), as told by the backend that enforces it. */
export function blockedDomains(
  resource: Pick<McpUiResource, "blocked_domains"> | null | undefined,
): string[] {
  return (resource?.blocked_domains ?? []).filter(
    (d): d is string => typeof d === "string" && d.trim() !== "",
  );
}

export type Permissions = NonNullable<McpUiResource["ui"]["permissions"]>;

/** The Permission Policy `allow` value for what a template asked for: the SDK's mapping. */
export const allowAttribute: (permissions: Permissions | undefined) => string =
  buildAllowAttribute;

const PERMISSION_FEATURES: [keyof Permissions, string][] = [
  ["camera", "camera"],
  ["microphone", "microphone"],
  ["geolocation", "geolocation"],
  ["clipboardWrite", "clipboard-write"],
];

/** Whether this page holds a Permission Policy feature it could delegate. Studio's
 *  own header turns camera and geolocation off, and a grant the page does not hold
 *  would be advertised to the view and then refused by the browser. Browsers with
 *  no policy API are given the benefit of the doubt; the browser decides anyway. */
export function hostHoldsFeature(feature: string): boolean {
  const policy =
    (
      document as Document & {
        permissionsPolicy?: { allowsFeature?: (feature: string) => boolean };
        featurePolicy?: { allowsFeature?: (feature: string) => boolean };
      }
    ).permissionsPolicy ??
    (
      document as Document & {
        featurePolicy?: { allowsFeature?: (feature: string) => boolean };
      }
    ).featurePolicy;
  if (!policy || typeof policy.allowsFeature !== "function") return true;
  try {
    return policy.allowsFeature(feature);
  } catch {
    return false;
  }
}

/** The requested permissions this host can actually pass on. */
export function grantablePermissions(
  requested: Permissions | undefined,
  holds: (feature: string) => boolean,
): Permissions {
  const granted: Permissions = {};
  if (!requested || typeof requested !== "object") return granted;
  for (const [key, feature] of PERMISSION_FEATURES) {
    if (requested[key] && holds(feature)) granted[key] = {};
  }
  return granted;
}

/** The sandbox proxy's origin: the backend's own host on the server's sandbox
 *  port, or null when the page could not load it: the listener speaks plain
 *  HTTP, which a secure page may frame only on loopback. */
export function sandboxOriginFor(
  port: number,
  apiBase: string,
  page: { protocol: string; origin: string },
): string | null {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  let backend: URL;
  try {
    backend = new URL(apiBase || page.origin);
  } catch {
    return null;
  }
  if (backend.protocol !== "http:") return null;
  // Loopback is potentially trustworthy, so a secure page (the Windows desktop
  // app's https://tauri.localhost) may still frame it; nothing else over HTTP.
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(
    backend.hostname,
  );
  if (page.protocol === "https:" && !loopback) return null;
  const origin = `http://${backend.hostname}:${port}`;
  // Different by construction (another port), but never hand the view the host's.
  return origin === page.origin ? null : origin;
}
