import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  DEFAULT_IGNORE_RULES, MemoryQueueStore, JsonQueueStore, SyncQueue, SyncError, TransferStateMachine,
  WorkspaceSynchronizer, activeMembers, assertSameGroup, assertSyncReady, cacheCleanupIdempotencyKey,
  CacheCleanupManager, chunkBuffer, chunkCount, createBroadcastPayload, BroadcastDeduplicator,
  defaultSyncConfig, isPathAllowed, isSensitivePath, planSyncChanges, readSyncConfig,
  remotePresenceLabel, sanitizeBroadcastUrl, sha256Bytes, withRetry,
} from "../../src/sync/index.ts";

const TEMP_ROOT = path.resolve(process.cwd(), "Temp");

function state(groupId: string | null = "grp-1", overrides: Record<string, unknown> = {}) {
  return {
    protocol: "dafeiyu-go.connection.v1",
    serverConnected: true,
    groupId,
    pairingStatus: groupId ? "paired" : "unpaired",
    localDevice: { id: "dev-local" },
    members: [{ deviceId: "dev-local", active: true }, { deviceId: "dev-a", active: true }, { deviceId: "dev-b", active: true }],
    remotePresence: "unknown",
    capabilities: { workspaceSync: true, webBroadcast: true, encryptedMessages: true, encryptedFiles: true, presence: true, fileCacheCleanup: true },
    ...overrides,
  };
}

class FakeProvider {
  kind = "mock" as const;
  currentState = state();
  created: any[] = [];
  chunks: any[] = [];
  completed: any[] = [];
  cleanups: any[] = [];
  failChunk = false;
  async getConnectionState() { return this.currentState; }
  async createFileTransfer(request: any) { this.created.push(request); return { fileId: `ft-${this.created.length}`, groupId: request.groupId, totalChunks: chunkCount(request.sizeBytes, request.chunkSizeBytes), chunkSizeBytes: request.chunkSizeBytes }; }
  async uploadFileChunk(request: any) { if (this.failChunk) throw new SyncError("disk_space_insufficient", "no space"); this.chunks.push(request); }
  async completeFileTransfer(request: any) { this.completed.push(request); }
  async listIncomingFileTransfers() { return []; }
  async downloadFileChunk() { return new Uint8Array(); }
  async acknowledgeFileTransfer() {}
  async getGroupFileCacheStats(request: any) { return { groupId: request.groupId, uploading: 0, available: 1, cleanupPending: 0, logicalDeleted: 0, physicalBytes: 12 }; }
  async cleanupGroupFileCache(request: any) { this.cleanups.push(request); return { groupId: request.groupId, requested: request.fileIds.length, logicalDeleted: request.fileIds.length, alreadyDeleted: 0, cleanupPending: 0, physicalCleanupComplete: true, idempotencyKey: request.idempotencyKey }; }
}

test("configuration defaults and validation", () => {
  const config = defaultSyncConfig("Temp/workspace");
  assert.equal(config.enabled, false);
  assert.ok(config.ignoreRules.includes("node_modules"));
  assert.deepEqual(readSyncConfig({ enabled: true, root: "Temp/workspace", ignoreRules: ["*.bak"] }).ignoreRules, ["*.bak"]);
  assert.throws(() => readSyncConfig({ root: "Temp/workspace", mode: "invalid" }), /mode/);
});

test("path filtering rejects traversal, sensitive files, and ignore rules", () => {
  for (const name of [".env", ".env.local", "private.key", "cert.pem", "identity.p12", "identity.pfx", "cookies", "tokens/access", "credentials/db.json"]) assert.equal(isSensitivePath(name), true, name);
  assert.equal(isPathAllowed("src/index.ts", DEFAULT_IGNORE_RULES).allowed, true);
  assert.equal(isPathAllowed("node_modules/a.js", DEFAULT_IGNORE_RULES).allowed, false);
  assert.throws(() => isPathAllowed("../outside.txt", []), /相对路径|越过/);
});

