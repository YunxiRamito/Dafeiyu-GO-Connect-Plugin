import path from 'node:path'

const SENSITIVE_EXTENSIONS = new Set(['.key', '.pem', '.p12', '.pfx', '.env'])
const SENSITIVE_NAMES = new Set(['token', 'tokens', 'cookie', 'cookies', 'credential', 'credentials', 'secret', 'secrets', 'password', 'passwd', 'auth'])

export interface PathDecision { allowed: boolean; reason?: 'outside_root' | 'ignored' | 'sensitive' | 'invalid' }

export function normalizeRelativePath(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  return path.posix.normalize(normalized).replace(/^\.\//, '')
}

function matchesRule(relativePath: string, rule: string): boolean {
  const normalized = normalizeRelativePath(relativePath)
  const rulePath = normalizeRelativePath(rule)
  if (!rulePath) return false
  if (rulePath.includes('*')) {
    const escaped = rulePath.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')
    return new RegExp(`^${escaped}$`, 'i').test(path.posix.basename(normalized)) || new RegExp(`(^|/)${escaped}(/|$)`, 'i').test(normalized)
  }
  return normalized === rulePath || normalized.startsWith(`${rulePath}/`) || normalized.split('/').includes(rulePath)
}

export function isSensitivePath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath)
  const parts = normalized.split('/').filter(Boolean)
  const basename = parts.at(-1)?.toLowerCase() ?? ''
  const extension = path.posix.extname(basename).toLowerCase()
  if (SENSITIVE_EXTENSIONS.has(extension)) return true
  if (basename === '.env' || basename.startsWith('.env.')) return true
  return parts.some(part => SENSITIVE_NAMES.has(part.toLowerCase())) || /(^|[._-])(token|cookie|credential|secret|password|auth)([._-]|$)/i.test(basename)
}

export function decideSyncPath(root: string, candidate: string, ignoreRules: readonly string[] = []): PathDecision {
  if (!root || !candidate) return { allowed: false, reason: 'invalid' }
  const absoluteRoot = path.resolve(root)
  const absoluteCandidate = path.resolve(candidate)
  const relative = path.relative(absoluteRoot, absoluteCandidate)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return { allowed: false, reason: 'outside_root' }
  const normalized = normalizeRelativePath(relative)
  if (!normalized) return { allowed: true }
  if (isSensitivePath(normalized)) return { allowed: false, reason: 'sensitive' }
  if (ignoreRules.some(rule => matchesRule(normalized, rule))) return { allowed: false, reason: 'ignored' }
  return { allowed: true }
}

export function remoteFileIdentifier(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath)
  if (!normalized || normalized.startsWith('../') || isSensitivePath(normalized)) throw new Error('invalid or sensitive relative path')
  return normalized
}
