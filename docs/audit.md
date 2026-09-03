# Auditd and Client Audit

AirKit's audit layer is a local, metadata-first evidence pipeline. It is
intended to answer *which client, repository, provider account, model, request,
usage, cache counters, and collection gaps were observed* without putting raw
prompts or credentials in normal query output.

Auditd is a collector boundary, not a provider health check and not a
guarantee that every client is fully observable. Always check the client
completeness and evidence gaps after enabling it.

Audit is not itself Sensitive Egress Shield enforcement. Shield is disabled by
default, and enforcement applies only to its declared, explicitly enabled
launcher lanes. When such a lane is enabled, Shield requires a metadata-only
Audit acknowledgement or encrypted-spool capacity before forwarding. Neither a
healthy audit daemon nor an Audit UI row proves that a direct or undeclared
client was intercepted, blocked, or redacted. See the Shield section in
[`install.md`](install.md) for provisioning, coverage, and bypass boundaries.

## Browser audit UI

AirKit registers an `AirKit Audit` app on a loopback-only CCR HTTP backend. The
app URL contains a per-boot, one-time `bootstrap` value. Opening that URL
exchanges the value for an HttpOnly, SameSite session cookie; the bootstrap
value is then invalid and is never written into the page or browser storage.
The backend serves:

- `GET /` (bootstrap or existing session)
- `GET /api/status`
- `GET /api/query?name=<query>[&id=<request-id>]`

The CCR browser management page cannot open plugin apps because its
`openPluginApp` bridge is Electron-only. The supported browser entry point is:

```bash
airkit audit open
```

It opens the current loopback-only UI without printing or persisting its URL in
the terminal. The underlying bootstrap URL is stored in a `0600` runtime file
only until the first successful open, then becomes invalid. If `audit open`
reports `audit_ui_not_ready`, run `airkit audit start`, then restart or update
the CCR plugin host so it can register a fresh app URL. A CCR Electron client
can also open the `AirKit Audit` app entry directly. Do not paste a CCR gateway
key into a URL. Direct navigation to the old `/plugins/airkit-audit` gateway
path is no longer supported.

The UI contract is intentionally narrower than the SQLite schema. It projects
metadata only, always returns `metadata_only: true` and `payload_included:
false`, and strips absolute paths, URLs, payload fields, and common
credential-like values before they reach the browser. Supported query names are
`requests`, `request`, `sessions`, `clients`, `accounts`, `repos`, `usage`,
`cache`, and `gaps`. Unknown query names, oversized arguments, and degraded
query/status paths return a bounded error or gap code instead of exposing raw
collector errors.

Status is also projected through an allowlist. A healthy or degraded response
may include only:

- `database.present` and `database.ok`
- `service.installed`, `service.loaded`, and `service.stale` when that status
  is available from the caller
- `keychain.present`

Treat the UI as a convenience surface for the same audit evidence, not as a
different source of truth. A healthy page still requires the same completeness
and gap checks as the CLI.

## Enable the local service

The commands below are macOS commands because the service is installed as a
per-user `launchd` agent (`com.airkit.auditd`). Start with a read-only preview:

```bash
airkit audit status
airkit audit install
```

Review the printed LaunchAgent path, socket paths, and operations. To write the
service and create the audit master-key record in the macOS Keychain:

```bash
airkit audit install --write
airkit audit start
airkit audit status
airkit audit doctor
airkit audit verify
```

`install` is preview-only unless `--write` is present. `start` can install a
missing plist as a convenience, but the explicit preview/write sequence is
easier to review. `status` inspects the launch agent, Keychain record, and
database. `doctor` performs the same inspection and marks the result as
checked. `verify` checks the SQLite schema and integrity; it does not prove that
a provider request succeeded or that every client is connected.

The default state directory is:

```text
~/.local/state/airkit-audit/
```

It contains the SQLite database, encrypted spool, Unix sockets, and backups.
Use `AIRKIT_AUDIT_DATABASE_PATH`, `AIRKIT_AUDIT_BACKUP_DIR`, or the path
overrides supported by the CLI when a different local state location is
required. Do not put this state directory in the repository.

Stop the user service without deleting its database with:

```bash
airkit audit stop
```

## What is covered

The current audit contract has these source/client lanes:

| Client/source | Evidence available | Completeness caveat |
| --- | --- | --- |
| `airclaude` / CCR compatibility | request lifecycle, route/provider attempts, response/usage, failure and session metadata when an audit emitter is supplied | Provider/cache evidence is still reported as `metadata_only` when the upstream response does not expose it. |
| Claude Code JSONL / hook | bounded session metadata, request start, allowlisted usage counters | It does not parse arbitrary transcript text or infer provider attempts that are absent from the JSONL. |
| `airpi` / Pi | session lifecycle and allowlisted usage through the managed extension | The extension is installed when the AirKit audit runtime is explicitly passed to the launcher; it is not a promise that an unrelated Pi invocation is captured. |
| `airoc` / OpenCode | adapter routing plus OpenCode SQLite message/session counters | Unknown or changed OpenCode schemas produce a collector gap instead of guessed data. |
| Codex / `codex-desktop` | bounded JSONL session/task/token metadata | The measured contract does not expose provider attempts; this lane is normally `metadata_only`. |
| Headroom | bounded JSONL savings/cost counters and optional exact AirKit event links | Unlinked rows remain `bounded_time_candidate`; they are never silently attached to a request. |
| CCR request logs | request/provider/model/status and response usage where CCR recorded it | CCR logs and client transcripts are separate evidence sources; compare correlation confidence before attributing a request. |

