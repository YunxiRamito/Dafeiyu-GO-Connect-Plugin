import { mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'

const root = process.cwd()
const sourceRoot = join(root, 'src')
const outputRoot = join(root, 'lib')

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const file = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walk(file))
    else if (entry.isFile() && file.endsWith('.ts')) files.push(file)
  }
  return files
}

await rm(outputRoot, { recursive: true, force: true })
const files = await walk(sourceRoot)
for (const input of files) {
  const rel = relative(sourceRoot, input).replaceAll('\\', '/')
  const output = join(outputRoot, rel.replace(/\.ts$/, '.js'))
  const source = await readFile(input, 'utf8')
  const stripped = stripTypeScriptTypes(source, { mode: 'strip', sourceMap: false })
    .replace(/(['"])([^'"\n]+)\.ts\1/g, '$1$2.js$1')
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, stripped, 'utf8')
}
console.log(`built ${files.length} modules into ${relative(root, outputRoot)}`)
