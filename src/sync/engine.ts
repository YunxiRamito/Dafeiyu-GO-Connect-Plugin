import { readFile, readdir, rename as renamePath, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ConnectionProvider, FileSnapshot, QueueItem, SyncChange, WorkspaceSyncConfig } from "./types.ts";
import { SyncError, type ConnectionState } from "./types.ts";
import { assertPathAllowed, resolveWorkspacePath } from "./path-filter.ts";
import { chunkBuffer, chunkCount, sha256Bytes, snapshotFile } from "./hash.ts";
import { newQueueItem, TransferStateMachine } from "./transfer.ts";
import { SyncQueue } from "./queue.ts";

export function assertSyncReady(state: ConnectionState, operation = "同步"): string {
  if (!state.serverConnected) throw new SyncError("launcher_not_connected", `${operation}需要启动器连接 Aries。`, { retryable: true });
  if (state.pairingStatus !== "paired" || !state.groupId) throw new SyncError("pairing_incomplete", `${operation}需要当前配对关系已完成。`);
  if (!state.localDevice?.id) throw new SyncError("local_device_unavailable", "启动器未提供本机设备身份。", { retryable: true });
  return state.groupId;
}

export function assertSameGroup(expectedGroupId: string, actualGroupId: string | null | undefined): void {
  if (!actualGroupId || expectedGroupId !== actualGroupId) throw new SyncError("group_changed", "当前配对小组已变化，已停止处理旧队列。", { details: { expectedGroupId, actualGroupId } });
}

export function deterministicIdempotencyKey(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex");
}

export async function scanWorkspace(config: Pick<WorkspaceSyncConfig, "root" | "ignoreRules">): Promise<FileSnapshot[]> {
  const result: FileSnapshot[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { throw new SyncError("workspace_read_failed", `无法读取工作区目录：${directory}`, { retryable: true, details: error }); }
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const decision = (() => { try { return assertPathAllowed(relativePath, config); } catch { return null; } })();
      if (!decision) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath, decision);
      else if (entry.isFile()) result.push(await snapshotFile(fullPath, decision));
    }
  }
  await visit(path.resolve(config.root), "");
  return result.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function detectRenames(changes: SyncChange[]): SyncChange[] {
  const deletes = changes.filter((change) => change.kind === "delete");
  const creates = changes.filter((change) => change.kind === "create" && change.snapshot);
  const consumed = new Set<SyncChange>();
  const output: SyncChange[] = [];
  for (const deletion of deletes) {
    const match = creates.find((creation) => !consumed.has(creation) && creation.snapshot?.sha256 === (deletion as { snapshot?: FileSnapshot }).snapshot?.sha256);
    if (match && match.snapshot) {
      consumed.add(match);
      output.push({ kind: "rename", from: deletion.path, path: match.path, source: match.source, snapshot: match.snapshot });
    } else output.push(deletion);
  }
  for (const change of changes) if (!consumed.has(change) && !(change.kind === "delete" && output.some((item) => item.kind === "rename" && item.from === change.path))) output.push(change);
  return output;
}

export function planSyncChanges(base: readonly FileSnapshot[], local: readonly FileSnapshot[], remote: readonly FileSnapshot[], conflictPolicy: WorkspaceSyncConfig["conflictPolicy"]): SyncChange[] {
  const baseMap = new Map(base.map((item) => [item.relativePath, item]));
  const localMap = new Map(local.map((item) => [item.relativePath, item]));
  const remoteMap = new Map(remote.map((item) => [item.relativePath, item]));
  const paths = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);
  const changes: SyncChange[] = [];
  for (const relativePath of [...paths].sort()) {
    const before = baseMap.get(relativePath);
    const localItem = localMap.get(relativePath);
    const remoteItem = remoteMap.get(relativePath);
    const localChanged = JSON.stringify(localItem ?? null) !== JSON.stringify(before ?? null);
    const remoteChanged = JSON.stringify(remoteItem ?? null) !== JSON.stringify(before ?? null);
    if (!localChanged && !remoteChanged) continue;
    if (localChanged && !remoteChanged) {
      changes.push(localItem ? { kind: before ? "update" : "create", path: relativePath, source: "local", snapshot: localItem } : { kind: "delete", path: relativePath, source: "local", snapshot: before });
      continue;
    }
    if (!localChanged && remoteChanged) {
      changes.push(remoteItem ? { kind: before ? "update" : "create", path: relativePath, source: "remote", snapshot: remoteItem } : { kind: "delete", path: relativePath, source: "remote", snapshot: before });
      continue;
    }
    if (localItem?.sha256 === remoteItem?.sha256) continue;
    if (localItem && remoteItem) {
      if (conflictPolicy === "prefer-local") changes.push({ kind: "update", path: relativePath, source: "local", snapshot: localItem });
      else if (conflictPolicy === "prefer-remote") changes.push({ kind: "update", path: relativePath, source: "remote", snapshot: remoteItem });
      else changes.push({ kind: "conflict", path: relativePath, local: localItem, remote: remoteItem, resolution: conflictPolicy });
    } else changes.push({ kind: "conflict", path: relativePath, local: localItem ?? { relativePath, sha256: "", sizeBytes: 0 }, remote: remoteItem ?? { relativePath, sha256: "", sizeBytes: 0 }, resolution: conflictPolicy });
  }
  return detectRenames(changes);
}

