import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const [anchor, root, id, preloadModule, archiveDirectory, otherRealm] = process.argv.slice(2), require = createRequire(anchor)
const { assertFixedDshArchivePreload } = await import(pathToFileURL(preloadModule).href)
await assertFixedDshArchivePreload(anchor, archiveDirectory)
await assert.rejects(assertFixedDshArchivePreload(anchor, path.join(archiveDirectory, 'different-directory')), /archive_preload_directory_changed/)
await assert.rejects(assertFixedDshArchivePreload(otherRealm, archiveDirectory), /archive_multiple_service_realms/)
const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href)
const [{ Context }, { SessionStore }, { default: Persistence }] = await Promise.all(['cordis', 'dsh-session', 'dsh-session-persistence-jsonl'].map(load))
const ctx = new Context()
const sessions = new SessionStore(ctx), persistence = new Persistence(ctx, { root, compression: 'none' })
await assert.rejects(persistence.open(id), /archive_tombstoned/)
assert.throws(() => sessions.prepare(id), /archive_tombstoned/)
assert.equal(await persistence.stat(id), undefined)
await ctx.fiber.dispose()
process.send({ beforeManager: true, preloadReady: true, wrongDirectoryDenied: true, otherRealmDenied: true,
  persistenceDenied: true, storeDenied: true, statHidden: true, modelCalls: 0 })
process.disconnect()
