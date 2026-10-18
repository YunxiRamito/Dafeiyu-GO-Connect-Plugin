# Bounded remote JSON response transport research

Date: 2026-10-18. Fixed reference: `tus/tus-js-client`, tag `v4.3.1`, MIT.
Fetched through the required local proxy `http://127.0.0.1:7890`. Read
`README.md`, `LICENSE`, and `lib/upload.js`; source observations include
explicit `chunkSize`, stable fingerprints, stored offsets, bounded retry
delays, and resetting retries only after confirmed forward progress.

The first attempted reference URL was
`tus/tus-resumable-upload-protocol/1.0.0/README.md` and returned HTTP 404.
The subsequent fixed tus-js-client README/license fetch succeeded; its
`lib/upload.ts` path returned 404, and the actual `lib/upload.js` succeeded.
Fetched references are preserved under
`../Temp_Android/codex-review-20261018/closeout-r22/connect-research/`.
No upstream script was executed. No dependency or source was copied.

Tus itself speaks resumable HTTP file upload rather than our authenticated
Aries event protocol. Adding it would duplicate authentication, request
ownership, and upload semantics. Reused design principles are explicit
bounded chunks, stable transfer identity, progress acknowledged by the
consumer, and persisted recovery metadata. The existing reviewed Connect
`remote-web.ts` already implements 48 KiB chunks, an 8 MiB response bound,
and final SHA-256 validation; that local protocol is the concrete fit.

The negotiated `remote_result_chunks_v1` extension keeps the existing
128 KiB request/payload and 192 KiB event frame limits. It sends JSON
responses in 48 KiB raw chunks, with total size, count, index, SHA-256 and
the original result/event type. A distinct bounded immutable blob store
avoids repeating multi-megabyte values in the 8 MiB request journal.
Request identity includes the response transport. Replaying a completed
finite response uses the original descriptor, bytes and sequences, never
re-executes its mutation. Restarted observation streams remain explicitly
uncertain because small stream events were not durably retained.

Source tests, package compilation, cross-device transfer and user
acceptance remain separate evidence; this research establishes none of
those outcomes by itself.
