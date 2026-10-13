import { createHash } from "node:crypto";
                                                              
import { SyncError } from "./types.js";

const FORBIDDEN_QUERY_NAMES = /^(authorization|auth|api[_-]?key|token|access[_-]?token|refresh[_-]?token|session|session[_-]?id|cookie|password|passwd|secret|signature|sig|key)$/i;
const MAX_TITLE = 240;
const MAX_URL = 4096;
const MAX_TEXT = 4096;

                                   
                    
                  
                         
                 
                
              
                        
 

export function sanitizeBroadcastUrl(input        , options                               = {})         {
  let parsed     ;
  try { parsed = new URL(input); } catch { throw new SyncError("invalid_broadcast_url", "网页地址无效。"); }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !(options.allowLocalHttp && local && parsed.protocol === "http:")) throw new SyncError("insecure_broadcast_url", "网页广播只允许 HTTPS；本地 HTTP 必须由用户明确允许。");
  parsed.username = "";
  parsed.password = "";
  const kept = [...parsed.searchParams.entries()].filter(([key]) => !FORBIDDEN_QUERY_NAMES.test(key));
  parsed.search = "";
  for (const [key, value] of kept) parsed.searchParams.append(key, value);
  const result = parsed.toString();
  if (result.length > MAX_URL) throw new SyncError("broadcast_too_large", "网页地址过长。");
  return result;
}

function plainText(input        , limit        )         {
  return String(input ?? "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]*>/g, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, limit);
}

export function createBroadcastPayload(input                                                                                                                                     , options                               = {})                   {
  if (!input.groupId || !input.sourceDeviceId) throw new SyncError("broadcast_context_required", "网页广播缺少当前小组或来源设备。");
  const url = sanitizeBroadcastUrl(input.url, options);
  const selectedText = input.selectedText === undefined ? undefined : plainText(input.selectedText, MAX_TEXT);
  const canonical = [input.groupId, input.sourceDeviceId, input.title.slice(0, MAX_TITLE), url, selectedText ?? ""].join("\u0000");
  return { messageId: input.messageId ?? createHash("sha256").update(canonical).digest("hex").slice(0, 32), groupId: input.groupId, sourceDeviceId: input.sourceDeviceId, sentAt: input.sentAt ?? new Date().toISOString(), title: plainText(input.title, MAX_TITLE), url, ...(selectedText ? { selectedText } : {}) };
}

export function assertSafeBroadcastPayload(payload                  )       {
  const serialized = JSON.stringify(payload);
  if (/authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|session(?:[_-]?id)?/i.test(serialized)) throw new SyncError("unsafe_broadcast_payload", "广播 payload 包含禁止的凭据字段。");
  if (/<script|javascript:/i.test(serialized)) throw new SyncError("unsafe_broadcast_payload", "广播 payload 包含脚本内容。");
}

export class BroadcastDeduplicator {
                   seen = new Set        ();
                   maxEntries        ;
  constructor(maxEntries = 1000) { this.maxEntries = maxEntries; }
  accept(messageId        )          {
    if (this.seen.has(messageId)) return false;
    this.seen.add(messageId);
    if (this.seen.size > this.maxEntries) this.seen.delete(this.seen.values().next().value          );
    return true;
  }
}

export function remotePresenceLabel(state                                                         )                                            {
  if (!state.serverConnected) return "connection_unavailable";
  return state.presence ?? "unknown";
}

export function activeMembers(members                        )                         {
  return members.filter((member) => member.active);
}



