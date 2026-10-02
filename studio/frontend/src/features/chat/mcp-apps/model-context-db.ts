// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/** The IndexedDB store for MCP App context snapshots (model-context.ts), per account:
 *  the widgets' state as captured with each message, so a reload replays the same
 *  history. Registered by the chat adapter, the one place snapshots are read. */

import { accountDatabaseName } from "@/lib/account-transition";
import Dexie, { type EntityTable } from "dexie";
import {
  type McpAppContextSnapshot,
  setMcpAppContextStore,
} from "./model-context";

type SnapshotDb = Dexie & {
  snapshots: EntityTable<McpAppContextSnapshot, "messageId">;
};

let db: SnapshotDb | null = null;

function open(): SnapshotDb {
  if (!db) {
    db = new Dexie(accountDatabaseName("unsloth-mcp-app-context")) as SnapshotDb;
    db.version(1).stores({ snapshots: "messageId, createdAt" });
    db.version(2).stores({ snapshots: "messageId, createdAt, threadId" });
  }
  return db;
}

export function registerMcpAppContextDb(): void {
  if (typeof indexedDB === "undefined") return;
  setMcpAppContextStore({
    getMany: (messageIds) => open().snapshots.bulkGet([...messageIds]),
    put: async (snapshot) => {
      await open().snapshots.put(snapshot);
    },
    deleteForMessages: (messageIds) =>
      open().snapshots.bulkDelete([...messageIds]),
    deleteForThreads: async (threadIds) => {
      await open().snapshots.where("threadId").anyOf([...threadIds]).delete();
    },
  });
}
