import { registerConnectionCommands,                                       } from './commands.js'
import { PermissionSet, PLUGIN_PERMISSION_MANIFEST } from './permissions.js'
import { UnavailableConnectionProvider,                         } from './provider.js'
import { ConnectionRuntime,                  } from './runtime.js'
import { NodePipeTransport } from './node-transport.js'
import { IpcConnectionProvider } from './launcher-provider.js'
import { AndroidBridgeTransport, hasAndroidBridge } from './android-transport.js'
                                            
import { RemoteDshClient } from './remote.js'
import { RemoteDshHost,                           } from './remote-host.js'
import path from 'node:path'

                                                                                                                                                                                                                                                                                    

export function createPlugin(options                = {}) {
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
  const runtime                 = {
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
    updateConfig: (patch             ) => engine.setConfig(patch),
    dispose: async () => { (transport                                           )?.dispose?.(); await engine.dispose() },
    registerCommands: (host             ) => registerConnectionCommands(host, runtime),
  }
}

export { createDefaultConfig, mergeConfig } from './config.js'
export * from './broadcast.js'
export * from './cache-cleanup.js'
export * from './commands.js'
export * from './errors.js'
export * from './ipc.js'
export * from './path-policy.js'
export * from './permissions.js'
export * from './provider.js'
export * from './transfer.js'
export * from './node-transport.js'
export * from './launcher-provider.js'
export * from './sync-adapter.js'
export * from './runtime.js'
export * from './android-transport.js'
export * from './remote.js'
export * from './remote-host.js'
export * from './remote-workspaces.js'
