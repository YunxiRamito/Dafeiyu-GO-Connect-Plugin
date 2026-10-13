import { ConnectionPluginError } from './errors.js'

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
]         )

                                                   

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
  #granted                     

  constructor(granted                   = []) {
    this.#granted = new Set(granted)
  }

  has(permission        )          { return this.#granted.has(permission) }

  require(permission            )       {
    if (!this.has(permission)) throw new ConnectionPluginError('permission_denied', `Required permission is unavailable: ${permission}`)
  }

  list()           { return [...this.#granted] }
}


