# Runtime 0.2.0 Host Integration

The Cordis entry is `lib/index.js`, exported `apply(ctx, config)` and
`inject = ['commands']`. DSH's actual command registry is
`ctx.commands.register`, not a custom `ctx.register`. It requires single-word
names, so `/connection` dispatches `status`, `sync <action>` and
`broadcast <action>`. Results use `{kind, text}`. Input is not duplicated into
the session log (`recordInput: false`). Cordis unload unregisters the command,
removes the `dafeiyuGoConnection` service and cancels runtime work.

## Windows IPC

With no injected provider, Windows discovers `DAFEIYU_CONNECTION_PIPE`, a plain
local name, then `DSH_HOME/dafeiyu-connection.json`:

```json
{"protocol":"dafeiyu-go.connection.v1","pipe_name":"local-name","pid":123}
```

Node constructs `\\.\pipe\local-name`. Each connection sends one bounded UTF-8
newline JSON request and stays open until the newline response. No early
`socket.end()`. Request/response bounds are 1 MiB / 2 MiB; deadline is at most
60 seconds. Upload `params.bytes` and download `data.bytes` are canonical
standard base64 on the wire, converted to/from `Uint8Array` by transport.
Default upload chunks are 512 KiB. Descriptor is rediscovered for every request.
Fallback after a stale environment endpoint is only allowed before sending:
mutations are not replayed after a disconnect.

Launcher owns identity, private CA, signatures, cryptography and reconnect.
Pipe ACL must restrict access to the current user. This plugin opens no TCP
listener and performs no Aries HTTP.

## Preferences And Storage

Native host and official CLI must resolve the same `DSH_HOME`. Launcher writes:

```json
{
  "schema_version":1,
  "workspace_sync":{"enabled":false,"root":null},
  "web_broadcast":{"enabled":false}
}
```

The file is `DSH_HOME/dafeiyu-connection-preferences.json`. Runtime polls changes
every two seconds. Only these fields cross this bridge. Root must be explicitly
selected and absolute. Invalid preferences retain the prior valid config.
Unchanged native preferences do not repeatedly override plugin command choices.

Plugin config, pause state, transfer queue, message IDs/cursors, conflicts and
file baselines are stored separately in
`DSH_HOME/dafeiyu-connection-plugin/{state,queue}.json`. Message bodies/URLs are
memory-only history, bounded to 100. Without DSH_HOME, state is memory-only.
Optional `apply(ctx, config)` or service `dafeiyuGoConnectionConfig` provides
framework camelCase config, merged by section.

## Android Injection

The same tgz includes dependency-free Node runtime modules and does not require
the PC pipe on Android. Before loading the plugin, compose the high-level
provider:

```js
const removeProvider = ctx.provide('connectionProvider', androidProvider)
const fiber = ctx.plugin(connectPlugin)
```

`androidProvider` implements the snake_case contract in `docs/contract.md`,
including `subscribe_connection_state`. File bytes at this boundary are
`Uint8Array`; the Android adapter owns its transport encoding and cancellation.
Inject the provider before loading: provider discovery happens at apply time.
Optional services are read with `ctx.get()` and are not required Cordis
injections. Android actual transport/E2E is owned by the mobile agent.

Alternatively provide `connectionTransport` implementing IpcTransport.request,
or launch Node with all three process-private variables:
DAFEIYU_CONNECTION_SOCKET (plain dafeiyu-plugin-* abstract socket name),
DAFEIYU_CONNECTION_CAPABILITY (canonical 32-byte base64url capability), and
DAFEIYU_CONNECTION_GENERATION (bridge UUID). The shared package detects these
on any Node platform and uses AndroidBridgeTransport. It constructs the
abstract socket endpoint by prefixing a NUL byte, adds a fresh 24-byte
base64url nonce to every request, and never falls back to PC for malformed
Android parameters. Runtime must support Node abstract Unix sockets.

Mobile must start the bridge, launch Node with that environment, bindRuntime
to the actual Node PID before loading plugins, and close the bridge on runtime
stop/restart. UID/PID/capability enforcement belongs to the native bridge.
Never persist or log capability. This is IPC authorization, not an Aries key.
Responses must use success, not ok. File bytes use standard base64; the
capability and nonce use base64url. All scoped methods retain params.group_id;
native compares it with the currently selected group and rejects mismatch.
The package does not claim this startup wiring or Android device E2E has
already been verified.

## Runtime Boundaries

Pause/resume operate on the real persisted queue. Upload uses all active peers,
stable idempotency keys and confirmed chunks. Group changes cancel work.
Incoming files use path validation, hash checking, same-directory staging and
rename; default conflicts preserve local changes. Incoming listing is bounded
to ten pages and 256 descriptors and fails closed on repeated cursors.

Watch mode performs periodic create/update scanning. Remote deletion/rename,
OS filesystem event debounce, partially downloaded chunk resume and notification
UI delivery are not implemented in this runtime. Mute is persisted for host UI;
history remains available. Each upload currently reads the bounded file into
memory. Provider may enforce tighter file limits than plugin configuration.
No real device pairing or production pipe E2E is implied by isolated tests.
