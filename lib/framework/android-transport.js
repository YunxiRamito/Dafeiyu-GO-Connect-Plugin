import { randomBytes } from 'node:crypto'
import { ConnectionPluginError } from './errors.js'
import { NodePipeTransport,                           } from './node-transport.js'
                                           

export function hasAndroidBridge(env                    = process.env)          {
  return ['DAFEIYU_CONNECTION_SOCKET', 'DAFEIYU_CONNECTION_CAPABILITY', 'DAFEIYU_CONNECTION_GENERATION']
    .some(name => env[name] !== undefined)
}

/** Android LocalServerSocket uses the abstract namespace, not a filesystem path. */
export class AndroidBridgeTransport extends NodePipeTransport {
  constructor(options                       = {}) { super(options) }

          credentials() {
    const socket = this.env.DAFEIYU_CONNECTION_SOCKET
    const capability = this.env.DAFEIYU_CONNECTION_CAPABILITY
    const generation = this.env.DAFEIYU_CONNECTION_GENERATION
    if (!socket || !/^dafeiyu-plugin-[a-zA-Z0-9_-]{1,80}$/.test(socket) ||
        !capability || !/^[A-Za-z0-9_-]{43}$/.test(capability) ||
        Buffer.from(capability, 'base64url').toString('base64url') !== capability ||
        !generation || !/^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/.test(generation))
      throw new ConnectionPluginError('protocol_error', 'Invalid Android bridge launch parameters.')
    return { socket, capability, generation }
  }

            async endpoints()                    { return [`\0${this.credentials().socket}`] }

            wireEnvelope(envelope             )              {
    const { capability, generation } = this.credentials()
    return { ...envelope, capability, generation, nonce: randomBytes(24).toString('base64url') }               
  }
}
