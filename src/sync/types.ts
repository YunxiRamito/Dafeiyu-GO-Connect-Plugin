/** Public, secret-free connection and sync contracts for the launcher IPC adapter. */

export const CONNECTION_PROTOCOL = "dafeiyu-go.connection.v1" as const;

export type PairingStatus = "paired" | "unpaired" | "awaiting_approval" | "unknown" | "disconnected";
export type PresenceStatus = "online" | "offline" | "unknown";
export type SyncMode = "manual" | "watch";
export type ConflictPolicy = "ask" | "prefer-local" | "prefer-remote" | "keep-both";
export type TransferStatus =
  | "queued"
  | "creating"
  | "uploading"
  | "paused"
  | "retry_wait"
  | "completed"
  | "failed"
  | "cancelled";

export interface GroupMember {
  deviceId: string;
  publicKey?: string;
  role?: string;
  active: boolean;
  joinedAt?: string;
  presence?: PresenceStatus;
  lastSeenAt?: string;
}

export interface ConnectionCapabilities {
  workspaceSync: boolean;
  webBroadcast: boolean;
  encryptedMessages: boolean;
  encryptedFiles: boolean;
  presence: boolean;
  fileCacheCleanup: boolean;
}

export interface ConnectionState {
  protocol: typeof CONNECTION_PROTOCOL;
  serverConnected: boolean;
  groupId: string | null;
  pairingStatus: PairingStatus;
  localDevice: { id: string; name?: string; publicKey?: string } | null;
  members: readonly GroupMember[];
  remotePresence: PresenceStatus;
  capabilities: ConnectionCapabilities;
  lastError?: { code: string; message: string };
}

export interface GroupScopedRequest {
  groupId: string;
  signal?: AbortSignal;
}

export interface EncryptedMessage {
  id: string;
  groupId: string;
  senderId: string;
  ciphertext: string;
  createdAt: string;
}

export interface RemoteFileEntry {
  groupId: string;
  fileId: string;
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  mtimeMs?: number;
  state?: "available" | "uploading" | "logically_deleted" | "cleanup_pending";
  senderId?: string;
}

export interface IncomingTransfer extends RemoteFileEntry {
  chunkSizeBytes: number;
  totalChunks: number;
  receivedChunks?: readonly number[];
  acknowledged?: boolean;
}

export interface CreateFileTransferRequest extends GroupScopedRequest {
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  chunkSizeBytes: number;
  encryptedMetadata?: string;
  targets: readonly string[];
  idempotencyKey: string;
}

export interface CreateFileTransferResult {
  fileId: string;
  groupId: string;
  totalChunks: number;
  chunkSizeBytes: number;
  receivedChunks?: readonly number[];
}

export interface UploadFileChunkRequest extends GroupScopedRequest {
  fileId: string;
  chunkIndex: number;
  bytes: Uint8Array;
  idempotencyKey: string;
}

export interface CompleteFileTransferRequest extends GroupScopedRequest {
  fileId: string;
  idempotencyKey: string;
}

export interface DownloadFileChunkRequest extends GroupScopedRequest {
  fileId: string;
  chunkIndex: number;
}

export interface CleanupRequest extends GroupScopedRequest {
  fileIds: readonly string[];
  idempotencyKey: string;
}

export interface CacheStats {
  groupId: string;
  uploading: number;
  available: number;
  cleanupPending: number;
  logicalDeleted: number;
  physicalBytes: number;
}

export interface CacheCleanupResult {
  groupId: string;
  requested: number;
  logicalDeleted: number;
  alreadyDeleted: number;
  cleanupPending: number;
  physicalCleanupComplete: boolean;
  idempotencyKey: string;
}

export interface ConnectionProvider {
  getConnectionState(signal?: AbortSignal): Promise<ConnectionState>;
  subscribeConnectionState?(listener: (state: ConnectionState) => void): () => void;
  sendEncryptedMessage?(request: {
    groupId: string;
    ciphertext: string;
    idempotencyKey: string;
    signal?: AbortSignal;
  }): Promise<EncryptedMessage>;
  listRemoteFiles?(request: GroupScopedRequest): Promise<readonly RemoteFileEntry[]>;
  listIncomingFileTransfers(request: GroupScopedRequest): Promise<readonly IncomingTransfer[]>;
  createFileTransfer(request: CreateFileTransferRequest): Promise<CreateFileTransferResult>;
  uploadFileChunk(request: UploadFileChunkRequest): Promise<void>;
  completeFileTransfer(request: CompleteFileTransferRequest): Promise<void>;
  downloadFileChunk(request: DownloadFileChunkRequest): Promise<Uint8Array>;
  acknowledgeFileTransfer(request: GroupScopedRequest & { fileId: string; idempotencyKey: string }): Promise<void>;
  getGroupFileCacheStats(request: GroupScopedRequest): Promise<CacheStats>;
  cleanupGroupFileCache(request: CleanupRequest): Promise<CacheCleanupResult>;
}

export interface LauncherConnectionProvider extends ConnectionProvider {
  readonly kind: "launcher-ipc";
}

export interface MockConnectionProvider extends ConnectionProvider {
  readonly kind: "mock";
}

export interface WorkspaceSyncConfig {
  enabled: boolean;
  root: string;
  mode: SyncMode;
  conflictPolicy: ConflictPolicy;
  ignoreRules: readonly string[];
  chunkSizeBytes: number;
  maxRetries: number;
  retryDelayMs: number;
}

export interface QueueItem {
  id: string;
  groupId: string;
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  chunkSizeBytes: number;
  totalChunks: number;
  uploadedChunks: number[];
  status: TransferStatus;
  retryCount: number;
  fileId?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FileSnapshot {
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  mtimeMs?: number;
}

export type SyncChange =
  | { kind: "create" | "update" | "delete"; path: string; source: "local" | "remote"; snapshot?: FileSnapshot }
  | { kind: "rename"; from: string; path: string; source: "local" | "remote"; snapshot: FileSnapshot }
  | { kind: "conflict"; path: string; local: FileSnapshot; remote: FileSnapshot; resolution: ConflictPolicy };

export class SyncError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(code: string, message: string, options: { retryable?: boolean; details?: unknown } = {}) {
    super(message);
    this.name = "SyncError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function isSyncError(error: unknown): error is SyncError {
  return error instanceof SyncError;
}

