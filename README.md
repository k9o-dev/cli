# @k9o/cli

`k9o` is the Kilimanjaro command-line tool. Sign in, manage projects, apply migrations, deploy functions, and query audit events.

Kilimanjaro is the AI-native foundation for building critical applications. Its products are Keep (AI Security and Governance),
Pulse (Data Intelligence), Gate (Customer Identity and Access Management) and Kibo (Keys and Secrets Management).

## Contents

- [Links](#links)
- [Install](#install)
- [Quick start](#quick-start)
- [Sign in](#sign-in)
- [Choose a project](#choose-a-project)
- [Run a command](#run-a-command)
- [Read output and exit codes](#read-output-and-exit-codes)
- [Appendix](#appendix)
  - [Command reference](#command-reference)
  - [Global flags](#global-flags)
  - [Environment variables](#environment-variables)
  - [Exit codes](#exit-codes)
  - [Related packages](#related-packages)

## Links

- Website: <https://kilimanjaro.dev>
- Documentation / Developer Hub: <https://docs.kilimanjaro.dev>
- Platform API: <https://api.k9o.io>
- Platform Console: <https://console.k9o.io>

## Install

```bash
npm install -g @k9o/cli
```

Bun works too: `bun add -g @k9o/cli`.

- Requires Node.js or Bun.
- The [local stack commands](#local-development-stack-k9o-stack) also need Docker and a `k9o-core` checkout.

Check the install:

```bash
k9o --version
```

```text
k9o/1.3.0 api/v2
```

## Quick start

The examples use an organization `acme` with a project `member-portal`.

```bash
k9o login --org acme --project member-portal
k9o whoami
```

```text
Signed in as me@acme.com (usr_...) on org=acme project=member-portal (profile=default)
me@acme.com (usr_...) on org=acme project=member-portal (profile=default)
```

See the [command reference](#command-reference) for everything else you can run.

## Sign in

`k9o login` signs you in as an operator, not as a project end user. It saves the session in `~/.k9o/credentials` (mode `0600`).
Every other command uses it.

- Email and password are prompted for when you leave them out.
- If your organization requires MFA, you are asked for an authenticator code. Enroll an authenticator in the Console first.
- Password sign-in is the interim method until browser-based device authorization lands.
- `--org` picks your organization. `--project` is optional and sets the active project.
- `k9o logout` clears the saved session.

```bash
k9o login --org acme
```

```text
Signed in as me@acme.com (usr_...) on org=acme (no active project; run `k9o project set-active <slug>`) (profile=default)
```

For a custom host, add `--base-url` with the apex or the full organization host.

```bash
k9o login --base-url https://platform.example.com --org acme
```

Each setting also has an environment variable. See [environment variables](#environment-variables).

### Scripts and CI

Pass the MFA code with `--mfa-code` or `K9O_MFA_CODE` when there is no terminal to prompt on.
For CI, skip the login and use a service token. It takes precedence over a saved login.

```bash
K9O_SERVICE_TOKEN=... K9O_ORG=acme K9O_PROJECT=member-portal k9o migration apply migrations.json
```

### Several identities

Log in under different profiles to keep them side by side.

```bash
k9o login --profile staging --org acme --project member-portal
k9o whoami --profile staging
```

## Choose a project

Project-scoped commands need a project. The first one found is used:

- The `--project` flag.
- The `K9O_PROJECT` environment variable.
- The active project saved on the profile.

Save an active project once:

```bash
k9o project set-active member-portal
```

If none is set, the command exits with code 65. See [exit codes](#exit-codes).

## Run a command

Commands are grouped: `k9o <group> <subcommand>`. List the groups, or the subcommands of one group:

```bash
k9o --help
k9o migration --help
```

Apply a migration from a JSON file shaped like `{ "migrations": [{ "version", "slug", "up", "down" }] }`:

```bash
k9o migration apply migrations.json
```

```text
Applied 1 migration(s):
  1  create-tasks
```

List the projects you can access:

```bash
k9o project list
```

```text
Projects:
  member-portal                   Member Portal                             PLATFORM_MANAGED   de01    prj_01j9x2k4m7
```

`k9o function invoke add-numbers --payload '{"x": 1, "y": 2}'` runs a deployed function and prints its result as JSON.

Full list: [command reference](#command-reference). Flags that work everywhere: [global flags](#global-flags).

## Read output and exit codes

Human output is for people. Use `--output json` in scripts and CI.

```bash
k9o whoami --output json
```

```json
{
  "data": {
    "profile": "default",
    "userId": "usr_...",
    "email": "me@acme.com",
    "orgSlug": "acme",
    "activeProjectSlug": "member-portal",
    "baseUrl": "https://acme.api.k9o.io"
  },
  "meta": {}
}
```

Failures go to stderr and set the exit code. With `--output json` stderr holds `{ code, message, context, recommendation }`.

```bash
k9o whoami --profile missing
```

```text
[UNAUTHENTICATED] No credentials for profile "missing". Run `k9o login` first.
→ k9o login --org <slug>   (or set K9O_SERVICE_TOKEN for CI)
```

The most useful codes:

| Exit code | Meaning |
|---|---|
| 0 | Success |
| 2 | Usage error |
| 65 | Missing project or organization |
| 66 | Not signed in |

All of them are in [exit codes](#exit-codes).

## Appendix

### Command reference

Run `k9o <group> --help` for the same list in your terminal.

#### Session

| Command | What it does |
|---|---|
| `k9o login` | Sign in as an operator and save the session |
| `k9o logout` | Clear the saved session |
| `k9o whoami` | Print the active identity |
| `k9o init` | Guided setup: sign in and pick an active project |

| `login` flag | Meaning |
|---|---|
| `--org`, `--project`, `--base-url` | Organization, optional active project, custom host |
| `--email`, `--password` | Skip the prompts |
| `--mfa-code` | Authenticator code, for scripts |

#### Projects: `k9o project`

| Command | What it does |
|---|---|
| `list` | List projects you can access |
| `create <slug>` | Create a project |
| `get <slug>` | Show one project |
| `set-active <slug>` | Make it the active project for this profile |

| `create` flag | Meaning |
|---|---|
| `--name <text>` | Display name; defaults to the slug |
| `--region <code>` | Platform region, such as `de01` |
| `--custody-mode` | `PLATFORM_MANAGED`, `SKR`, `BYOK` or `HYOK` |

#### Migrations: `k9o migration`

| Command | What it does |
|---|---|
| `list` | List applied migrations (alias `status`) |
| `apply <file>` | Apply migrations from a JSON file |
| `pending` | List queued migrations |
| `apply-pending <pendingId>` | Apply a queued migration |

#### Functions: `k9o function`

| Command | What it does |
|---|---|
| `deploy [<manifest.json>]` | Upload an artifact and deploy a function |
| `list` | List deployed functions |
| `get <name>` | Show one function |
| `invoke <name>` | Run it (`--payload <json>` or `--payload-file <path>`) |
| `delete <name>` | Retire a function; the name is reusable after 24 hours |

| `deploy` flag | Meaning |
|---|---|
| `--name`, `--version` | Function name and version label |
| `--runtime` | `bun`, `python`, `go`, `java`, `kotlin`, `dotnet`, `swift`, `php`, `ruby`, `rust`, `tinygo`, `zig` or `assemblyscript` |
| `--tier` | `gateway` (a `.wasm` artifact, platform operators only) or `sandbox` (a `.tar` artifact) |
| `--artifact <file>` | Upload this file as the artifact |
| `--artifact-key <key>` | Use an artifact you already uploaded; not with `--artifact` |
| `--description <text>` | Optional description |

Flags override the same fields in the manifest file.

```bash
k9o function deploy --name my-fn --runtime go --tier sandbox --version 1 --artifact ./fn.tar
```

```text
Function my-fn (fn_...) — runtime=go tier=sandbox status=active
```

#### Policies: `k9o policy`

A file with a top-level `include` array pulls in other files' rules. Several files are composed into one document.

| Command | What it does |
|---|---|
| `list` | List bundles (`--status draft\|published\|superseded`) |
| `current` | Show the published policy |
| `get <id>` | Show one bundle |
| `validate <file>...` | Lint policy files without saving |
| `apply <file>...` | Create a draft bundle |
| `publish <id>` | Activate a draft bundle; a second approver may be needed |

#### Audit: `k9o audit`

| Command | What it does |
|---|---|
| `tail` | Fetch the last few minutes of events once; not a live stream |
| `query` | Search history |
| `export <file>` | Write all matching events to an NDJSON file |

| Flag | Meaning |
|---|---|
| `--since-minutes`, `--limit` | `tail` only; defaults 5 and 100 |
| `--event-type` | Event type |
| `--actor` | Actor id |
| `--after`, `--before` | ISO time range |
| `--limit`, `--cursor` | Page size (1 to 200) and position |

```bash
k9o audit tail --since-minutes 10
```

```text
2 event(s) in the last 10 minute(s):
  2026-01-15T09:31:02.000Z  migration.applied                         actor=usr_...  target=migration:1
  2026-01-15T09:30:41.000Z  auth.signin                               actor=usr_...  target=-:-
```

#### Vault secrets: `k9o vault-secret`

Every command except `list` needs `--region`.

| Command | What it does |
|---|---|
| `list` | List secret metadata (`--prefix`, `--cursor`, `--limit`) |
| `get <name>` | Show one secret's metadata |
| `create <name>` | Seal a new secret |
| `reveal <name>` | Mint a challenge and show the plaintext value |
| `update <name>` | Set a new value |
| `rotate <name>` | Re-wrap under a fresh key |
| `move <name> --new-path <path>` | Rename the path |
| `delete <name>` | Retire a secret |

`create` and `update` take `--value` (prompted if omitted) and `--metadata k=v,k2=v2`. `create` also takes `--visibility private|shared`.

#### Storage: `k9o storage`

| Command | What it does |
|---|---|
| `buckets list` | List buckets |
| `buckets get <name>` | Show one bucket |
| `buckets create <name>` | Create a bucket |
| `buckets update <name>` | Change a bucket |
| `buckets delete <name>` | Delete a bucket; `--empty` removes its objects first |
| `objects upload <bucket> <path>` | Upload (`--file <path>` or `--stdin`) |
| `objects list <bucket>` | List objects (`--prefix`) |
| `objects sign <bucket> <path>` | Make a signed download URL |
| `objects delete <bucket> <path>` | Delete an object |
| `locations list\|get\|create\|update\|retire\|test` | Manage your own object stores |

| Flag | Used by | Meaning |
|---|---|---|
| `--file-size-limit <bytes>` | buckets create, update | Largest object size |
| `--allowed-mime-types <a,b>` | buckets create, update | Allowed content types |
| `--location <locationId>` | buckets create, update | Link the bucket to a storage location |
| `--content-type`, `--upsert`, `--metadata k=v` | objects upload | Content type, overwrite, labels |
| `--expires-in <seconds>` | objects sign | Required, 1 to 604800 |
| `--download` | objects sign | Make the URL download the file |

- On `buckets update`, `--clear-file-size-limit`, `--any-mime-type` and `--unlink-location` remove a setting.
- The gateway caps a signed URL at 900 seconds, whatever you ask for. The CLI prints a note when it does.
- `locations create` needs `--provider`, `--bucket-name`, `--region`, `--provider-region` and `--credential-ref`.
- Optional `locations` flags: `--endpoint-override` and `--custody-mode PLATFORM_MANAGED|BYOK|HYOK`.
- Providers are `s3`, `s3_compatible`, `gcs`, `azure_blob`, `minio`, `r2` and `b2`.
- `r2` also needs `--account-id` and `--parent-access-key-id`. `b2` needs `--bucket-id`.

#### Own-store credentials: `k9o byos-cred`

| Command | What it does |
|---|---|
| `create <name>` | Store a cloud credential in the vault and print a `kibo://byos-creds/<id>` reference |

- `--provider` is `s3`, `s3_compatible`, `minio`, `gcs`, `b2` or `r2`.
- `--region` is required (or `K9O_BYOS_REGION`). `--provider-region` is also required for `s3`, `s3_compatible` and `minio`.
- Pass that reference to `k9o storage locations create --credential-ref`.

#### AI: `k9o ai`

| Command | What it does |
|---|---|
| `embed <text>...` | Turn each text into a vector (`--model <id>`) |
| `embed --file <path\|->` | Embed a whole file or stdin as one input |

Run it as a project member. An end user's token is refused.

#### Extensions: `k9o ext-admin` and `k9o ext`

`k9o extension-admin` and `k9o extension` are aliases.

| Command | What it does |
|---|---|
| `ext-admin list` | List extensions installed on the project |
| `ext-admin enable <slug>` | Enable an extension |
| `ext-admin disable <slug>` | Disable an extension |
| `ext-admin config <slug>` | Show the config, or merge a JSON object with `--set <json>` |
| `ext <slug> <verb>` | Run a command the extension declares |

`ext` works for a signed-in operator only. A service token or personal access token is refused.

#### Organization: `k9o org`

| Group | Verbs |
|---|---|
| `get` | Read the organization |
| `members` | `list`, `invite`, `remove` |
| `groups` | `list`, `get` (read-only) |
| `roles` | `list`, `grant`, `revoke` |
| `audit` | `query` |
| `smtp` | `set`, `test`, `unset` |
| `idp` | `list`, `create`, `configure`, `delete` |

#### Your account: `k9o me`

| Group | Verbs |
|---|---|
| `profile` | `get`, `update` |
| `sessions` | `list`, `revoke`, `revoke-all` |
| `api-tokens` | `list`, `create`, `delete` |

#### Local settings: `k9o config`

Defaults for the active profile are kept in `~/.k9o/config.json`.

| Command | What it does |
|---|---|
| `set <key> <value>` | Set a key |
| `get <key>` | Read a key |
| `unset <key>` | Clear a key |
| `list` | List all keys |

| Key | Values |
|---|---|
| `outputFormat` | `human`, `json` |
| `color` | `true`, `false` |

#### Local development stack: `k9o stack`

These commands need `run.sh` from a `k9o-core` checkout. The npm package does not ship it.
Run them inside a checkout, or set `K9O_RUNSH_PATH`. `k9o up` is an alias for `k9o stack up`.

| Command | What it does |
|---|---|
| `up` | Start the stack |
| `down` | Stop it and keep data |
| `nuke [--yes]` | Stop it and wipe data |
| `status` | Print health and endpoints |
| `logs [service]` | Tail logs |
| `showroom list` | List demo verticals (run as `k9o showroom list`) |
| `showroom <slug>` | Provision a demo project (run as `k9o showroom <slug>`) |
| `doctor` | Check Docker, ports and disk (run as `k9o doctor`) |

| Tier flag | Adds |
|---|---|
| `--minimal` | Gateway and Postgres only |
| `--ai` | Local model inference |
| `--full` | Real vault custody |

#### Utilities

| Command | What it does |
|---|---|
| `k9o ledger verify` | Verify an exported audit ledger offline |
| `k9o completion <shell>` | Print a completion script for `bash`, `zsh` or `fish` |

- `ledger verify` takes `--file <path>` or `--stdin`, and optionally `--key-set` with `--signature`, and `--format json|ndjson`.
- It needs the `kibo-ledger-verify` binary on `PATH`, or `K9O_LEDGER_VERIFY_BIN`. The npm package does not ship it.

```bash
source <(k9o completion bash)
```

### Global flags

These work on every command.

| Flag | What it does |
|---|---|
| `--project <slug>` | Override the project |
| `--org <slug>` | Override the organization |
| `--base-url <url>` | Gateway host; used by `login`, `init` and service-token runs |
| `--output human\|json` | Choose the output format |
| `--profile <name>` | Choose the profile |
| `--no-color` | Turn off colors (also honors `NO_COLOR`) |
| `--quiet`, `-q` | Hide non-essential output |
| `--verbose`, `-v` | Print debug diagnostics |
| `--help`, `-h` | Show help |

### Environment variables

The flag wins when both are set.

| Variable | Same as | Notes |
|---|---|---|
| `K9O_SERVICE_TOKEN` | | Bearer token for CI. No login needed; set the org and project too |
| `K9O_ORG` | `--org` | |
| `K9O_PROJECT` | `--project` | |
| `K9O_PROFILE` | `--profile` | Default `default` |
| `K9O_OUTPUT` | `--output` | `human` or `json` |
| `K9O_BASE_URL` | `--base-url` | `login`, `init` and service-token runs |
| `K9O_EMAIL` | `--email` | Login only |
| `K9O_PASSWORD` | `--password` | Login only |
| `K9O_MFA_CODE` | `--mfa-code` | Login only |
| `K9O_RUNSH_PATH` | | Path to `run.sh` for the local stack commands |
| `K9O_LEDGER_VERIFY_BIN` | | Path to the `kibo-ledger-verify` binary |

### Exit codes

| Exit code | Meaning |
|---|---|
| 0 | Success |
| 1 | Generic or unclassified error |
| 2 | Usage error (missing argument, unknown command) |
| 64 | Local config file is malformed |
| 65 | Missing project or organization |
| 66 | Not signed in or sign-in failed (HTTP 401) |
| 67 | Not permitted (HTTP 403) |
| 68 | Not found (HTTP 404) |
| 69 | Conflict or already exists (HTTP 409) |
| 70 | Invalid request (HTTP 400) |
| 71 | Request rejected as invalid (HTTP 422) |
| 72 | Plan or rate limit reached (HTTP 429) |
| 73 | Service unavailable (HTTP 5xx) |
| 74 | Token or session expired (HTTP 410) |
| 75 | Lifecycle conflict, such as a soft-deleted project |

### Related packages

| Package | Purpose |
|---|---|
| `@k9o/core` | The TypeScript SDK the CLI is built on |
| `@k9o/kibo` | Vault and client-side encryption |

## License

Apache-2.0 © Formelo Inc. See `LICENSE` and `NOTICE`.
