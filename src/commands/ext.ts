/**
 * `k9o ext <slug> <verb>` — per-extension commands.
 *
 * An extension declares its own CLI verbs in its manifest (`surfaces.cli[]`);
 * the gateway returns them with each installed extension in
 * `GET /@<project>/extensions-admin` (`cli`). Each verb is
 *
 *     { verb, summary, invokes: "<METHOD>:<path>", args?: [...] }
 *
 * and this command turns an invocation into one request to the extension's
 * own route:
 *
 *     <METHOD> /@<project>/extensions/<slug>/api/<slug><path>
 *
 * Arguments bind to the request by their declared `bind`:
 *   - `path`   replaces `{name}` or `:name` in the path
 *   - `query`  goes in the query string
 *   - `body`   goes in the JSON body
 * When `bind` is not declared, an argument named in the path binds to the
 * path; otherwise it goes to the query string for GET and DELETE and to the
 * body for other methods. Positional arguments are taken in declared order;
 * flag arguments are `--name value` (booleans are bare `--name`).
 *
 * The gateway serves this route to a signed-in operator only: a personal
 * access token or service token is refused there.
 *
 * Alias `extension` → `ext` (index.ts). `admin` is a RESERVED slug: `k9o ext
 * admin …` points the user at `k9o ext-admin` rather than treating "admin" as
 * an extension.
 */

import { KError } from "@k9o/core";
import { request, requestStream } from "@k9o/core/http";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitError, emitSuccess, resolveOutputFormat, type OutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";

/** Names that are NOT extensions — they collide with the management tree. */
const RESERVED_SLUGS = new Set(["admin"]);

export type CliArgSpec = {
  name: string;
  summary: string;
  position: "positional" | "flag";
  type: "string" | "number" | "boolean" | "json";
  required?: boolean;
  bind?: "path" | "query" | "body";
};

export type CliVerbSpec = {
  verb: string;
  summary: string;
  /** `<METHOD>:<path>`. */
  invokes: string;
  args?: CliArgSpec[];
};

export type ExtensionRequest = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path below the extension's own mount, with path arguments substituted. */
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | undefined;
};

function bad(message: string, context: Record<string, unknown> = {}, recommendation?: string): KError {
  return new KError({
    code: "K9O_INVALID_FIELD_VALUE",
    message,
    context,
    ...(recommendation !== undefined ? { recommendation } : {}),
  });
}

function convert(spec: CliArgSpec, raw: string): unknown {
  switch (spec.type) {
    case "string":
      return raw;
    case "number": {
      const n = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(n)) throw bad(`argument "${spec.name}" must be a number, got "${raw}"`, { arg: spec.name });
      return n;
    }
    case "boolean":
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw bad(`argument "${spec.name}" must be true or false, got "${raw}"`, { arg: spec.name });
    case "json":
      try {
        return JSON.parse(raw);
      } catch {
        throw bad(`argument "${spec.name}" must be valid JSON`, { arg: spec.name });
      }
  }
}

/**
 * Turn a verb declaration plus the user's positionals and flags into the
 * request to send. Pure; throws a KError for a missing or malformed argument.
 */
export function buildExtensionRequest(
  verb: CliVerbSpec,
  positionals: readonly string[],
  flags: Record<string, string>,
): ExtensionRequest {
  const m = /^(GET|POST|PUT|PATCH|DELETE):(\/.+)$/.exec(verb.invokes);
  if (m === null) throw bad(`the extension declares an invalid route for "${verb.verb}": ${verb.invokes}`, { invokes: verb.invokes });
  const method = m[1] as ExtensionRequest["method"];
  let path = m[2]!;
  const query: Record<string, string> = {};
  const body: Record<string, unknown> = {};

  let nextPositional = 0;
  for (const spec of verb.args ?? []) {
    let raw: string | undefined;
    if (spec.position === "positional") {
      raw = positionals[nextPositional++];
    } else {
      raw = flags[spec.name];
    }
    if (raw === undefined) {
      if (spec.required === true) {
        throw bad(
          `missing required ${spec.position === "flag" ? `--${spec.name}` : `<${spec.name}>`}: ${spec.summary}`,
          { arg: spec.name },
          `k9o ext <slug> ${verb.verb} --help`,
        );
      }
      continue;
    }
    const value = convert(spec, raw);
    const inPath = new RegExp(`\\{${spec.name}\\}|:${spec.name}(?![A-Za-z0-9_])`).test(path);
    const bind = spec.bind ?? (inPath ? "path" : method === "GET" || method === "DELETE" ? "query" : "body");
    if (bind === "path") {
      path = path.replace(new RegExp(`\\{${spec.name}\\}|:${spec.name}(?![A-Za-z0-9_])`, "g"), encodeURIComponent(String(value)));
    } else if (bind === "query") {
      query[spec.name] = typeof value === "string" ? value : JSON.stringify(value);
    } else {
      body[spec.name] = value;
    }
  }
  return { method, path, query, body: Object.keys(body).length > 0 ? body : undefined };
}

