import { classifyConnectionState, ConnectionPluginError } from './errors.ts'
import type { ConnectionProvider, ConnectionState } from './provider.ts'
import { PermissionSet } from './permissions.ts'
import { CacheCleanupCoordinator } from './cache-cleanup.ts'
import { createBroadcastPayload } from './broadcast.ts'

export interface CommandContext { args?: Record<string, unknown>; signal?: AbortSignal }
export type CommandHandler = (context: CommandContext) => Promise<unknown> | unknown
export interface CommandHost { register(command: { name: string; description: string; handler: CommandHandler }): void | (() => void) }

export function connectionProductStatus(state: ConnectionState): 'disabled' | 'waiting_for_connection' | 'waiting_for_launcher' | 'completed' | 'unknown' {
  if (!state.server_connected) return 'waiting_for_connection'
  if (state.pairing_status !== 'paired') return 'waiting_for_connection'
  const error = classifyConnectionState(state)
  if (error === 'presence_unknown' || error === 'remote_offline') return 'unknown'
  return 'completed'
}

export interface CommandRuntime {
  provider: ConnectionProvider; permissions: PermissionSet
  getConfig: () => { workspaceSync: { enabled: boolean; root?: string | null }; broadcast: { enabled: boolean; allowLocalHttp?: boolean; includeSelection?: boolean } }
  setConfig: (patch: any) => void | Promise<void>
  ready?: Promise<void>
  pause?: () => Promise<unknown>; resume?: () => Promise<unknown>
  setMuted?: (value: boolean) => Promise<unknown>
  getConflicts?: () => Promise<unknown>; getHistory?: () => Promise<unknown>; clearHistory?: () => Promise<unknown>
  syncNow?: (relative?: string, signal?: AbortSignal) => Promise<unknown>
  sendBroadcast?: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
}

export function registerConnectionCommands(host: CommandHost, runtime: CommandRuntime): () => void {
  const disposers: Array<() => void> = []
  const register = (name: string, description: string, handler: CommandHandler) => {
    const disposer = host.register({ name, description, handler: async context => { await runtime.ready; return handler(context) } })
    if (typeof disposer === 'function') disposers.push(disposer)
  }
  register('dsh connection status', '查看启动器连接、当前小组和远端 presence 状态', async ({ signal }) => {
    runtime.permissions.require('connection.read')
    try { const state = (await runtime.provider.get_connection_state({ signal })).data; return { status: connectionProductStatus(state), state } }
    catch (error) { if (error instanceof ConnectionPluginError) return { status: 'waiting_for_launcher', error_code: error.code, message: error.message }; throw error }
  })
  register('dsh connection sync enable', '启用工作区同步配置', async () => { runtime.permissions.require('workspace.read'); await runtime.setConfig({ workspaceSync: { enabled: true } }); return { enabled: true } })
  register('dsh connection sync disable', '停用工作区同步配置', async () => { runtime.permissions.require('workspace.read'); await runtime.setConfig({ workspaceSync: { enabled: false } }); return { enabled: false } })
  const unsupported = () => { throw new ConnectionPluginError('unsupported', 'Connection runtime is unavailable.') }
  register('dsh connection sync pause', '暂停工作区同步队列', () => runtime.pause ? runtime.pause() : unsupported())
  register('dsh connection sync resume', '恢复工作区同步队列', () => runtime.resume ? runtime.resume() : unsupported())
  register('dsh connection sync run', '同步明确选择的工作区或相对文件', ({ args, signal }) => runtime.syncNow ? runtime.syncNow(typeof args?.path === 'string' ? args.path : undefined, signal) : unsupported())
  register('dsh connection broadcast enable', '启用网页广播配置', async () => { runtime.permissions.require('broadcast.send'); await runtime.setConfig({ broadcast: { enabled: true } }); return { enabled: true } })
  register('dsh connection broadcast disable', '停用网页广播配置', async () => { runtime.permissions.require('broadcast.send'); await runtime.setConfig({ broadcast: { enabled: false } }); return { enabled: false } })
  register('dsh connection broadcast mute', '静音接收网页广播', () => runtime.setMuted ? runtime.setMuted(true) : unsupported())
  register('dsh connection broadcast resume', '恢复接收网页广播', () => runtime.setMuted ? runtime.setMuted(false) : unsupported())
  register('dsh connection sync set-root', '设置用户明确选择的工作区根目录', async ({ args }) => { runtime.permissions.require('workspace.read'); const root = args?.root; if (typeof root !== 'string' || !root.trim()) throw new ConnectionPluginError('validation_failed', '必须提供工作区根目录。'); await runtime.setConfig({ workspaceSync: { root } }); return { root } })
  register('dsh connection sync conflicts', '查看当前工作区冲突', () => runtime.getConflicts ? runtime.getConflicts() : unsupported())
  register('dsh connection sync cache', '查看当前小组文件缓存统计', async ({ signal }) => {
    runtime.permissions.require('connection.file.cache.read')
    const state = (await runtime.provider.get_connection_state({ signal })).data
    if (state.pairing_status !== 'paired' || !state.group_id) throw new ConnectionPluginError('pairing_incomplete', '当前没有可用的小组上下文。')
    return new CacheCleanupCoordinator(runtime.provider).stats(state.group_id, { signal })
  })
  register('dsh connection sync cache-clean', '清理当前小组文件缓存', async ({ args, signal }) => {
    runtime.permissions.require('connection.file.cache.cleanup')
    const fileIds = args?.file_ids
    if (!Array.isArray(fileIds) || fileIds.some(fileId => typeof fileId !== 'string')) throw new ConnectionPluginError('validation_failed', '必须提供 file_ids 字符串数组。')
    const state = (await runtime.provider.get_connection_state({ signal })).data
    if (state.pairing_status !== 'paired' || !state.group_id) throw new ConnectionPluginError('pairing_incomplete', '当前没有可用的小组上下文。')
    return new CacheCleanupCoordinator(runtime.provider).cleanup(state.group_id, fileIds, { signal })
  })
  register('dsh connection broadcast send', '发送安全网页广播', async ({ args, signal }) => {
    runtime.permissions.require('broadcast.send')
    if (!args || typeof args.url !== 'string') throw new ConnectionPluginError('validation_failed', '必须提供网页 URL。')
    if (runtime.sendBroadcast) return runtime.sendBroadcast(args, signal)
    if (!runtime.getConfig().broadcast.enabled) throw new ConnectionPluginError('permission_denied', 'Web broadcast is disabled.')
    const state = (await runtime.provider.get_connection_state({ signal })).data
    if (state.pairing_status !== 'paired' || !state.group_id) throw new ConnectionPluginError('pairing_incomplete', '当前没有可用的小组上下文。')
    const config = runtime.getConfig()
    const payload = createBroadcastPayload({
      url: args.url,
      title: typeof args.title === 'string' ? args.title : '',
      selection: typeof args.selection === 'string' ? args.selection : '',
      message: typeof args.message === 'string' ? args.message : '',
      sender_device_id: state.local_device.id,
    }, { allowLocalHttp: config.broadcast.allowLocalHttp, includeSelection: config.broadcast.includeSelection })
    return (await runtime.provider.send_encrypted_message({ group_id: state.group_id, kind: 'dsh_web_broadcast', body: payload }, { signal })).data
  })
  register('dsh connection broadcast history', '查看网页广播历史', () => runtime.getHistory ? runtime.getHistory() : unsupported())
  register('dsh connection broadcast clear-history', '清空网页广播历史', () => runtime.clearHistory ? runtime.clearHistory() : unsupported())
  return () => { for (const disposer of disposers.reverse()) disposer() }
}