export async function withRetry<T>(operation: (attempt: number) => Promise<T>, options: { maxRetries: number; delayMs: number; signal?: AbortSignal }): Promise<T> {
  let attempt = 0;
  while (true) {
    if (options.signal?.aborted) throw new SyncError("cancelled", "同步操作已取消。");
    try { return await operation(attempt); }
    catch (error) {
      if (options.signal?.aborted) throw new SyncError("cancelled", "同步操作已取消。");
      const code = error instanceof SyncError ? error.code : (error as NodeJS.ErrnoException)?.code;
      const retryable = error instanceof SyncError ? error.retryable : ["ETIMEDOUT", "ECONNRESET", "EPIPE", "ENETUNREACH", "EAI_AGAIN"].includes(String(code));
      if (!retryable || attempt >= options.maxRetries) throw error;
      const delay = options.delayMs * (2 ** attempt);
      await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, delay); options.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new SyncError("cancelled", "同步操作已取消。")); }, { once: true }); });
      attempt += 1;
    }
  }
}

export class WorkspaceSynchronizer {
  private readonly provider: ConnectionProvider;
  private readonly config: WorkspaceSyncConfig;
  private readonly queue: SyncQueue;
  private activeGroupId: string | null = null;
  constructor(provider: ConnectionProvider, config: WorkspaceSyncConfig, queue: SyncQueue) { this.provider = provider; this.config = config; this.queue = queue; }

  async restoreQueue(): Promise<readonly QueueItem[]> { return this.queue.restore(); }

