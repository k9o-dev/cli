# Changelog — @k9o/cli

## 1.4.0 (unreleased)

### Added

- `k9o ai generate <prompt|-> [--model <id>] [--max-tokens N] [--temperature T]` prints generated text; usage goes to stderr.
- `k9o stream create|list|get|delete|publish|tail|replay` for a project's data streams.
- `k9o stream publish <slug> --data <json|@file|->` (stdin with `-`) and `--subject`.
- `k9o stream tail <slug> [--from <sequence>] [--count <n>]` follows a stream live, one event per line (JSON lines with `--output json`).
  It reopens the connection from the last sequence and runs until interrupted.
- `k9o stream replay <slug> [--from N] [--until N] [--limit N]` reads a bounded range.
- A lone `-` is accepted as a flag value, so `--data -` reads stdin.
- `k9o approvals list|get|approve|reject|bulk` for the pending-change queue. `approve` reports when more approvers are needed.
  `bulk --action approve|reject --criteria '<json>' [--reason <text>]` prints the ids it decided; rows that fail are skipped without a report.
- `k9o approval-policy list|create|delete`; `create` takes `--collection`, `--operation`, `--action` and `--predicate '<json>'`.
- `k9o schema collections [--limit N] [--cursor c]` lists the project's collections and prints the cursor of the next page.
- README sections for `k9o query`, `k9o search` and the new commands.
- Keyless sign-in from CI. `--workload-id swi_...` (or `K9O_WORKLOAD_ID`) exchanges an external OIDC token for a short-lived platform token, held in memory for the run.
- The OIDC token comes from `--oidc-token-file`, `K9O_OIDC_TOKEN`, or the GitHub Actions token endpoint (`--oidc-audience` / `K9O_OIDC_AUDIENCE`; the job needs `permissions: id-token: write`).
- `k9o whoami` reports `federated-workload` mode with the workload, org, project and token lifetime.
- Known limit: the exchanged token has no project grants yet, so commands after the exchange are refused. Use `K9O_SERVICE_TOKEN` to run commands in CI until then.

### Changed

- Function deploy examples use the sandbox tier.

## 1.3.0 — 2026-10-26

The CLI now matches the gateway routes exactly.

### Changed

- `k9o login` signs in as the operator. MFA comes from `--mfa-code`, `K9O_MFA_CODE` or a prompt. `--project` is optional.
- Password sign-in is the interim method until browser-based device authorization lands.
- `K9O_SERVICE_TOKEN` signs in CI runs with no login. `K9O_ORG` and `K9O_PROJECT` apply to every command.
- `k9o project create` takes `--region` and the custody modes `PLATFORM_MANAGED`, `SKR`, `BYOK` and `HYOK`.
- `k9o function deploy` uploads the artifact: `--artifact <file>`, or `--artifact-key` with `--version`. `--tier` is `gateway` or `sandbox`.
- `k9o audit tail` is a one-off fetch, not a stream.
- Signed URLs from `k9o storage objects sign` last at most 900 seconds, whatever `--expires-in` asks for.
- `k9o ext <slug> <verb>` works for a signed-in operator only.
- `stack`, `showroom`, `up` and `doctor` need a `k9o-core` checkout. `ledger verify` needs the `kibo-ledger-verify` binary.
- README: command reference, flags and examples rewritten from the source.

### Removed

- `project delete`, `function logs`, `ext-admin available`.
- `me notifications`, `me audit-log`, `me data-export`.
- `org groups create` and `delete`, `org members get`, `org smtp get`, `org audit tail`.
- `storage buckets` flags `--public`, `--versioning` and `--delete-after-days`.
- `audit` flags `--target-kind` and `--target-id`.
- `policy apply --name`.

### Added

- Nothing.

## 1.2.0 — 2026-10-25

- The README now introduces the Kilimanjaro building blocks (Keep, Pulse, Gate, Kibo). No change to the public API.

## 1.1.1 — 2026-10-25

- Documentation links corrected: the documentation hub is https://docs.kilimanjaro.dev, with the website, platform API and console listed in a Links section. Package metadata points at the same places.

## 1.1.0 — 2026-10-25

- Documentation rewritten with runnable examples and expected output; internal cross-references removed from the published sources. No change to the public API.


## 1.0.0 — 2026-10-23

First public release. See the README for the full API overview.
