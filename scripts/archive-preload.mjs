import path from 'node:path'
import { installFixedDshArchiveExtension } from '../lib/framework/remote-archive-dsh.js'

// Set by the owning launcher to the actual DSH package.json (not plugin home).
// --import runs before the CLI composes its factories and configured Agents.
const anchor = process.env.DAFEIYU_DSH_INSTALL_ANCHOR
if (!anchor || !path.isAbsolute(anchor)) throw new Error('archive_install_anchor_invalid')
const home = process.env.DSH_HOME, directory = process.env.DAFEIYU_DSH_ARCHIVE_DIRECTORY
if (!home || !path.isAbsolute(home) || !directory || !path.isAbsolute(directory) ||
  path.relative(path.join(home, 'dafeiyu-connection-plugin', 'workspace-lifecycle'), directory) !== '') throw new Error('archive_preload_directory_invalid')
await installFixedDshArchiveExtension(anchor, { archiveDirectory: directory })
