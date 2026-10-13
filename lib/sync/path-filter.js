import path from "node:path";
                                                      
import { SyncError } from "./types.js";

                                                                                                                              

const SENSITIVE_NAMES = new Set([
  "credentials", "cookies", "tokens", "token", "secrets", ".npmrc", ".pypirc", "id_rsa", "id_ed25519",
]);
const SENSITIVE_EXTENSIONS = new Set([".key", ".pem", ".p12", ".pfx"]);

function normalizeRelative(input        )         {
  const raw = String(input ?? "").replaceAll("\\", "/").trim();
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) throw new SyncError("invalid_path", "同步路径必须是相对路径。");
  const normalized = path.posix.normalize(raw);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("\0")) throw new SyncError("invalid_path", "同步路径不能越过工作区根目录。");
  return normalized;
}

function globToRegExp(pattern        )         {
  const normalized = pattern.replaceAll("\\", "/").trim().replace(/^\.\//, "");
  let source = "";
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char === "*") {
      if (normalized[i + 1] === "*") { source += ".*"; i += 1; }
      else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += /[|\\{}()[\]^$+?.]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${source}(?:$|/)`, "i");
}

export function isSensitivePath(relativePath        )          {
  const normalized = relativePath.toLowerCase();
  const segments = normalized.split("/");
  return segments.some((segment) => {
    const basename = segment.split(".")[0];
    return SENSITIVE_NAMES.has(segment) || SENSITIVE_NAMES.has(basename) || SENSITIVE_EXTENSIONS.has(path.posix.extname(segment)) ||
      segment === ".env" || segment.startsWith(".env.") || segment.endsWith(".secret");
  });
}

export function isPathAllowed(input        , ignoreRules                   )               {
  const relativePath = normalizeRelative(input);
  if (isSensitivePath(relativePath)) return { allowed: false, relativePath, reason: "sensitive_file" };
  for (const rule of ignoreRules) {
    if (globToRegExp(rule).test(relativePath) || globToRegExp(rule).test(path.posix.basename(relativePath))) {
      return { allowed: false, relativePath, reason: `ignored:${rule}` };
    }
  }
  return { allowed: true, relativePath };
}

export function assertPathAllowed(input        , config                                          )         {
  const decision = isPathAllowed(input, config.ignoreRules);
  if (!decision.allowed) throw new SyncError("path_rejected", `文件被同步规则拒绝：${decision.relativePath}`, { details: { reason: decision.reason } });
  return decision.relativePath;
}

export function resolveWorkspacePath(root        , relativePath        )         {
  const normalized = normalizeRelative(relativePath);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, normalized);
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (resolved !== resolvedRoot && !resolved.startsWith(prefix)) throw new SyncError("invalid_path", "路径解析越过工作区根目录。");
  return resolved;
}