  async uploadFile(relativePathInput: string, signal?: AbortSignal): Promise<QueueItem> {
    if (!this.config.enabled) throw new SyncError("sync_disabled", "工作区同步当前已关闭。");
    const relativePath = assertPathAllowed(relativePathInput, this.config);
    const state = await this.provider.getConnectionState(signal);
    const groupId = assertSyncReady(state, "文件同步");
    if (this.activeGroupId && this.activeGroupId !== groupId) throw new SyncError("group_changed", "当前配对小组已变化，已停止处理旧队列。");
    this.activeGroupId = this.activeGroupId ?? groupId;
    const fullPath = resolveWorkspacePath(this.config.root, relativePath);
    let bytes: Uint8Array;
    try { bytes = await readFile(fullPath); } catch (error) { throw new SyncError("workspace_read_failed", `无法读取文件：${relativePath}`, { retryable: true, details: error }); }
    const sha256 = sha256Bytes(bytes);
    const totalChunks = chunkCount(bytes.byteLength, this.config.chunkSizeBytes);
    const id = deterministicIdempotencyKey([groupId, path.resolve(this.config.root), relativePath, sha256, String(bytes.byteLength), String(this.config.chunkSizeBytes)]).slice(0, 32);
    const existing = this.queue.get(id);
    if (existing) assertSameGroup(existing.groupId, groupId);
    const machine = new TransferStateMachine(existing ?? newQueueItem({ id, groupId, relativePath, sha256, sizeBytes: bytes.byteLength, chunkSizeBytes: this.config.chunkSizeBytes, totalChunks }));
    if (machine.snapshot().status === "completed") return machine.snapshot();
    if (["paused", "retry_wait"].includes(machine.snapshot().status)) machine.resume();
    if (machine.snapshot().status === "failed") machine.resetForRetry();
    await this.queue.upsert(machine.snapshot());
    assertSameGroup(groupId, (await this.provider.getConnectionState(signal)).groupId);
    if (machine.snapshot().status === "queued") await this.queue.upsert(machine.transition("creating"));
    const current = machine.snapshot();
    const created = current.fileId ? { fileId: current.fileId, groupId, totalChunks, chunkSizeBytes: this.config.chunkSizeBytes } : await withRetry(() => this.provider.createFileTransfer({ groupId, relativePath, sha256, sizeBytes: bytes.byteLength, chunkSizeBytes: this.config.chunkSizeBytes, targets: state.members.filter((member) => member.active && member.deviceId !== state.localDevice?.id).map((member) => member.deviceId), idempotencyKey: id, signal }), { maxRetries: this.config.maxRetries, delayMs: this.config.retryDelayMs, signal });
    if (!current.fileId) { machine.markCreated(created.fileId, created.receivedChunks ?? []); await this.queue.upsert(machine.snapshot()); }
    while (true) {
      const index = machine.nextMissingChunk();
      if (index === null) break;
      const chunk = chunkBuffer(bytes, this.config.chunkSizeBytes, index);
      try {
        await withRetry(() => this.provider.uploadFileChunk({ groupId, fileId: machine.snapshot().fileId!, chunkIndex: index, bytes: chunk, idempotencyKey: `${id}:${index}`, signal }), { maxRetries: this.config.maxRetries, delayMs: this.config.retryDelayMs, signal });
        machine.markChunkUploaded(index);
        await this.queue.upsert(machine.snapshot());
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === "ENOSPC" || (error instanceof SyncError && error.code === "disk_space_insufficient")) machine.fail({ code: "disk_space_insufficient", message: "磁盘空间不足，队列已暂停。" });
        else if (error instanceof SyncError && error.code === "cancelled") machine.pause();
        else machine.markRetry({ code: String(code ?? "transfer_failed"), message: error instanceof Error ? error.message : String(error) });
        await this.queue.upsert(machine.snapshot());
        throw error;
      }
    }
    await withRetry(() => this.provider.completeFileTransfer({ groupId, fileId: machine.snapshot().fileId!, idempotencyKey: `${id}:complete`, signal }), { maxRetries: this.config.maxRetries, delayMs: this.config.retryDelayMs, signal });
    machine.markCompleted();
    await this.queue.upsert(machine.snapshot());
    return machine.snapshot();
  }

  async applyLocalDelete(relativePathInput: string, signal?: AbortSignal): Promise<void> {
    const relativePath = assertPathAllowed(relativePathInput, this.config);
    const fullPath = resolveWorkspacePath(this.config.root, relativePath);
    try { await rm(fullPath, { force: true }); } catch (error) { throw new SyncError("workspace_write_failed", `无法删除文件：${relativePath}`, { retryable: true, details: error }); }
    void signal;
  }

  async applyLocalRename(fromInput: string, toInput: string, signal?: AbortSignal): Promise<void> {
    const from = assertPathAllowed(fromInput, this.config);
    const to = assertPathAllowed(toInput, this.config);
    if (signal?.aborted) throw new SyncError("cancelled", "同步操作已取消。");
    try { await mkdir(path.dirname(resolveWorkspacePath(this.config.root, to)), { recursive: true }); await renamePath(resolveWorkspacePath(this.config.root, from), resolveWorkspacePath(this.config.root, to)); }
    catch (error) { throw new SyncError("workspace_write_failed", `无法重命名文件：${from} -> ${to}`, { retryable: true, details: error }); }
  }

  async writeDownloadedFile(relativePathInput: string, bytes: Uint8Array, expectedSha256: string, signal?: AbortSignal): Promise<void> {
    const relativePath = assertPathAllowed(relativePathInput, this.config);
    if (signal?.aborted) throw new SyncError("cancelled", "同步操作已取消。");
    if (sha256Bytes(bytes) !== expectedSha256) throw new SyncError("hash_mismatch", `远端文件校验失败：${relativePath}`);
    const fullPath = resolveWorkspacePath(this.config.root, relativePath);
    const temporaryRoot = path.join(this.config.root, "Temp");
    const temporaryPath = path.join(temporaryRoot, `.dafeiyu-sync-${randomUUID()}.part`);
    try {
      await mkdir(path.dirname(fullPath), { recursive: true });
      await mkdir(temporaryRoot, { recursive: true });
      await writeFile(temporaryPath, bytes, { flag: "wx" });
      if (sha256Bytes(new Uint8Array(await readFile(temporaryPath))) !== expectedSha256) {
        throw new SyncError("hash_mismatch", `临时文件校验失败：${relativePath}`);
      }
      // Keep the staging file in the selected workspace's Temp directory, then
      // replace the destination only after the complete payload is verified.
      await rm(fullPath, { force: true });
      await renamePath(temporaryPath, fullPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (error instanceof SyncError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOSPC") throw new SyncError("disk_space_insufficient", "磁盘空间不足，远端文件未写入。", { details: error });
      throw new SyncError("workspace_write_failed", `无法原子写入文件：${relativePath}`, { retryable: true, details: error });
    }
  }
}