function describeVerbs(slug: string, verbs: readonly CliVerbSpec[]): string {
  if (verbs.length === 0) return `Extension "${slug}" declares no CLI commands.`;
  const lines = [`Commands of extension "${slug}":`];
  for (const v of verbs) {
    const args = (v.args ?? [])
      .map((a) => (a.position === "flag" ? `--${a.name}${a.required === true ? "" : "?"}` : a.required === true ? `<${a.name}>` : `[${a.name}]`))
      .join(" ");
    lines.push(`  ${v.verb.padEnd(20)} ${args.padEnd(30)} ${v.summary}`);
  }
  return lines.join("\n");
}

type InstalledWithCli = { extensionSlug: string; status: string; cli?: CliVerbSpec[] };

async function loadVerbs(args: ParsedArgs, slug: string): Promise<{ verbs: CliVerbSpec[]; project: string; client: ReturnType<typeof clientFromProfile>["client"] }> {
  const { client } = clientFromProfile(args, { requireProject: true });
  const project = client.config.projectSlug!;
  const env = await request<ReadonlyArray<InstalledWithCli>>(client.config, { method: "GET", path: `/@${project}/extensions-admin` });
  const entry = env.data.find((e) => e.extensionSlug === slug);
  if (entry === undefined) {
    throw new KError({
      code: "K9O_EXTENSION_NOT_FOUND",
      message: `Extension "${slug}" is not installed on project ${project}.`,
      context: { slug, project },
      recommendation: "k9o ext-admin list   shows what is installed.",
    });
  }
  return { verbs: entry.cli ?? [], project, client };
}

export async function dispatchExt(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const slug = args.positional[1];

  if (slug === undefined) {
    printExtHelp();
    return args.flags["help"] === "true" ? EXIT_SUCCESS : EXIT_USAGE;
  }

  // Reserved-slug / root guard: `ext admin` is the management tree, not an extension.
  if (RESERVED_SLUGS.has(slug)) {
    emitError(format, bad(`"${slug}" is a reserved name, not an extension`, { slug }, "For extension management use `k9o ext-admin`."));
    return EXIT_USAGE;
  }

  const verb = args.positional[2];
  try {
    if (verb === undefined || args.flags["help"] === "true") {
      if (verb === undefined && args.flags["help"] !== "true") {
        emitError(format, bad(`k9o ext ${slug} requires a verb`, { slug }, `k9o ext ${slug} --help`));
        return EXIT_USAGE;
      }
      const { verbs } = await loadVerbs(args, slug);
      if (verb !== undefined) {
        const spec = verbs.find((v) => v.verb === verb);
        if (spec === undefined) throw unknownVerb(slug, verb, verbs);
        process.stdout.write(describeVerbs(slug, [spec]) + "\n");
      } else {
        process.stdout.write(describeVerbs(slug, verbs) + "\n");
      }
      return EXIT_SUCCESS;
    }
    return await invokeExtensionVerb(args, slug, verb, format);
  } catch (e) {
    emitError(format, e);
    // A bad verb or argument is a usage error, like every other command's.
    return e instanceof KError && e.code === "K9O_INVALID_FIELD_VALUE" ? EXIT_USAGE : exitCodeForError(e);
  }
}

function unknownVerb(slug: string, verb: string, verbs: readonly CliVerbSpec[]): KError {
  return bad(
    `extension "${slug}" has no command "${verb}"`,
    { slug, verb },
    verbs.length > 0 ? `Valid: ${verbs.map((v) => v.verb).join(" | ")}` : `Extension "${slug}" declares no CLI commands.`,
  );
}

async function invokeExtensionVerb(args: ParsedArgs, slug: string, verb: string, format: OutputFormat): Promise<number> {
  const { verbs, project, client } = await loadVerbs(args, slug);
  const spec = verbs.find((v) => v.verb === verb);
  if (spec === undefined) throw unknownVerb(slug, verb, verbs);

  const built = buildExtensionRequest(spec, args.positional.slice(3), args.flags);
  const response = await requestStream(client.config, {
    method: built.method,
    path: `/@${project}/extensions/${encodeURIComponent(slug)}/api/${encodeURIComponent(slug)}${built.path}`,
    query: built.query,
    ...(built.body !== undefined ? { body: built.body } : {}),
    accept: "application/json",
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    // not JSON: print it as text
  }
  const isEnvelope = typeof parsed === "object" && parsed !== null && "data" in parsed && "meta" in parsed;
  if (isEnvelope) {
    emitSuccess(format, parsed as { data: unknown; meta: Record<string, unknown> });
  } else if (typeof parsed === "string") {
    if (format === "json") emitSuccess(format, { data: parsed, meta: {} });
    else process.stdout.write(parsed + (parsed.endsWith("\n") ? "" : "\n"));
  } else {
    emitSuccess(format, { data: parsed, meta: {} });
  }
  return EXIT_SUCCESS;
}

function printExtHelp(): void {
  process.stdout.write(`
k9o ext — run a specific extension's commands

USAGE
  k9o ext <slug> <verb> [args...] [flags...]
  k9o ext <slug> --help         List the extension's commands (needs a sign-in)

  Each installed extension declares its own commands. Run \`k9o ext-admin list\`
  to see installed extensions, then \`k9o ext <slug> --help\` for its verbs.
  The gateway serves these commands to a signed-in operator only: a service
  token or personal access token is refused.

  Alias: \`k9o extension <slug> <verb>\` is an alias for \`k9o ext <slug> <verb>\`.
  For management (enable / disable / config) use \`k9o ext-admin\`.
`.trim() + "\n");
}
