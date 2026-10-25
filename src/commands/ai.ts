/**
 * `k9o ai embed` — embed text through the platform's one declared embedding model.
 *
 *   k9o ai embed <text> [<text>...]            one vector per text, in order
 *   k9o ai embed --file <path>                 the whole file as ONE input
 *   k9o ai embed --file -                      stdin as ONE input
 *   k9o ai embed ... --model <id>              optional; the server default is the one declared model
 *
 * Wire to `client.ai.embed()` (packages/core/src/ai.ts). The gateway refuses an end user's token; run this as a
 * project member. Bounds (64 inputs, 256 KiB per request) are the server's. The input text is never echoed in an
 * error, and the human output prints counts, not vectors (use `--output json` for the vectors).
 */

import { readFileSync } from "node:fs";
import { KError } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";

function printAiHelp(): void {
  process.stdout.write(`
k9o ai — platform AI primitives

USAGE
  k9o ai embed <text> [<text>...] [--model <id>]
  k9o ai embed --file <path|-> [--model <id>]

  <text>...        each argument is one input; the result has one vector per input, in order
  --file <path>    the whole file as ONE input ("-" reads stdin)
  --model <id>     optional (default: the one declared embedding model)

Give either texts or --file, not both. Run as a project member: an end user's token is refused.
Add task prefixes (e.g. "search_document: ") yourself; the platform adds nothing.
Human output shows counts; use --output json for the vectors.
`.trim() + "\n");
}

/** The inputs from argv, or the reasons they are unusable. Pure apart from reading `--file`. */
export function embedInputsFromArgs(args: ParsedArgs, readFile: (p: string) => string = defaultRead): { input: string[] } | { problems: string[] } {
  const texts = args.positional.slice(2);
  const file = args.flags["file"];
  const problems: string[] = [];
  if (texts.length > 0 && file !== undefined) problems.push("pass texts or --file, not both");
  else if (texts.length === 0 && file === undefined) problems.push("give at least one <text>, or --file <path|->");
  if (problems.length > 0) return { problems };
  if (file !== undefined) {
    let body: string;
    try {
      body = readFile(file);
    } catch {
      return { problems: [`cannot read --file ${file}`] };
    }
    return { input: [body] };
  }
  return { input: texts };
}

function defaultRead(p: string): string {
  return readFileSync(p === "-" ? 0 : p, "utf8");
}

export async function dispatchAi(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (sub === undefined || args.flags["help"] === "true") {
    printAiHelp();
    return sub === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  try {
    if (sub !== "embed") {
      emitError(format, new KError({
        code: "K9O_INVALID_FIELD_VALUE",
        message: `unknown ai subcommand "${sub}"`,
        context: { sub },
        recommendation: "Valid: embed",
      }));
      return EXIT_USAGE;
    }
    const got = embedInputsFromArgs(args);
    if ("problems" in got) {
      emitError(format, new KError({
        code: "K9O_INVALID_FIELD_VALUE",
        message: `k9o ai embed: ${got.problems.join("; ")}`,
        context: {},
        recommendation: "k9o ai embed 'some text'   or   k9o ai embed --file notes.txt",
      }));
      return EXIT_USAGE;
    }
    const model = args.flags["model"];
    const { client } = clientFromProfile(args, { requireProject: true });
    const env = await client.ai.embed({ ...(model !== undefined ? { model } : {}), input: got.input });
    emitSuccess(format, env, (r) => `Embedded ${r.embeddings.length} input(s) with ${r.model} (${r.dimensions} dimensions)`);
    return EXIT_SUCCESS;
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}
