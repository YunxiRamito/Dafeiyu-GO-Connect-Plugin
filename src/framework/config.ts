export const DEFAULT_IGNORE_RULES = Object.freeze([
  'node_modules', '.git', '.cache', 'dist', 'build', '*.log', '*.tmp', 'secrets',
  '*.key', '*.pem', '*.p12', '*.pfx', '*.env', '.env', 'cookies', 'tokens', 'credentials',
])

export type SyncMode = 'manual' | 'watch'
export type ConflictPolicy = 'ask' | 'keep_local' | 'keep_remote' | 'keep_both'

export interface WorkspaceSyncConfig {
  enabled: boolean
  /** DSH metadata/live conversations never traverse or transfer workspace files. */
  kind: 'dsh' | 'files'
  dshHome: string | null
  root: string | null
  mode: SyncMode
  conflictPolicy: ConflictPolicy
  ignoreRules: readonly string[]
}

export interface BroadcastConfig {
  enabled: boolean
  allowLocalHttp: boolean
  includeSelection: boolean
  receivePaused: boolean
  muted: boolean
  maxTitleLength: number
  maxSelectionLength: number
  maxMessageLength: number
}

export interface PluginConfig {
  workspaceSync: WorkspaceSyncConfig
  broadcast: BroadcastConfig
  limits: {
    maxFileBytes: number
    maxConcurrentUploads: number
    maxQueuedTasks: number
    chunkBytes: number
    requestTimeoutMs: number
    retryAttempts: number
  }
}

export function createDefaultConfig(): PluginConfig {
  return {
    workspaceSync: {
      enabled: true,
      kind: 'dsh',
      dshHome: null,
      root: null,
      mode: 'manual',
      conflictPolicy: 'ask',
      ignoreRules: [...DEFAULT_IGNORE_RULES],
    },
    broadcast: {
      enabled: true,
      allowLocalHttp: false,
      includeSelection: false,
      receivePaused: false,
      muted: false,
      maxTitleLength: 240,
      maxSelectionLength: 4000,
      maxMessageLength: 2000,
    },
    limits: {
      maxFileBytes: 256 * 1024 * 1024,
      maxConcurrentUploads: 2,
      maxQueuedTasks: 100,
      chunkBytes: 512 * 1024,
      requestTimeoutMs: 60_000,
      retryAttempts: 3,
    },
  }
}

export function mergeConfig(input: Partial<PluginConfig> | undefined): PluginConfig {
  const defaults = createDefaultConfig()
  const value = input ?? {}
  return {
    ...defaults,
    ...value,
    workspaceSync: {
      ...defaults.workspaceSync,
      ...(value.workspaceSync ?? {}),
      // Keep the old explicit file-transfer API opt-in; native preferences
      // migrate separately and must never turn DSH_HOME into a file root.
      kind: value.workspaceSync?.kind ?? (value.workspaceSync?.root ? 'files' : defaults.workspaceSync.kind),
      ignoreRules: [...(value.workspaceSync?.ignoreRules ?? defaults.workspaceSync.ignoreRules)],
    },
    broadcast: { ...defaults.broadcast, ...(value.broadcast ?? {}) },
    limits: { ...defaults.limits, ...(value.limits ?? {}) },
  }
}
