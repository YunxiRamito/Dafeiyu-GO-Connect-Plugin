import { registerConnectionCommands, type CommandHost, type CommandRuntime } from './commands.ts'
import { PermissionSet, PLUGIN_PERMISSION_MANIFEST } from './permissions.ts'
import { UnavailableConnectionProvider, type ConnectionProvider } from './provider.ts'
import { ConnectionRuntime, type ConfigPatch } from './runtime.ts'
import { NodePipeTransport } from './node-transport.ts'
import { IpcConnectionProvider } from './launcher-provider.ts'
import { AndroidBridgeTransport, hasAndroidBridge } from './android-transport.ts'
import type { IpcTransport } from './ipc.ts'
import { RemoteDshClient } from './remote.ts'
import { RemoteDshHost, type RemoteDshHostAdapter } from './remote-host.ts'
import path from 'node:path'

export interface PluginOptions { provider?: ConnectionProvider; ipcTransport?: IpcTransport; config?: ConfigPatch; grantedPermissions?: Iterable<string>; home?: string; stateDirectory?: string; pollMs?: number; discoverIpc?: boolean; remoteHostAdapter?: RemoteDshHostAdapter }

export function createPlugin(options: PluginOptions = {}) {
  const android = hasAndroidBridge()
  const transport = !options.provider ? options.ipcTransport ??
    (options.discoverIpc ? android ? new AndroidBridgeTransport() : new NodePipeTransport() : undefined) : undefined
  const provider = options.provider ?? (transport ? new IpcConnectionProvider(transport,
    options.ipcTransport ? 'injected_ipc' : android ? 'android_abstract_socket' : 'named_pipe') : new UnavailableConnectionProvider())
  const permissions = new PermissionSet(options.grantedPermissions ?? PLUGIN_PERMISSION_MANIFEST.requested)
  const remoteHost = options.remoteHostAdapter ? new RemoteDshHost({ provider, adapter: options.remoteHostAdapter, permissions,
    stateDirectory: options.stateDirectory ? path.join(options.stateDirectory, 'remote-host') : options.home ? path.join(options.home, 'dafeiyu-connection-plugin', 'remote-host') : undefined }) : undefined
  const engine = new ConnectionRuntime({ ...options, provider, permissions, remoteHost })
  const remote = new RemoteDshClient(provider, permissions)
  const runtime: CommandRuntime = {
    provider,
    permissions,
    ready: engine.ready,
    getConfig: () => engine.getConfig(),
    setConfig: patch => engine.setConfig(patch),
    pause: () => engine.pause(), resume: () => engine.resume(),
    setMuted: value => engine.setMuted(value), getConflicts: () => engine.getConflicts(),
    getHistory: () => engine.getHistory(), clearHistory: () => engine.clearHistory(),
    syncNow: (relative, signal) => engine.syncNow(relative, signal),
    sendBroadcast: (args, signal) => engine.sendBroadcast(args, signal),
  }
  return {
    manifest: PLUGIN_PERMISSION_MANIFEST,
    provider,
    permissions,
    ready: engine.ready,
    runtime: engine,
    remote,
    remoteHost,
    getConfig: () => engine.getConfig(),
    updateConfig: (patch: ConfigPatch) => engine.setConfig(patch),
    dispose: async () => { (transport as IpcTransport & { dispose?: () => void })?.dispose?.(); await engine.dispose() },
    registerCommands: (host: CommandHost) => registerConnectionCommands(host, runtime),
  }
}

export { createDefaultConfig, mergeConfig } from './config.ts'
export * from './broadcast.ts'
export * from './cache-cleanup.ts'
export * from './commands.ts'
export * from './errors.ts'
export * from './ipc.ts'
export * from './path-policy.ts'
export * from './permissions.ts'
export * from './provider.ts'
export * from './transfer.ts'
export * from './node-transport.ts'
export * from './launcher-provider.ts'
export * from './sync-adapter.ts'
export * from './runtime.ts'
export * from './android-transport.ts'
export * from './remote.ts'
export * from './remote-host.ts'
export * from './remote-workspaces.ts'
