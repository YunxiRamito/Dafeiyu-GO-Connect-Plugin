import path from 'node:path'
import { constants } from 'node:fs'
import {                  lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { ConnectionPluginError } from './errors.js'
                                                            

                                
export const ATTACHMENT_OPERATIONS = Object.freeze(['attachment.prepare', 'attachment.write', 'attachment.status', 'attachment.commit', 'attachment.cancel'])
export const ATTACHMENT_CHUNK_BYTES = 48 * 1024
const ID = /^[A-Za-z0-9_-]{1,128}$/
const HASH = /^[a-f0-9]{64}$/
const MAX_METADATA_BYTES = 8192
                  
                                                                                            
                                                                                       
                                                            
 
function fail(code                                                                                                                                                , message        )        {
  throw new ConnectionPluginError(code, message)
}
function identifier(value         )         {
  if (typeof value !== 'string' || !ID.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value))
    fail('validation_failed', 'Invalid attachment identity.')
  return value
}
function fields(value         , allowed          )                         {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)))
    fail('permission_denied', 'Unknown attachment request field.')
}
function digest(data            )         { return createHash('sha256').update(data).digest('hex') }
function displayName(value         )         {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 255 ||
      /[\x00-\x1f\x7f/\\]/.test(value) || value.trim() !== value || ['.', '..'].includes(value))
    fail('validation_failed', 'Attachment name must be a display filename.')
  return value
}
function key(group        , peer        , uploadId        )         {
  return createHash('sha256').update(`${group}\0${peer}\0${uploadId}`).digest('hex')
}
function same(left        , right        )          { return path.relative(left, right) === '' }
async function syncDirectory(directory        )                {
  // Windows requires write-through publication in its first-party store;
  // plugin staging is resumable, never the durable DSH attachment authority.
  if (process.platform === 'win32') return
  const handle = await open(directory, constants.O_RDONLY)
  try { await handle.sync() } finally { await handle.close() }
}

/** Explicit phone-selected uploads only. The real DSH fileUploads service
 * owns admission, immutable objects and session-scoped prompt receipts. */
