import path from "node:path";
                                                                                
import { SyncError } from "./types.js";

export const DEFAULT_IGNORE_RULES = Object.freeze([
  "node_modules", ".git", ".cache", "dist", "build", "*.log", "*.tmp", "secrets",
  "*.key", "*.pem", "*.p12", "*.pfx", ".env", ".env.*", "cookies", "tokens", "credentials",
]);

const MODES = new Set          (["manual", "watch"]);
const CONFLICTS = new Set                (["ask", "prefer-local", "prefer-remote", "keep-both"]);

export function defaultSyncConfig(root = "")                      {
  return {
    enabled: false,
    root,
    mode: "manual",
    conflictPolicy: "ask",
    ignoreRules: [...DEFAULT_IGNORE_RULES],
    chunkSizeBytes: 1024 * 1024,
    maxRetries: 3,
    retryDelayMs: 250,
  };
}

export function readSyncConfig(input         , fallbackRoot = "")                      {
  const raw = (input && typeof input === "object" ? input : {})                           ;
  const value = {
    ...defaultSyncConfig(fallbackRoot),
    ...raw,
    ignoreRules: Array.isArray(raw.ignoreRules) ? raw.ignoreRules : DEFAULT_IGNORE_RULES,
  }                           ;
  if (typeof value.enabled !== "boolean") throw new SyncError("invalid_config", "workspaceSync.enabled 必须是布尔值。");
  if (typeof value.root !== "string" || value.root.trim() === "") throw new SyncError("invalid_config", "workspaceSync.root 不能为空。");
  if (typeof value.mode !== "string" || !MODES.has(value.mode            )) throw new SyncError("invalid_config", "workspaceSync.mode 不受支持。");
  if (typeof value.conflictPolicy !== "string" || !CONFLICTS.has(value.conflictPolicy                  )) throw new SyncError("invalid_config", "workspaceSync.conflictPolicy 不受支持。");
  if (!Array.isArray(value.ignoreRules) || value.ignoreRules.some((rule) => typeof rule !== "string" || !rule.trim())) throw new SyncError("invalid_config", "workspaceSync.ignoreRules 必须是非空字符串数组。");
  const chunkSize = Number(value.chunkSizeBytes);
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 4 * 1024 * 1024) throw new SyncError("invalid_config", "chunkSizeBytes 必须在 1 到 4 MiB 之间。");
  const maxRetries = Number(value.maxRetries);
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 20) throw new SyncError("invalid_config", "maxRetries 必须在 0 到 20 之间。");
  const retryDelayMs = Number(value.retryDelayMs);
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 60_000) throw new SyncError("invalid_config", "retryDelayMs 无效。");
  return {
    enabled: value.enabled           ,
    root: path.resolve(value.root          ),
    mode: value.mode            ,
    conflictPolicy: value.conflictPolicy                  ,
    ignoreRules: [...new Set((value.ignoreRules            ).map((rule) => rule.trim().replaceAll("\\", "/")))],
    chunkSizeBytes: chunkSize,
    maxRetries,
    retryDelayMs,
  };
}

export function mergeSyncConfig(base                     , patch         )                      {
  return readSyncConfig({ ...base, ...(patch && typeof patch === "object" ? patch : {}) }, base.root);
}