test("hash and chunk boundaries are deterministic", () => {
  const bytes = new TextEncoder().encode("abcdefghij");
  assert.equal(sha256Bytes(bytes), "72399361da6a7754fec986dca5b7cbaf1c810a28ded4abaf56b2106d06cb78b0");
  assert.equal(chunkCount(bytes.length, 4), 3);
  assert.deepEqual([...chunkBuffer(bytes, 4, 0)], [...new TextEncoder().encode("abcd")]);
  assert.deepEqual([...chunkBuffer(bytes, 4, 2)], [...new TextEncoder().encode("ij")]);
});

test("transfer state machine supports resume, retry, cancel, and completion", () => {
  const machine = new TransferStateMachine({ id: "q1", groupId: "grp-1", relativePath: "a.txt", sha256: "a", sizeBytes: 5, chunkSizeBytes: 2, totalChunks: 3, uploadedChunks: [], status: "queued", retryCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  machine.transition("creating"); machine.markCreated("ft-1", [1]);
  assert.equal(machine.nextMissingChunk(), 0); machine.markChunkUploaded(0); machine.markChunkUploaded(2); assert.equal(machine.markCompleted().status, "completed");
  const retry = new TransferStateMachine({ ...machine.snapshot(), id: "q2", status: "failed" }).markRetry({ code: "timeout", message: "retry" });
  assert.equal(retry.status, "retry_wait");
});

test("queue persists and restores items using Temp only", async () => {
  const directory = await mkdtemp(path.join(TEMP_ROOT, "sync-queue-test-"));
  const queuePath = path.join(directory, "queue.json");
  const queue = new SyncQueue(new JsonQueueStore(queuePath, directory)); await queue.restore();
  const item: any = { id: "q", groupId: "grp-1", relativePath: "a", sha256: "x", sizeBytes: 1, chunkSizeBytes: 1, totalChunks: 1, uploadedChunks: [], status: "queued", retryCount: 0, createdAt: "now", updatedAt: "now" };
  await queue.upsert(item); const restored = new SyncQueue(new JsonQueueStore(queuePath, directory)); assert.equal((await restored.restore())[0].groupId, "grp-1");
  await rm(directory, { recursive: true, force: true });
});

test("plan detects updates, renames, and conflicts without two-member assumptions", () => {
  const base: any[] = [{ relativePath: "old.txt", sha256: "same", sizeBytes: 4 }];
  const local: any[] = [{ relativePath: "new.txt", sha256: "same", sizeBytes: 4 }];
  const remote: any[] = [{ relativePath: "old.txt", sha256: "same", sizeBytes: 4 }];
  const rename = planSyncChanges(base, local, remote, "ask");
  assert.ok(rename.some((change) => change.kind === "rename"));
  const conflict = planSyncChanges([{ relativePath: "a", sha256: "base", sizeBytes: 1 }], [{ relativePath: "a", sha256: "local", sizeBytes: 1 }], [{ relativePath: "a", sha256: "remote", sizeBytes: 1 }], "ask");
  assert.equal(conflict[0].kind, "conflict");
  assert.equal(activeMembers(state().members).length, 3);
});

test("upload uses current group and every active member target", async () => {
  const directory = await mkdtemp(path.join(TEMP_ROOT, "sync-upload-test-"));
  await writeFile(path.join(directory, "file.txt"), "0123456789");
  const provider = new FakeProvider();
  const config = { ...defaultSyncConfig(directory), enabled: true, chunkSizeBytes: 4, retryDelayMs: 0 };
  const queue = new SyncQueue(new MemoryQueueStore()); const synchronizer = new WorkspaceSynchronizer(provider as any, config, queue); await synchronizer.restoreQueue();
  const result = await synchronizer.uploadFile("file.txt");
  assert.equal(result.status, "completed"); assert.deepEqual(provider.created[0].targets, ["dev-a", "dev-b"]); assert.equal(provider.chunks.length, 3); assert.equal(provider.completed.length, 1);
  provider.currentState = state("grp-2"); await assert.rejects(() => synchronizer.uploadFile("file.txt"), /小组|group/);
  await rm(directory, { recursive: true, force: true });
});

test("download verifies bytes and replaces the workspace file through Temp", async () => {
  const directory = await mkdtemp(path.join(TEMP_ROOT, "sync-atomic-test-"));
  await writeFile(path.join(directory, "file.txt"), "old");
  const synchronizer = new WorkspaceSynchronizer(new FakeProvider() as any, { ...defaultSyncConfig(directory), enabled: true }, new SyncQueue(new MemoryQueueStore()));
  const bytes = new TextEncoder().encode("new content");
  await synchronizer.writeDownloadedFile("file.txt", bytes, sha256Bytes(bytes));
  assert.equal(await readFile(path.join(directory, "file.txt"), "utf8"), "new content");
  const staging = await readdir(path.join(directory, "Temp")).catch(() => []);
  assert.equal(staging.filter((entry) => entry.endsWith(".part")).length, 0);
  await rm(directory, { recursive: true, force: true });
});
test("cancellation and disk exhaustion are explicit queue states", async () => {
  const controller = new AbortController(); controller.abort(); await assert.rejects(() => withRetry(async () => 1, { maxRetries: 2, delayMs: 0, signal: controller.signal }), /取消/);
  const directory = await mkdtemp(path.join(TEMP_ROOT, "sync-space-test-")); await writeFile(path.join(directory, "file.txt"), "1234"); const provider = new FakeProvider(); provider.failChunk = true;
  const config = { ...defaultSyncConfig(directory), enabled: true, chunkSizeBytes: 2, retryDelayMs: 0 }; const queue = new SyncQueue(new MemoryQueueStore()); const sync = new WorkspaceSynchronizer(provider as any, config, queue); await sync.restoreQueue(); await assert.rejects(() => sync.uploadFile("file.txt"), /no space/); assert.equal(queue.list()[0].status, "failed");
  await rm(directory, { recursive: true, force: true });
});

test("cache cleanup batches are bounded, group isolated, and retry with one key", async () => {
  const provider = new FakeProvider(); const cleaner = new CacheCleanupManager(provider as any, 2, 0); const result = await cleaner.cleanup("grp-1", ["ft-2", "ft-1", "ft-1"]); assert.equal(result.requested, 2); assert.equal(provider.cleanups[0].idempotencyKey, cacheCleanupIdempotencyKey("grp-1", ["ft-1", "ft-2"]));
  await assert.rejects(() => cleaner.cleanup("grp-2", ["ft-1"]), /小组|group/); await assert.rejects(() => cleaner.cleanup("grp-1", Array.from({ length: 101 }, (_, i) => `ft-${i}`)), /最多/);
});

test("broadcast URL and payload strip credentials, forbidden queries, HTML, and duplicates", () => {
  const url = sanitizeBroadcastUrl("https://user:pass@example.com/a?x=1&token=secret&session_id=bad"); assert.equal(url, "https://example.com/a?x=1");
  assert.throws(() => sanitizeBroadcastUrl("http://example.com"), /HTTPS/); assert.equal(sanitizeBroadcastUrl("http://localhost:123/a", { allowLocalHttp: true }), "http://localhost:123/a");
  const payload = createBroadcastPayload({ groupId: "grp-1", sourceDeviceId: "dev-a", title: "<b>Hello</b>", url, selectedText: "<script>alert(1)</script>safe" }); assert.equal(payload.title, "Hello"); assert.equal(payload.selectedText, "safe"); const dedupe = new BroadcastDeduplicator(); assert.equal(dedupe.accept(payload.messageId), true); assert.equal(dedupe.accept(payload.messageId), false);
});

test("status distinguishes launcher availability from remote presence", () => {
  assert.equal(assertSyncReady(state()).toString(), "grp-1"); assert.throws(() => assertSyncReady(state(null)), /配对/); assert.throws(() => assertSameGroup("grp-1", "grp-2"), /小组/); assert.equal(remotePresenceLabel({ serverConnected: true }), "unknown"); assert.equal(remotePresenceLabel({ serverConnected: false, presence: "online" }), "connection_unavailable");
});



