# @k9o/cli

`k9o` is the Kilimanjaro command-line tool. Sign in, manage projects, apply migrations, deploy functions, and query audit events.

Kilimanjaro is an AI-native platform on a Governed Database. Its products are Keep (AI Security and Governance), Pulse (Data Intelligence), Gate (Customer Identity and Access Management) and Kibo (Keys and Secrets Management).

## Contents

- [Links](#links)
- [Install](#install)
- [Quick start](#quick-start)
- [Sign in](#sign-in)
- [Choose a project](#choose-a-project)
- [Run a command](#run-a-command)
- [Read output and exit codes](#read-output-and-exit-codes)
- [Appendix](#appendix)

## Links

- Website: <https://kilimanjaro.dev>
- Documentation / Developer Hub: <https://docs.kilimanjaro.dev>
- Platform API: <https://api.k9o.io>
- Platform Console: <https://console.k9o.io>
  - [Command reference](#command-reference)
  - [Global flags](#global-flags)
  - [Environment variables](#environment-variables)
  - [Exit codes](#exit-codes)
  - [Related packages](#related-packages)

## Install

```bash
npm install -g @k9o/cli
```

Bun works too: `bun add -g @k9o/cli`.

- Requires Node.js or Bun.
- Docker is needed only for the [local stack commands](#local-development-stack-k9o-stack).

Check the install:

```bash
k9o --version
```

```text
k9o/1.0.0 api/v2
```

## Quick start

The examples use an organization `acme` with a project `member-portal`.

```bash
k9o login --org acme --project member-portal
k9o whoami
```

```text
me@acme.com (usr_...) on org=acme project=member-portal (profile=default)
```

See the [command reference](#command-reference) for everything else you can run.

## Sign in

`k9o login` asks for your email and password, then saves the session in `~/.k9o/credentials` (mode `0600`). Every other command uses it.

- Pass `--org` and `--project`. Nothing else is needed for the platform at `https://api.k9o.io`.
- Email and password are prompted for when you leave them out.
- `k9o logout` clears the saved session.
- For a custom host, add `--base-url` with the full organization host.

```bash
k9o login --base-url https://platform.example.com --org acme --project member-portal
```

Each setting also has an environment variable. See [environment variables](#environment-variables).

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
  1  create-tasks  2026-01-15T09:30:00.000Z
```

Invoke a deployed function:

```bash
k9o function invoke add-numbers --payload '{"x": 1, "y": 2}'
```

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
→ k9o login --base-url <url> --org <slug> --project <slug>
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
| `k9o login` | Sign in and save the session |
| `k9o logout` | Clear the saved session |
| `k9o whoami` | Print the active identity |
| `k9o init` | Guided setup: sign in and pick an active project |

#### Projects: `k9o project`

| Command | What it does |
|---|---|
| `list` | List projects you can access |
| `create <slug> [--name]` | Create a project (`--custody-mode managed\|byok\|hyok`) |
| `get <slug>` | Show one project |
| `set-active <slug>` | Make it the active project for this profile |

#### Migrations: `k9o migration`

| Command | What it does |
|---|---|
| `list` | List applied migrations |
| `apply <file>` | Apply migrations from a JSON file |
| `pending` | List queued migrations |
| `apply-pending <pendingId>` | Apply a queued migration |

#### Functions: `k9o function`

| Command | What it does |
|---|---|
| `deploy <file>` | Deploy a function (`--code-file <bundle>`) |
| `list` | List deployed functions |
| `get <name>` | Show one function |
| `invoke <name>` | Run it (`--payload <json>` or `--payload-file <path>`) |
| `delete <name>` | Retire a function |

| `deploy` option | Values |
|---|---|
| `--runtime` | `wasm`, `bun`, `node` |
| `--tier` | `low`, `medium`, `high` |
| `--name` | Function name override |

#### Policies: `k9o policy`

A file with a top-level `include` array pulls in other files' rules.

| Command | What it does |
|---|---|
| `list` | List bundles (`--status draft\|published\|deactivated`) |
| `current` | Show the active policy |
| `get <id>` | Show one bundle |
| `validate <file>...` | Lint policy files without saving |
| `apply <file>... --name <name>` | Create a draft bundle |
| `publish <id>` | Activate a draft bundle |

#### Audit: `k9o audit`

| Command | What it does |
|---|---|
| `tail` | Show recent events (`--since-minutes`, default 5; `--limit`, default 100) |
| `query` | Search history |
| `export <file>` | Write results to an NDJSON file |

| `query` and `export` flag | Filters by |
|---|---|
| `--since`, `--until` | Time range |
| `--type` | Event type |
| `--actor` | Actor id |
| `--target-kind`, `--target-id` | Target |
| `--limit`, `--cursor` | Page size and position |

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
| `reveal <name>` | Show the plaintext value |
| `update <name>` | Set a new value |
| `rotate <name>` | Re-wrap under a fresh key |
| `move <name> --new-path <path>` | Rename the path |
| `delete <name>` | Retire a secret |

`create` and `update` take `--value` (prompted if omitted) and `--metadata k=v,k2=v2`. `create` also takes `--visibility private|shared`.

#### Storage: `k9o storage`

| Command | What it does |
|---|---|
| `buckets list\|get\|create\|update\|delete` | Manage buckets |
| `objects upload <bucket> <path>` | Upload (`--file <path>` or `--stdin`) |
| `objects list <bucket>` | List objects (`--prefix`) |
| `objects sign <bucket> <path>` | Make a signed download URL (`--expires-in <seconds>`) |
| `objects delete <bucket> <path>` | Delete an object |
| `locations list` | List your own object stores |
| `locations create` | Register one from a credential reference |
| `locations get <id>` | Show one location |
| `locations update <id>` | Change a location |
| `locations retire <id>` | Retire a location |
| `locations test <id>` | Dry-run check |

#### Own-store credentials: `k9o byos-cred`

| Command | What it does |
|---|---|
| `create <name>` | Store a cloud credential in the vault and print a `kibo://byos-creds/<id>` reference |

Pass that reference to `k9o storage locations create --credential-ref`.

#### AI: `k9o ai`

| Command | What it does |
|---|---|
| `embed <text>...` | Turn each text into a vector (`--model <id>`) |
| `embed --file <path\|->` | Embed a whole file or stdin as one input |

#### Extensions: `k9o ext-admin` and `k9o ext`

`k9o extension-admin` and `k9o extension` are aliases.

| Command | What it does |
|---|---|
| `ext-admin list` | List installed extensions |
| `ext-admin available` | List extensions you can install |
| `ext-admin enable <slug>` | Enable an extension |
| `ext-admin disable <slug>` | Disable an extension |
| `ext-admin config <slug>` | Read or change config (`--get`, `--set <json>`) |
| `ext <slug> <verb>` | Run a command the extension declares |

#### Organization: `k9o org`

| Group | Verbs |
|---|---|
| `get` | Read the organization |
| `members` | `list`, `invite`, `get`, `remove` |
| `groups` | `list`, `create`, `get`, `delete` |
| `roles` | `list`, `grant`, `revoke` |
| `audit` | `tail`, `query` |
| `smtp` | `get`, `set`, `test`, `unset` |
| `idp` | `list`, `configure`, `delete` |

#### Your account: `k9o me`

| Group | Verbs |
|---|---|
| `profile` | `get`, `update` |
| `sessions` | `list`, `revoke`, `revoke-all` |
| `api-tokens` | `list`, `create`, `delete` |
| `notifications` | `list`, `mark-read`, `mark-all-read` |
| `audit-log` | `query` |
| `data-export` | `request`, `status` |

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

`k9o up` is an alias for `k9o stack up`.

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
| `k9o ledger verify` | Verify an exported audit ledger offline (`--file <path>` or `--stdin`) |
| `k9o completion <shell>` | Print a completion script for `bash`, `zsh` or `fish` |

```bash
source <(k9o completion bash)
```

### Global flags

These work on every command.

| Flag | What it does |
|---|---|
| `--project <slug>` | Override the project |
| `--org <slug>` | Override the organization |
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
| `K9O_ORG` | `--org` | |
| `K9O_PROJECT` | `--project` | |
| `K9O_PROFILE` | `--profile` | Default `default` |
| `K9O_OUTPUT` | `--output` | `human` or `json` |
| `K9O_BASE_URL` | `--base-url` | Login only |
| `K9O_EMAIL` | `--email` | Login only |
| `K9O_PASSWORD` | `--password` | Login only |

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
