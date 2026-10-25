/**
 * `k9o doctor` — preflight health/prereq check for the DevProxy local stack
 * Turns the port-collision + missing-prereq
 * class into clear remediation instead of a cryptic compose error.
 *
 * Checks (each → ok | warn | fail, with a fix hint):
 *   - docker daemon reachable        (fail = can't bring the stack up)
 *   - bun present                    (fail = run.sh dev servers won't start)
 *   - DevProxy backend (run.sh)      (warn = set K9O_RUNSH_PATH / use a checkout)
 *   - core stack ports free + holder (warn = reuse-don't-clobber may handle it)
 *   - free disk                      (warn = images are heavy)
 *
 * Port defaults are read from the SAME env vars run.sh uses (its source of
 * truth), so the two surfaces never disagree. Profile-gated services
 * (minio/ollama/vault-ops) are health-gated by run.sh at bring-up.
 *
 * Exit 0 unless a `fail` check (a hard prereq) is present.
 */

import { spawnSync } from "node:child_process";

import type { ParsedArgs } from "../args.ts";
import { emitSuccess, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_GENERIC } from "../exit-codes.ts";
import { resolveRunSh } from "./stack.ts";

type CheckStatus = "ok" | "warn" | "fail";
export type Check = { name: string; status: CheckStatus; detail: string; hint?: string };

/** Core always-on stack ports, keyed by the run.sh env-override var + default. */
const CORE_PORTS: ReadonlyArray<{ label: string; env: string; def: number }> = [
  { label: "gateway", env: "K9O_GATEWAY_PORT", def: 8181 },
  { label: "console", env: "K9O_CONSOLE_PORT", def: 5173 },
  { label: "postgres", env: "K9O_DB_SUPER_PORT", def: 5432 },
  { label: "pgbouncer", env: "K9O_DB_PORT", def: 6432 },
];

function runOk(cmd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return {
    ok: r.status === 0 && !r.error,
    out: ((r.stdout || r.stderr || "") as string).trim().split("\n")[0] ?? "",
  };
}

/** Returns the listening-process holder of a TCP port, or null if free. */
export function portHolder(port: number): { pid: string; cmd: string } | null {
  const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  const pid = ((r.stdout || "") as string).trim().split("\n")[0];
  if (!pid) return null;
  const ps = spawnSync("ps", ["-p", pid, "-o", "comm="], { encoding: "utf8" });
  return { pid, cmd: ((ps.stdout || "") as string).trim() || "unknown" };
}

/** Run every check + return the results. Exported for tests + the `--json` path. */
export function runChecks(): Check[] {
  const checks: Check[] = [];

  const docker = runOk("docker", ["info", "--format", "{{.ServerVersion}}"]);
  checks.push(
    docker.ok
      ? { name: "docker", status: "ok", detail: `daemon reachable (server ${docker.out})` }
      : { name: "docker", status: "fail", detail: "docker daemon not reachable", hint: "Start Docker Desktop / dockerd, then re-run." },
  );

  const bun = runOk("bun", ["--version"]);
  checks.push(
    bun.ok
      ? { name: "bun", status: "ok", detail: `bun ${bun.out}` }
      : { name: "bun", status: "fail", detail: "bun not found", hint: "Install bun (https://bun.sh) — run.sh starts the gateway/console dev servers with it." },
  );

  const runsh = resolveRunSh();
  checks.push(
    runsh
      ? { name: "devproxy-backend", status: "ok", detail: `run.sh at ${runsh}` }
      : { name: "devproxy-backend", status: "warn", detail: "run.sh not found", hint: "Set K9O_RUNSH_PATH, use a k9o build that bundles it, or run inside a k9o-core checkout." },
  );

  for (const p of CORE_PORTS) {
    const port = Number(process.env[p.env] ?? p.def);
    const holder = portHolder(port);
    checks.push(
      holder
        ? {
            name: `port:${p.label}`,
            status: "warn",
            detail: `:${port} held by ${holder.cmd} (pid ${holder.pid})`,
            hint: `reuse-don't-clobber may adopt it; else free :${port} or set ${p.env}.`,
          }
        : { name: `port:${p.label}`, status: "ok", detail: `:${port} free` },
    );
  }

  const df = spawnSync("df", ["-Pk", process.env.HOME ?? "."], { encoding: "utf8" });
  const line = ((df.stdout || "") as string).trim().split("\n").pop() ?? "";
  const availKb = Number(line.split(/\s+/)[3]);
  if (Number.isFinite(availKb)) {
    const availGb = Math.round((availKb / 1024 / 1024) * 10) / 10;
    checks.push(
      availGb >= 5
        ? { name: "disk", status: "ok", detail: `${availGb} GB free` }
        : { name: "disk", status: "warn", detail: `${availGb} GB free`, hint: "minio/ollama/vault-ops images are heavy; free some space." },
    );
  }

  return checks;
}

export async function dispatchDoctor(args: ParsedArgs): Promise<number> {
  if (args.flags["help"] === "true") {
    process.stdout.write(`
k9o doctor — check your local dev environment for issues

USAGE
  k9o doctor

Runs a preflight check (docker, bun, the local orchestration script, core
stack ports, free disk) before you bring the local dev stack up, turning a
port-collision or missing-prereq into a clear fix hint instead of a cryptic
compose error.
`.trim() + "\n");
    return EXIT_SUCCESS;
  }
  const format = resolveOutputFormat(args.flags);
  const checks = runChecks();
  const hasFail = checks.some((c) => c.status === "fail");

  emitSuccess(format, { data: { checks, ok: !hasFail } }, () => {
    const glyph = (s: CheckStatus) => (s === "ok" ? "✓" : s === "warn" ? "⚠" : "✗");
    const lines = checks.map((c) => {
      const head = `  ${glyph(c.status)} ${c.name.padEnd(20)} ${c.detail}`;
      return c.hint && c.status !== "ok" ? `${head}\n      → ${c.hint}` : head;
    });
    const summary = hasFail
      ? "✗ Some hard prerequisites are missing — fix the ✗ items before `k9o stack up`."
      : "✓ Ready for `k9o stack up`.";
    return ["k9o doctor — DevProxy preflight:", ...lines, "", summary].join("\n");
  });

  return hasFail ? EXIT_GENERIC : EXIT_SUCCESS;
}
