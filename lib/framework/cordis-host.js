                                                                
import { ConnectionPluginError } from './errors.js'

/** DSH slash names are single words; subcommands use the authoritative rawInput. */
export function registerDshConnectionCommand(commands     , register                                   )             {
  const handlers = new Map                        ()
  register({ register: command => { handlers.set(command.name.replace(/^dsh connection\s*/, ''), command.handler) } })
  const disposer = commands.register({
    definitionId: 'dafeiyu-go-connect:connection',
    name: 'connection',
    description: 'Device connection, workspace sync and safe web broadcast',
    input: { hint: 'status | sync <action> | broadcast <action> [JSON]' },
    recordInput: false,
    handler: async (invocation     ) => {
      try {
        const input = String(invocation.rawInput ?? '').trim() || 'status'
        const name = [...handlers.keys()].sort((a, b) => b.length - a.length)
          .find(name => input === name || input.startsWith(`${name} `))
        if (!name) throw new ConnectionPluginError('validation_failed', 'Unknown connection subcommand.')
        const rest = input.slice(name.length).trim()
        let args                          = {}
        if (rest) {
          if (rest.startsWith('{')) {
            const parsed = JSON.parse(rest)
            if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('invalid_args')
            args = parsed
          } else if (name === 'sync set-root') {
            args = { root: rest.startsWith('"') ? JSON.parse(rest) : rest }
          } else if (name === 'sync run') {
            args = { path: rest.startsWith('"') ? JSON.parse(rest) : rest }
          } else throw new ConnectionPluginError('validation_failed', 'Arguments must be a JSON object.')
        }
        const result = await handlers.get(name) ({ args, signal: invocation.signal })
        return { kind: 'success', text: JSON.stringify(result) ?? 'Completed.' }
      } catch (error) {
        const code = error instanceof ConnectionPluginError ? error.code : 'command_failed'
        return { kind: 'error', text: `Connection command failed (${code}).` }
      }
    },
  })
  return typeof disposer === 'function' ? disposer : () => {}
}
