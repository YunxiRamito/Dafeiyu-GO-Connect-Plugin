import { ConnectionPluginError } from './errors.ts'

export const PERMISSIONS = Object.freeze([
  'connection.read',
  'connection.state.subscribe',
  'connection.message.send',
  'connection.message.read',
  'connection.file.transfer',
  'connection.file.cache.read',
  'connection.file.cache.cleanup',
  'connection.remote.task',
  'connection.remote.directory',
  'connection.remote.workspace.lifecycle',
  'connection.remote.archive.delete',
  'connection.remote.artifacts',
  'connection.remote.attachments',
  'connection.remote.settings',
  'connection.remote.web',
  'workspace.read',
  'workspace.write',
  'broadcast.send',
  'broadcast.receive',
] as const)

export type Permission = typeof PERMISSIONS[number]

export const PLUGIN_PERMISSION_MANIFEST = Object.freeze({
  protocol: 'dafeiyu-go.connection.v1',
  requested: [...PERMISSIONS],
  deniedByDesign: [
    'identity.create', 'identity.private_key.read', 'content_key.read', 'aries_token.read',
    'aries_http.raw', 'pairing.manage', 'group.create', 'invite.create', 'member.revoke',
    'member.role.update', 'key_rotation.execute', 'presence.forge',
  ],
})

export class PermissionSet {
  #granted: ReadonlySet<string>

  constructor(granted: Iterable<string> = []) {
    this.#granted = new Set(granted)
  }

  has(permission: string): boolean { return this.#granted.has(permission) }

  require(permission: Permission): void {
    if (!this.has(permission)) throw new ConnectionPluginError('permission_denied', `Required permission is unavailable: ${permission}`)
  }

  list(): string[] { return [...this.#granted] }
}


