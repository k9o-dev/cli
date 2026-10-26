# Changelog — @k9o/cli

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

- The README now introduces the Kilimanjaro products (Keep, Pulse, Gate, Kibo). No change to the public API.

## 1.1.1 — 2026-10-25

- Documentation links corrected: the documentation hub is https://docs.kilimanjaro.dev, with the website, platform API and console listed in a Links section. Package metadata points at the same places.

## 1.1.0 — 2026-10-25

- Documentation rewritten with runnable examples and expected output; internal cross-references removed from the published sources. No change to the public API.


## 1.0.0 — 2026-10-23

First public release. See the README for the full API overview.
