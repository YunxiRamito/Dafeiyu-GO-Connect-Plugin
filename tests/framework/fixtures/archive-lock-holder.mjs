import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const [anchor, root, id] = process.argv.slice(2), require = createRequire(anchor)
const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href)
const [{ Context }, { SessionStore }, { default: Persistence }] = await Promise.all(['cordis', 'dsh-session', 'dsh-session-persistence-jsonl'].map(load))
const ctx = new Context()
new SessionStore(ctx)
const persistence = new Persistence(ctx, { root, compression: 'none' })
const writer = await persistence.open(id)
await writer.flush()
process.send('owned')
await new Promise(resolve => process.once('message', value => { if (value === 'release') resolve() }))
await writer.close(); await ctx.fiber.dispose()
process.send('released'); process.disconnect()
