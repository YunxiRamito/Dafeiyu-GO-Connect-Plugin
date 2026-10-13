import { createPlugin } from './framework/index.ts'
import { registerDshConnectionCommand } from './framework/cordis-host.ts'
import type { ConfigPatch } from './framework/runtime.ts'
import { hasAndroidBridge } from './framework/android-transport.ts'
import { createCordisRemoteDshAdapter } from './framework/remote-host.ts'
import { createCordisRemoteWebAdapter } from './framework/remote-web.ts'
import path from 'node:path'

export const name = 'dafeiyu-go-connect'
export const inject = ['commands']

/**
 * Cordis entry point. The launcher may expose a high-level provider on
 * `ctx.connectionProvider`; Windows otherwise discovers the launcher pipe.
 * Hosts without either transport report launcher_unavailable.
 */
export function apply(ctx: any = {}, config?: ConfigPatch) {
  const get = (name: string) => typeof ctx?.get === 'function' ? ctx.get(name) : ctx?.[name]
  const candidate = get('connectionProvider')
  const provider = candidate && typeof candidate.get_connection_state === 'function' ? candidate : undefined
  const transport = get('connectionTransport')
  const ipcTransport = transport && typeof transport.request === 'function' ? transport : undefined
  let plugin: ReturnType<typeof createPlugin> | undefined
  plugin = createPlugin({ provider, ipcTransport, config: config ?? get('dafeiyuGoConnectionConfig'),
    home: process.env.DSH_HOME, discoverIpc: !provider && (process.platform === 'win32' || hasAndroidBridge()),
    remoteHostAdapter: !hasAndroidBridge() ? createCordisRemoteWebAdapter(ctx, createCordisRemoteDshAdapter(ctx, {
      workspaceRoot: () => plugin?.getConfig().workspaceSync.root,
      lifecycleDirectory: process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'dafeiyu-connection-plugin', 'workspace-lifecycle') : undefined,
      attachmentDirectory: process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'dafeiyu-connection-plugin', 'remote-attachments') : undefined,
      // Enabled only after real Android/Aries/PC file-transfer validation.
      artifactsEnabled: false, attachmentsEnabled: false,
      // Requires the verified pre-CLI persistence guard and real host validation.
      archiveDeletionEnabled: false,
      protectedPaths: process.env.DSH_HOME ? [process.env.DSH_HOME] : [],
    })) : undefined })
  const disposers: Array<() => void> = []

  try {
    if (typeof ctx?.provide === 'function') disposers.push(ctx.provide('dafeiyuGoConnection', plugin))
    else if (ctx && typeof ctx === 'object') ctx.dafeiyuGoConnection = plugin
  } catch {
    // A frozen host context is valid; the returned plugin remains usable.
  }

  const commands = get('commands')
  const commandHost = get('commandHost') ?? get('command')
  if (commands?.register) disposers.push(registerDshConnectionCommand(commands, plugin.registerCommands))
  else if (commandHost?.register) disposers.push(plugin.registerCommands(commandHost))

  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => async () => {
      for (const dispose of disposers.reverse()) dispose()
      await plugin.dispose()
      try {
        if (ctx.dafeiyuGoConnection === plugin) delete ctx.dafeiyuGoConnection
      } catch {
        // Host cleanup must never turn plugin disposal into a DSH failure.
      }
    }, `${name}: dispose`)
  }

  return plugin
}

export * from './framework/index.ts'
export * as sync from './sync/index.ts'
export * as broadcast from './broadcast/index.ts'