export class RemoteAttachmentReceiver {
                   ctx     
                   directory        
                   maxBytes        
                   maxTotalBytes        
                   maxUploads        
                   ttlMillis        
          queue                   = Promise.resolve()
          closed = false
          revoked = new Set        ()
          inflight = new Map                                       ()
          receipts = new Map                                        ()
  constructor(ctx     , options                                                                                                           ) {
    this.ctx = ctx
    this.directory = path.resolve(options.directory)
    this.maxBytes = options.maxBytes ?? 512 * 1024 * 1024
    this.maxTotalBytes = options.maxTotalBytes ?? 1024 * 1024 * 1024
    this.maxUploads = options.maxUploads ?? 16
    this.ttlMillis = options.ttlMillis ?? 24 * 60 * 60 * 1000
    if (!path.isAbsolute(options.directory) || !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > 512 * 1024 * 1024 ||
        !Number.isSafeInteger(this.maxTotalBytes) || this.maxTotalBytes < this.maxBytes || this.maxTotalBytes > 1024 * 1024 * 1024 ||
        !Number.isSafeInteger(this.maxUploads) || this.maxUploads < 1 || this.maxUploads > 32 ||
        !Number.isSafeInteger(this.ttlMillis) || this.ttlMillis < 1 || this.ttlMillis > 24 * 60 * 60 * 1000)
      fail('validation_failed', 'Invalid attachment resource bounds.')
  }
          get uploads()      { return typeof this.ctx?.get === 'function' ? this.ctx.get('fileUploads') : this.ctx?.fileUploads }
  available()          { return !this.closed && typeof this.uploads?.uploadStream === 'function' }
          active(signal             , context                      )       {
    if (this.closed || signal.aborted) fail('request_cancelled', 'Attachment request cancelled.')
    if (this.revoked.has(context.group) || this.revoked.has(`${context.group}\0${context.peer}`))
      fail('revoked', 'Attachment relationship was revoked.')
  }
          async serial   (signal             , context                                  , action                                                                    )             {
    if (!context) fail('permission_denied', 'Attachment requests require an authenticated relationship.')
    identifier(context.group); identifier(context.peer)
    if (this.inflight.size >= 64) fail('disk_space_low', 'Too many attachment requests are waiting.')
    const detached = { group: context.group, peer: context.peer }, controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) controller.abort()
    this.inflight.set(controller, detached)
    const pending = this.queue.catch(() => {}).then(async () => {
      this.active(controller.signal, detached)
      return action(controller.signal, detached)
    })
    this.queue = pending.then(() => {}, () => {})
    try { return await pending }
    finally { signal.removeEventListener('abort', abort); this.inflight.delete(controller) }
  }
          async safeRoot()                  {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const info = await lstat(this.directory), canonical = await realpath(this.directory)
    if (!info.isDirectory() || info.isSymbolicLink() || !same(canonical, this.directory))
      fail('permission_denied', 'Attachment staging cannot be a linked directory.')
    return this.directory
  }
          async folder(recordKey        , create = false)                  {
    if (!HASH.test(recordKey)) fail('validation_failed', 'Invalid attachment staging identity.')
    const folder = path.join(await this.safeRoot(), recordKey)
    if (create) { await mkdir(folder, { mode: 0o700 }); await syncDirectory(this.directory) }
    const info = await lstat(folder), canonical = await realpath(folder)
    if (!info.isDirectory() || info.isSymbolicLink() || !same(canonical, folder))
      fail('permission_denied', 'Attachment staging was replaced.')
    return folder
  }
          async readRecord(recordKey        )                              {
    let folder        
    try { folder = await this.folder(recordKey) }
    catch (error) { if ((error       )?.code === 'ENOENT') return; throw error }
    const filename = path.join(folder, 'metadata.json')
    let info
    try { info = await lstat(filename) }
    catch (error) {
      if ((error       )?.code !== 'ENOENT') throw error
      // A crash while preparing can leave only an unpublished empty stage.
      // Remove no foreign names or metadata; all accepted uploads have a
      // synced metadata record before the phone receives an acknowledgement.
      const children = await readdir(folder)
      if (children.some(name => name !== 'bytes.bin' && !/^meta-[a-f0-9-]{36}\.tmp$/.test(name)))
        fail('permission_denied', 'Unrecognized interrupted attachment stage.')
      await rm(folder, { recursive: true, force: true }); await syncDirectory(this.directory)
      return
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_METADATA_BYTES)
      fail('permission_denied', 'Invalid attachment staging metadata.')
    const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let record        
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > MAX_METADATA_BYTES)
        fail('permission_denied', 'Attachment metadata was replaced while opening.')
      const bytes = Buffer.alloc(MAX_METADATA_BYTES + 1), result = await handle.read(bytes, 0, bytes.length, 0)
      if (result.bytesRead > MAX_METADATA_BYTES) fail('protocol_error', 'Attachment metadata exceeds its bound.')
      record = JSON.parse(bytes.subarray(0, result.bytesRead).toString('utf8'))
    }
    finally { await handle.close() }
    fields(record, ['schema', 'group', 'peer', 'uploadId', 'sessionId', 'name', 'size', 'sha256', 'received', 'createdAt', 'expiresAt', 'status', 'file'])
    if (record.schema !== 1 || key(identifier(record.group), identifier(record.peer), identifier(record.uploadId)) !== recordKey ||
        identifier(record.sessionId) !== record.sessionId || typeof record.sha256 !== 'string' || !HASH.test(record.sha256) || displayName(record.name) !== record.name ||
        !Number.isSafeInteger(record.size) || record.size < 0 || record.size > this.maxBytes ||
        !Number.isSafeInteger(record.received) || record.received < 0 || record.received > record.size ||
        !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.expiresAt) || record.expiresAt < record.createdAt ||
        !['uploading', 'ready', 'cancelled'].includes(record.status) || record.status === 'ready' && record.received !== record.size)
      fail('protocol_error', 'Attachment staging metadata failed validation.')
    if (record.status === 'ready') {
      fields(record.file, ['attachmentId', 'name', 'bytes'])
      if (record.file .attachmentId !== `sha256:${record.sha256}` || record.file .bytes !== record.size ||
          displayName(record.file .name) !== record.file .name) fail('protocol_error', 'Attachment file reference failed validation.')
    } else if (record.file !== undefined) fail('protocol_error', 'Uncommitted attachment cannot contain a file reference.')
    return record
  }
          async save(record        )                {
    const folder = await this.folder(key(record.group, record.peer, record.uploadId)), temporary = path.join(folder, `meta-${randomUUID()}.tmp`)
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync() }
    finally { await handle.close() }
    try { await rename(temporary, path.join(folder, 'metadata.json')); await syncDirectory(folder) }
    finally { await rm(temporary, { force: true }) }
  }
          async selected(uploadId         , context                      )                  {
    const record = await this.readRecord(key(context.group, context.peer, identifier(uploadId)))
    if (!record || record.expiresAt <= Date.now() || record.status === 'cancelled')
      fail('permission_denied', 'Attachment upload is unavailable for this relationship.')
    return record
  }
          view(record        )        {
    return { uploadId: record.uploadId, sessionId: record.sessionId, name: record.name, size: record.size,
      sha256: record.sha256, received: record.received, status: record.status, chunkBytes: ATTACHMENT_CHUNK_BYTES,
      expiresAt: record.expiresAt, ...(record.status === 'ready' ? { content: { type: 'file', uploadId: record.uploadId }, file: record.file } : {}) }
  }
          async openBytes(record        , write = false)                      {
    const filename = path.join(await this.folder(key(record.group, record.peer, record.uploadId)), 'bytes.bin')
    const info = await lstat(filename)
    if (!info.isFile() || info.isSymbolicLink()) fail('permission_denied', 'Attachment staging must be a regular file.')
    if (info.size < record.received || info.size > record.size)
      fail('conflict', 'Attachment staging bytes changed.')
    const handle = await open(filename, (write ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0))
    const opened = await handle.stat()
    if (opened.dev !== info.dev || opened.ino !== info.ino || !opened.isFile()) {
      await handle.close(); fail('conflict', 'Attachment staging was replaced while opening.')
    }
    return handle
  }
          async expire()                    {
    const folders = await readdir(await this.safeRoot()), retained           = []
    if (folders.length > this.maxUploads + 32) fail('disk_space_low', 'Attachment staging budget exceeded.')
    for (const name of folders) {
      if (!HASH.test(name)) fail('permission_denied', 'Unexpected attachment staging entry.')
      const record = await this.readRecord(name)
      if (!record) continue
      if (record.expiresAt <= Date.now()) {
        this.receipts.delete(name)
        await rm(await this.folder(name), { recursive: true, force: true }); await syncDirectory(this.directory)
      }
      else retained.push(record)
    }
    return retained
  }
  async execute(operation        , payload       , _requestId        , signal             , context                       )                   {
    if (!ATTACHMENT_OPERATIONS.includes(operation)) fail('unsupported', 'Unknown attachment operation.')
    if (!this.available()) fail('unsupported', 'DSH file upload service is unavailable.')
    return this.serial(signal, context, async (signal, context) => {
      const retained = await this.expire(); this.active(signal, context)
      if (operation === 'attachment.prepare') {
        fields(payload, ['uploadId', 'sessionId', 'name', 'size', 'sha256'])
        const uploadId = identifier(payload.uploadId), sessionId = identifier(payload.sessionId), name = displayName(payload.name)
        const size = payload.size, sha256 = payload.sha256
        if (!Number.isSafeInteger(size) || size < 0 || size > this.maxBytes || typeof sha256 !== 'string' || !HASH.test(sha256))
          fail('validation_failed', 'Invalid attachment length or digest.')
        const recordKey = key(context.group, context.peer, uploadId), previous = await this.readRecord(recordKey)
        if (previous) {
          if (previous.sessionId !== sessionId || previous.name !== name || previous.size !== size || previous.sha256 !== sha256)
            fail('conflict', 'Attachment upload id was reused for different content.')
          if (previous.status === 'cancelled') fail('permission_denied', 'Attachment upload was cancelled.')
          return this.view(previous)
        }
        const reservations = retained.filter(record => record.status !== 'cancelled')
        if (retained.length >= this.maxUploads || reservations.reduce((sum, record) => sum + record.size, 0) + size > this.maxTotalBytes)
          fail('disk_space_low', 'Too many selected attachments are staged.')
        const folder = await this.folder(recordKey, true)
        const bytes = await open(path.join(folder, 'bytes.bin'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
        await bytes.close(); await syncDirectory(folder)
        const now = Date.now(), record         = { schema: 1, ...context, uploadId, sessionId, name, size, sha256,
          received: 0, createdAt: now, expiresAt: now + this.ttlMillis, status: 'uploading' }
        try { this.active(signal, context); await this.save(record) }
        catch (error) { await rm(folder, { recursive: true, force: true }); throw error }
        return this.view(record)
      }
      fields(payload, operation === 'attachment.write' ? ['uploadId', 'offset', 'bytesBase64', 'chunkSha256'] : ['uploadId'])
      if (operation === 'attachment.cancel') {
        const record = await this.readRecord(key(context.group, context.peer, identifier(payload.uploadId)))
        if (!record) fail('permission_denied', 'Attachment upload is unavailable for this relationship.')
        record.status = 'cancelled'; delete record.file
        this.receipts.delete(key(record.group, record.peer, record.uploadId))
        await this.save(record)
        await rm(path.join(await this.folder(key(context.group, context.peer, record.uploadId)), 'bytes.bin'), { force: true })
        return { uploadId: record.uploadId, cancelled: true }
      }
      const record = await this.selected(payload.uploadId, context)
      if (operation === 'attachment.status') return this.view(record)
      if (operation === 'attachment.write') {
        const offset = payload.offset, encoded = payload.bytesBase64
        if (!Number.isSafeInteger(offset) || offset < 0 || typeof encoded !== 'string' || encoded.length > 4 * Math.ceil(ATTACHMENT_CHUNK_BYTES / 3) ||
            typeof payload.chunkSha256 !== 'string' || !HASH.test(payload.chunkSha256)) fail('validation_failed', 'Invalid attachment chunk.')
        const bytes = Buffer.from(encoded, 'base64')
        if (!bytes.length || bytes.length > ATTACHMENT_CHUNK_BYTES || bytes.toString('base64') !== encoded ||
            digest(bytes) !== payload.chunkSha256 || offset + bytes.length > record.size) fail('validation_failed', 'Attachment chunk failed verification.')
        if (offset > record.received || offset < record.received && offset + bytes.length > record.received)
          fail('conflict', 'Attachment chunk does not match the committed offset.')
        const handle = await this.openBytes(record, true)
        try {
          if (offset < record.received) {
            const old = Buffer.alloc(bytes.length), read = await handle.read(old, 0, old.length, offset)
            if (read.bytesRead !== bytes.length || !old.equals(bytes)) fail('conflict', 'Attachment chunk retry changed its bytes.')
            return this.view(record)
          }
          if (record.status !== 'uploading') fail('conflict', 'Attachment upload is already complete.')
          // Discard only a previous unsaved chunk; a published offset never
          // advances before actual file sync and atomic metadata publication.
          await handle.truncate(record.received)
          let written = 0
          while (written < bytes.length) {
            this.active(signal, context)
            const result = await handle.write(bytes, written, bytes.length - written, offset + written)
            if (!result.bytesWritten) fail('protocol_error', 'Attachment chunk could not be written.')
            written += result.bytesWritten
          }
          await handle.sync(); this.active(signal, context)
          record.received += bytes.length; await this.save(record)
          return this.view(record)
        } finally { await handle.close() }
      }
      if (record.received !== record.size) fail('conflict', 'Attachment upload is incomplete.')
      if (record.status === 'ready') return this.view(record)
      const uploaded = await this.admit(record, signal, context)
      this.active(signal, context); record.status = 'ready'; record.file = uploaded.file
      await this.save(record)
      return this.view(record)
    })
  }
          async admit(record        , signal             , context                      )                 {
    const uploads = this.uploads
    if (typeof uploads?.uploadStream !== 'function') fail('unsupported', 'DSH file upload service is unavailable.')
    const handle = await this.openBytes(record), hash = createHash('sha256'), self = this
    async function* chunks()                            {
      let offset = 0
      while (offset < record.size) {
        self.active(signal, context)
        const bytes = Buffer.alloc(Math.min(ATTACHMENT_CHUNK_BYTES, record.size - offset))
        const result = await handle.read(bytes, 0, bytes.length, offset)
        if (result.bytesRead !== bytes.length) fail('conflict', 'Attachment changed during DSH admission.')
        hash.update(bytes); offset += bytes.length; yield bytes
      }
      self.active(signal, context)
      if (hash.digest('hex') !== record.sha256) fail('conflict', 'Complete attachment digest did not match.')
    }
    try {
      const result = await uploads.uploadStream({ sessionId: record.sessionId, name: record.name, data: chunks(), signal })
      this.active(signal, context)
      if (typeof result?.receiptId !== 'string' || !ID.test(result.receiptId) || result.file?.attachmentId !== `sha256:${record.sha256}` ||
          result.file?.bytes !== record.size || displayName(result.file?.name) !== result.file?.name)
        fail('protocol_error', 'DSH returned an invalid attachment receipt.')
      this.receipts.set(key(record.group, record.peer, record.uploadId), { service: uploads, value: result })
      return result
    } finally { await handle.close() }
  }
  /** Resolve only this relationship's selected uploads. First-party admission
   * still validates the real Session receipt and persists the user content. */
  async preparePrompt(payload       , signal             , context                       )                 {
    return this.serial(signal, context, async (signal, context) => {
      if (!Array.isArray(payload.content) || payload.content.length > 64) fail('validation_failed', 'Invalid prompt content.')
      const sessionId = identifier(payload.sessionId), content          = []
      for (const part of payload.content) {
        this.active(signal, context)
        if (part?.type === 'text') {
          fields(part, ['type', 'text'])
          if (typeof part.text !== 'string' || Buffer.byteLength(part.text) > 128 * 1024) fail('validation_failed', 'Invalid prompt text.')
          content.push({ type: 'text', text: part.text })
        } else if (part?.type === 'file') {
          fields(part, ['type', 'uploadId'])
          const record = await this.selected(part.uploadId, context)
          if (record.sessionId !== sessionId || record.status !== 'ready') fail('permission_denied', 'Attachment is not ready for this Session.')
          const cached = this.receipts.get(key(record.group, record.peer, record.uploadId)), uploads = this.uploads
          const agents = typeof this.ctx?.get === 'function' ? this.ctx.get('agents') : this.ctx?.agents
          const agent = agents?.get?.(record.sessionId)
          const resolved = cached && cached.service === uploads && agent && typeof uploads.resolve === 'function' ?
            uploads.resolve(agent, cached.value.receiptId) : undefined
          const receipt = resolved?.attachmentId === `sha256:${record.sha256}` && resolved?.bytes === record.size ?
            cached .value : await this.admit(record, signal, context)
          content.push({ type: 'file', receiptId: receipt.receiptId })
        } else {
          // Image uploads must use the first-party web/image admission path;
          // this streamed file contract never pretends a file is raster input.
          fail('permission_denied', 'Unknown remote attachment prompt part.')
        }
      }
      this.active(signal, context)
      return { ...payload, content }
    })
  }
  /** Called by the authenticated host on a durable revoked/unpaired relation. */
  async revoke(group        , peer         )                {
    identifier(group); if (peer !== undefined) identifier(peer)
    this.revoked.add(peer === undefined ? group : `${group}\0${peer}`)
    for (const [controller, context] of this.inflight) if (context.group === group && (peer === undefined || context.peer === peer)) controller.abort()
    const pending = this.queue.catch(() => {}).then(async () => {
      for (const record of await this.expire()) if (record.group === group && (peer === undefined || record.peer === peer)) {
        record.status = 'cancelled'; delete record.file
        this.receipts.delete(key(record.group, record.peer, record.uploadId))
        await this.save(record)
        await rm(path.join(await this.folder(key(record.group, record.peer, record.uploadId)), 'bytes.bin'), { force: true })
      }
    })
    this.queue = pending.then(() => {}, () => {})
    await pending
  }
  async dispose()                {
    this.closed = true
    this.receipts.clear()
    for (const controller of this.inflight.keys()) controller.abort()
    await this.queue.catch(() => {})
  }
}
