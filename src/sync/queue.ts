import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { QueueItem } from "./types.ts";
import { SyncError } from "./types.ts";

export interface QueueStore {
  load(): Promise<QueueItem[]>;
  save(items: readonly QueueItem[]): Promise<void>;
}

export class MemoryQueueStore implements QueueStore {
  private items: QueueItem[] = [];
  async load(): Promise<QueueItem[]> { return this.items.map((item) => ({ ...item, uploadedChunks: [...item.uploadedChunks] })); }
  async save(items: readonly QueueItem[]): Promise<void> { this.items = items.map((item) => ({ ...item, uploadedChunks: [...item.uploadedChunks] })); }
}

export class JsonQueueStore implements QueueStore {
  readonly queuePath: string;
  readonly tempDirectory: string;
  constructor(queuePath = path.resolve(process.cwd(), "Temp", "sync-queue.json"), tempDirectory = path.resolve(process.cwd(), "Temp")) {
    this.queuePath = path.resolve(queuePath);
    this.tempDirectory = path.resolve(tempDirectory);
  }
  async load(): Promise<QueueItem[]> {
    try {
      const text = await readFile(this.queuePath, "utf8");
      const parsed = JSON.parse(text) as unknown;
      if (!Array.isArray(parsed)) throw new Error("not_array");
      return parsed as QueueItem[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      if (error instanceof SyntaxError) throw new SyncError("queue_corrupt", "同步队列文件无法解析。");
      throw error;
    }
  }
  async save(items: readonly QueueItem[]): Promise<void> {
    await mkdir(path.dirname(this.queuePath), { recursive: true });
    await mkdir(this.tempDirectory, { recursive: true });
    const temporary = path.join(this.tempDirectory, `sync-queue-${process.pid}-${Date.now()}.tmp`);
    await writeFile(temporary, JSON.stringify(items, null, 2), { encoding: "utf8", mode: 0o600 });
    try { await rename(temporary, this.queuePath); }
    catch (error) { throw new SyncError("queue_persist_failed", "同步队列无法持久化。", { retryable: true, details: error }); }
  }
}

export class SyncQueue {
  private items = new Map<string, QueueItem>();
  private loaded = false;
  private readonly store: QueueStore;
  constructor(store: QueueStore) { this.store = store; }

  async restore(): Promise<readonly QueueItem[]> {
    const items = await this.store.load();
    this.items = new Map(items.map((item) => [item.id, item]));
    this.loaded = true;
    return this.list();
  }
  async upsert(item: QueueItem): Promise<void> { this.ensureLoaded(); this.items.set(item.id, item); await this.persist(); }
  async remove(id: string): Promise<void> { this.ensureLoaded(); this.items.delete(id); await this.persist(); }
  get(id: string): QueueItem | undefined { this.ensureLoaded(); return this.items.get(id); }
  list(groupId?: string): QueueItem[] { this.ensureLoaded(); return [...this.items.values()].filter((item) => !groupId || item.groupId === groupId).map((item) => ({ ...item, uploadedChunks: [...item.uploadedChunks] })); }
  async clearGroup(groupId: string): Promise<void> { this.ensureLoaded(); for (const [id, item] of this.items) if (item.groupId === groupId) this.items.delete(id); await this.persist(); }
  private ensureLoaded(): void { if (!this.loaded) throw new SyncError("queue_not_restored", "同步队列尚未恢复。"); }
  private async persist(): Promise<void> { await this.store.save([...this.items.values()]); }
}