The fixture verifier lists the supported client names and intentionally keeps
live verification opt-in:

```bash
node scripts/verify-audit-clients.mjs
node scripts/verify-audit-clients.mjs --live airclaude
```

The default command uses fixtures only. `--live` accepts exactly one supported
client and reports that an explicit probe is required; it does not silently
launch a client or send a provider request. A healthy auditd service therefore
does not by itself mean that `claude-sub`, Pi, OpenCode, Codex, or Headroom has
been captured. Check `audit clients` and `audit gaps` for the current machine.

Client completeness is deliberately conservative. The current aggregate query
marks a client as:

- `complete` only when both a provider request and a usage report have been
  observed
- `metadata_only` when bounded metadata was observed without the full request +
  usage pair
- `gap` when no captured evidence exists for that lane

This is why Codex and some JSONL-backed sources usually remain
`metadata_only`: their measured contract exposes session/task/token metadata,
not provider attempts or raw payloads.

## Query the evidence

All query commands return metadata-only rows and sanitize sensitive field names
and absolute paths before writing to the terminal:

```bash
airkit audit clients
airkit audit requests
airkit audit request <request-id>
airkit audit sessions
airkit audit accounts
airkit audit repos
airkit audit usage
airkit audit cache
airkit audit gaps
```

Use `clients` first. A client row is `complete` only when both a provider
request and a usage report have been observed. `metadata_only` and `gap` are
also not successful-capture claims; investigate the corresponding source and
`gaps` rows. Fixture or source-specific intermediate states may exist during
testing, but the shipped aggregate client query reports `complete`,
`metadata_only`, or `gap`. `request` accepts a request or logical-request ID
and keeps provider attempts separate, which matters when CCR falls back.

`gaps` combines both evidence gaps and collector gaps. Read it literally:

- evidence gap: the collector observed enough structure to say a specific
  request/session/client is missing expected evidence
- collector gap: the collector could not safely parse or persist a source lane
  and recorded that failure as metadata

Unknown external schemas, unreadable bounded inputs, or collector failures
should surface as gaps. They must not be filled in with guessed provider,
request, or payload text.

Repository and provider-account labels are explicit metadata operations. They
preview by default and require `--write`:

```bash
airkit audit repo classify <repository-id> <classification>
airkit audit repo classify <repository-id> personal --write
airkit audit account group <account-id> <logical-group>
airkit audit account group <account-id> personal-main --write
```

These commands change only the classification/group fields; they do not change
provider credentials, routing, or model inputs.

## Export and retention

The safe export is metadata-only and can be written atomically to a file:

```bash
airkit audit export --format jsonl --output ./audit-metadata.jsonl
airkit audit export --format csv --output ./audit-metadata.csv
```

Payload evidence is excluded by default. A decrypted payload export is a
separate, deliberately gated operation:

```bash
airkit audit export \
  --format jsonl \
  --output ./audit-evidence.jsonl \
  --include-payload --decrypt
```

The reveal path requires an interactive confirmation and the configured
`airkit-audit-auth` helper backed by a Secure Enclave user-presence key. It
rejects non-interactive stdout exports, requires an output path, binds the
authorization to the exact export manifest, and consumes the short-lived
challenge once. If the helper is unavailable, keep using metadata-only export;
do not bypass the gate by copying database or spool files.

Both flags are required for reveal: `--include-payload` asks for payload
columns, and `--decrypt` asks to unwrap them. A decrypt-only request is
rejected. The reveal authorization is single-use and is bound to the exact set
of rows and output manifest, so a later row swap or replay must fail closed.

Preview payload retention before changing anything:

```bash
airkit audit prune --retention-days 90
airkit audit prune --retention-days 90 --write
```

Retention removes expired encrypted payload blobs in bounded batches and keeps
normalized metadata. `--preserve` is an explicit no-op safety switch.

This split is intentional: `prune` changes retention state for encrypted
payload blobs, not the normalized request/usage/cache metadata that powers the
queries above. A successful prune should therefore reduce revealable payload
surface without making past request metadata disappear.

## Security boundary

- The audit master key is stored in the macOS Keychain under service
  `ai-runtime-kit.audit`. New records use `payload-master-v2`; `payload-master-v1`
  remains a read-only compatibility fallback. The key is never a CLI argument
  or normal log field.
- The daemon accepts one length-bounded frame per Unix-socket connection. The
  socket and state directories are created with owner-only permissions, and
  frames require a capability HMAC before decryption.
- Event payloads are redacted before persistence. Usage, cache, provider,
  model, client, status, and provenance fields are allowlisted where a source
  adapter defines them. Request payload evidence, when captured, is encrypted
  separately; ordinary SQLite queries and exports do not decrypt it.
- The normal audit path is fail-open for the caller: a collector failure emits
  a bounded `collector_gap` where possible and must not break a model request.
  This means missing audit evidence is possible and must be monitored.
- Request correlation uses exact event/request identities where available.
  Time-based candidates are labeled as candidates and must not be treated as
  proof that two client/provider records are the same request.

Never paste the database, spool, Keychain output, provider API keys, or decrypted
export into an issue or chat. Share a sanitized query result plus the relevant
`gaps` rows instead.

## A practical verification checklist

After enabling auditd and launching a client workload:

```bash
airkit audit status
airkit audit verify
airkit audit clients
airkit audit requests
airkit audit usage
airkit audit cache
airkit audit gaps
```

Treat the setup as audit-ready only when the service is `healthy`, the database
passes `verify`, the expected client appears in `clients`, and its completeness
matches the evidence you need. A `healthy` daemon with no client rows is a
healthy empty collector, not proof of coverage.
