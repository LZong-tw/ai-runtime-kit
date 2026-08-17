# Auditd and Client Audit

AirKit's audit layer is a local, metadata-first evidence pipeline. It is
intended to answer *which client, repository, provider account, model, request,
usage, cache counters, and collection gaps were observed* without putting raw
prompts or credentials in normal query output.

Auditd is a collector boundary, not a provider health check and not a
guarantee that every client is fully observable. Always check the client
completeness and evidence gaps after enabling it.

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
request and a usage report have been observed. `metadata_only`, `partial`, and
`gap` are not successful-capture claims; investigate the corresponding source
and `gaps` rows. `request` accepts a request or logical-request ID and keeps
provider attempts separate, which matters when CCR falls back.

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

Preview payload retention before changing anything:

```bash
airkit audit prune --retention-days 90
airkit audit prune --retention-days 90 --write
```

Retention removes expired encrypted payload blobs in bounded batches and keeps
normalized metadata. `--preserve` is an explicit no-op safety switch.

## Security boundary

- The audit master key is stored in the macOS Keychain under service
  `ai-runtime-kit.audit` and account `payload-master-v1`; it is not a CLI
  argument or normal log field.
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
