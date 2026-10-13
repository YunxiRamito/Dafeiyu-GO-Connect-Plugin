import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
                                            
import { SyncError } from "./types.js";

                             
                               
                                                   
 

export class MemoryQueueStore                       {
          items              = [];
  async load()                       { return this.items.map((item) => ({ ...item, uploadedChunks: [...item.uploadedChunks] })); }
  async save(items                      )                { this.items = items.map((item) => ({ ...item, uploadedChunks: [...item.uploadedChunks] })); }
}

export class JsonQueueStore                       {
           queuePath        ;
           tempDirectory        ;
  constructor(queuePath = path.resolve(process.cwd(), "Temp", "sync-queue.json"), tempDirectory = path.resolve(process.cwd(), "Temp")) {
    this.queuePath = path.resolve(queuePath);
    this.tempDirectory = path.resolve(tempDirectory);
  }
  async load()                       {
    try {
      const text = await readFile(this.queuePath, "utf8");
      const parsed = JSON.parse(text)           ;
      if (!Array.isArray(parsed)) throw new Error("not_array");
      return parsed               ;
    } catch (error) {
      if ((error                         ).code === "ENOENT") return [];
      if (error instanceof SyntaxError) throw new SyncError("queue_corrupt", "同步队列文件无法解析。");
      throw error;
    }
  }
  async save(items                      )                {
    await mkdir(path.dirname(this.queuePath), { recursive: true });
    await mkdir(this.tempDirectory, { recursive: true });
    const temporary = path.join(this.tempDirectory, `sync-queue-${process.pid}-${Date.now()}.tmp`);
    await writeFile(temporary, JSON.stringify(items, null, 2), { encoding: "utf8", mode: 0o600 });
    try { await rename(temporary, this.queuePath); }
    catch (error) { throw new SyncError("queue_persist_failed", "同步队列无法持久化。", { retryable: true, details: error }); }
  }
}

export class SyncQueue {
          items = new Map                   ();
          loaded = false;
                   store            ;
  constructor(store            ) { this.store = store; }

  async restore()                                {
    const items = await this.store.load();
    this.items = new Map(items.map((item) => [item.id, item]));
    this.loaded = true;
    return this.list();
  }
  async upsert(item           )                { this.ensureLoaded(); this.items.set(item.id, item); await this.persist(); }
  async remove(id        )                { this.ensureLoaded(); this.items.delete(id); await this.persist(); }
  get(id        )                        { this.ensureLoaded(); return this.items.get(id); }
  list(groupId         )              { this.ensureLoaded(); return [...this.items.values()].filter((item) => !groupId || item.groupId === groupId).map((item) => ({ ...item, uploadedChunks: [...item.uploadedChunks] })); }
  async clearGroup(groupId        )                { this.ensureLoaded(); for (const [id, item] of this.items) if (item.groupId === groupId) this.items.delete(id); await this.persist(); }
          ensureLoaded()       { if (!this.loaded) throw new SyncError("queue_not_restored", "同步队列尚未恢复。"); }
          async persist()                { await this.store.save([...this.items.values()]); }
}



