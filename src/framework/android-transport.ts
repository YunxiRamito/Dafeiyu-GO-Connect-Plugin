import { randomBytes } from 'node:crypto'
import { ConnectionPluginError } from './errors.ts'
import { NodePipeTransport, type NodeTransportOptions } from './node-transport.ts'
import type { IpcEnvelope } from './ipc.ts'

export function hasAndroidBridge(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['DAFEIYU_CONNECTION_SOCKET', 'DAFEIYU_CONNECTION_CAPABILITY', 'DAFEIYU_CONNECTION_GENERATION']
    .some(name => env[name] !== undefined)
}

/** Android LocalServerSocket uses the abstract namespace, not a filesystem path. */
export class AndroidBridgeTransport extends NodePipeTransport {
  constructor(options: NodeTransportOptions = {}) { super(options) }

  private credentials() {
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

  protected async endpoints(): Promise<string[]> { return [`\0${this.credentials().socket}`] }

  protected wireEnvelope(envelope: IpcEnvelope): IpcEnvelope {
    const { capability, generation } = this.credentials()
    return { ...envelope, capability, generation, nonce: randomBytes(24).toString('base64url') } as IpcEnvelope
  }
}
