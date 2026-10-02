// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"use client";

// Everything needed to make a widget's frame: the template, the sandbox origin it is
// served from, what it may be granted, the per-template bridge token and the seeded html.

import { apiUrl, getApiBase } from "@/lib/api-base";
import { useEffect, useMemo, useState } from "react";
import {
  getMcpAppSandboxPort,
  readMcpUiResource,
  type McpUiResource,
} from "../api/mcp-servers-api";
import {
  RESIZE_FALLBACK,
  bridgeShim,
  newBridgeToken,
  withBridgeShim,
} from "./bridge-shim";
import { loadHostVersion } from "./host-version";
import { cspFrameQuery } from "./mcp-ui";
import {
  allowAttribute,
  grantablePermissions,
  hostHoldsFeature,
  sandboxOriginFor,
} from "./permissions-csp";

export function useFrameSource(
  serverId: string,
  resourceUri: string,
  scope: { threadId?: string; sessionId?: string },
) {
  const { threadId, sessionId } = scope;
  const [resource, setResource] = useState<McpUiResource | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Studio's version is what the widget is told it is hosted by; the template fetch
    // below takes longer, so it is normally known by the time the bridge is made.
    void loadHostVersion();
    setResource(null);
    setError(null);
    readMcpUiResource(serverId, resourceUri, { threadId, sessionId })
      .then((loaded) => {
        if (!cancelled) setResource(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, resourceUri, threadId, sessionId]);

  // The server's sandbox origin: undefined while asking, null for the fallback.
  const [sandboxPort, setSandboxPort] = useState<number | null | undefined>(
    undefined,
  );
  // Set when the proxy never answered; the frame then uses the opaque shell.
  const [proxyFailed, setProxyFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setSandboxPort(undefined);
    setProxyFailed(false);
    getMcpAppSandboxPort(serverId)
      .then((port) => {
        if (!cancelled) setSandboxPort(port);
      })
      .catch(() => {
        if (!cancelled) setSandboxPort(null);
      });
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  const sandboxOrigin = useMemo(
    () =>
      typeof sandboxPort === "number" && !proxyFailed
        ? sandboxOriginFor(sandboxPort, getApiBase(), window.location)
        : null,
    [sandboxPort, proxyFailed],
  );

  // Only what the template asked for AND this page holds, and only behind the
  // proxy: an opaque origin cannot hold a Permission Policy grant worth making.
  const permissions = useMemo(
    () =>
      sandboxOrigin
        ? grantablePermissions(resource?.ui?.permissions, hostHoldsFeature)
        : {},
    [resource, sandboxOrigin],
  );
  const allow = allowAttribute(permissions);

  // The CSP is fixed at request time, so declared domains ride the URL.
  const src = useMemo(() => {
    if (!resource || sandboxPort === undefined) return null;
    const query = new URLSearchParams(cspFrameQuery(resource.ui?.csp));
    if (sandboxOrigin) query.set("host", window.location.origin);
    // Never put the auth token in the URL: in-frame code reads location.href.
    if (sandboxOrigin) return `${sandboxOrigin}/?${query.toString()}`;
    // The opaque fallback has no per-server listener: it is told which server this is,
    // and the backend decides from that server's stored row what may be declared.
    query.set("server_id", serverId);
    return apiUrl(`/api/inference/mcp-app-frame?${query.toString()}`);
  }, [resource, sandboxPort, sandboxOrigin, serverId]);

  // One token per fetched template, so re-seeding cannot be replayed either.
  const bridgeToken = useMemo(
    () => (resource ? newBridgeToken() : null),
    [resource],
  );

  const html = useMemo(
    () =>
      resource && bridgeToken
        ? withBridgeShim(
            `${resource.text}\n${RESIZE_FALLBACK}`,
            bridgeShim(bridgeToken, window.location.origin),
          )
        : null,
    [resource, bridgeToken],
  );

  const failure =
    error ??
    (resource && !bridgeToken
      ? "this browser has no Web Crypto to isolate it with"
      : null);

  return {
    resource,
    failure,
    sandboxOrigin,
    permissions,
    allow,
    src,
    html,
    bridgeToken,
    markProxyFailed: () => setProxyFailed(true),
  };
}
