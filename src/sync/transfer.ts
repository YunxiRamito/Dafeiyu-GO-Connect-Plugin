import type { QueueItem, TransferStatus } from "./types.ts";
import { SyncError } from "./types.ts";

const transitions: Record<TransferStatus, readonly TransferStatus[]> = {
  queued: ["creating", "paused", "cancelled", "failed"],
  creating: ["uploading", "retry_wait", "paused", "cancelled", "failed"],
  uploading: ["uploading", "completed", "retry_wait", "paused", "cancelled", "failed"],
  paused: ["queued", "uploading", "cancelled", "failed"],
  retry_wait: ["queued", "uploading", "paused", "cancelled", "failed"],
  completed: [],
  failed: ["queued", "paused", "cancelled"],
  cancelled: [],
};

function now(): string { return new Date().toISOString(); }

export class TransferStateMachine {
  private value: QueueItem;

  constructor(item: QueueItem) {
    if (!item.groupId || !item.id || item.totalChunks < 1) throw new SyncError("invalid_queue_item", "队列项缺少 group_id、id 或分块信息。");
    this.value = { ...item, uploadedChunks: [...new Set(item.uploadedChunks)].sort((a, b) => a - b) };
    this.assertInvariants();
  }

  snapshot(): QueueItem { return { ...this.value, uploadedChunks: [...this.value.uploadedChunks] }; }

  transition(status: TransferStatus, error?: { code: string; message: string }): QueueItem {
    if (status !== this.value.status && !transitions[this.value.status].includes(status)) throw new SyncError("invalid_transfer_transition", `${this.value.status} 不能转为 ${status}。`);
    this.value = { ...this.value, status, updatedAt: now(), errorCode: error?.code, errorMessage: error?.message };
    this.assertInvariants();
    return this.snapshot();
  }

  markCreated(fileId: string, receivedChunks: readonly number[] = []): QueueItem {
    if (!fileId) throw new SyncError("invalid_transfer", "服务端未返回 file_id。");
    if (this.value.status !== "creating" && this.value.status !== "queued" && this.value.status !== "retry_wait") throw new SyncError("invalid_transfer_transition", "当前状态不能创建传输。");
    this.value = { ...this.value, fileId, uploadedChunks: [...new Set([...this.value.uploadedChunks, ...receivedChunks])].sort((a, b) => a - b), status: "uploading", updatedAt: now() };
    this.assertInvariants();
    return this.snapshot();
  }

  markChunkUploaded(index: number): QueueItem {
    if (this.value.status !== "uploading") throw new SyncError("invalid_transfer_transition", "当前状态不能确认分块。");
    if (!Number.isInteger(index) || index < 0 || index >= this.value.totalChunks) throw new SyncError("invalid_chunk", "分块索引无效。");
    this.value = { ...this.value, uploadedChunks: [...new Set([...this.value.uploadedChunks, index])].sort((a, b) => a - b), updatedAt: now() };
    this.assertInvariants();
    return this.snapshot();
  }

  nextMissingChunk(): number | null {
    const done = new Set(this.value.uploadedChunks);
    for (let index = 0; index < this.value.totalChunks; index += 1) if (!done.has(index)) return index;
    return null;
  }

  markCompleted(): QueueItem {
    if (this.nextMissingChunk() !== null) throw new SyncError("chunks_incomplete", "仍有未上传的分块。");
    return this.transition("completed");
  }

  markRetry(error: { code: string; message: string }): QueueItem {
    this.value = { ...this.value, retryCount: this.value.retryCount + 1, status: "retry_wait", updatedAt: now(), errorCode: error.code, errorMessage: error.message };
    this.assertInvariants();
    return this.snapshot();
  }

  resetForRetry(): QueueItem { return this.transition("queued"); }
  pause(): QueueItem { return this.transition("paused"); }
  resume(): QueueItem { return this.transition(this.value.fileId ? "uploading" : "queued"); }
  cancel(): QueueItem { return this.transition("cancelled"); }
  fail(error: { code: string; message: string }): QueueItem { return this.transition("failed", error); }

  private assertInvariants(): void {
    if (this.value.uploadedChunks.some((index) => !Number.isInteger(index) || index < 0 || index >= this.value.totalChunks)) throw new SyncError("invalid_queue_item", "队列包含越界分块。");
    if (this.value.status === "completed" && this.nextMissingChunk() !== null) throw new SyncError("invalid_queue_item", "完成状态仍有缺失分块。");
  }
}

export function newQueueItem(input: Pick<QueueItem, "id" | "groupId" | "relativePath" | "sha256" | "sizeBytes" | "chunkSizeBytes" | "totalChunks">): QueueItem {
  const timestamp = now();
  return { ...input, uploadedChunks: [], status: "queued", retryCount: 0, createdAt: timestamp, updatedAt: timestamp };
}

