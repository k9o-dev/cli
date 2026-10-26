/**
 * `k9o ai embed` — embed text through the platform's one declared embedding model.
 *
 *   k9o ai embed <text> [<text>...]            one vector per text, in order
 *   k9o ai embed --file <path>                 the whole file as ONE input
 *   k9o ai embed --file -                      stdin as ONE input
 *   k9o ai embed ... --model <id>              optional; the server default is the one declared model
 *
 *   k9o ai generate <prompt|-> [--model <id>] [--max-tokens N] [--temperature T]
 *                                              prints the generated text; usage goes to stderr ("-" reads the prompt from stdin)
 *
 * Wire to `client.ai.embed()` / `client.ai.generate()` (packages/core/src/ai.ts). The gateway refuses an end user's token; run this as a
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

  k9o ai generate <prompt|-> [--model <id>] [--max-tokens N] [--temperature T]

  <prompt>         the prompt ("-" reads it from stdin)
  --model <id>     optional (default: the org's default LLM; a 400 when the org has none)
  --max-tokens N   1..32000
  --temperature T  0..2
  Prints the generated text; the token usage goes to stderr (--output json: the whole result).
  A model served by an outside provider answers 501 until that provider is built.

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

/** The generate request from argv, or the reasons it is unusable. */
export function generateFromArgs(
  args: ParsedArgs,
  readStdin: () => string = () => readFileSync(0, "utf8"),
): { prompt: string; options: { model?: string; maxTokens?: number; temperature?: number } } | { problems: string[] } {
  const problems: string[] = [];
  const words = args.positional.slice(2);
  if (words.length !== 1) problems.push("give exactly one <prompt> (quote it), or - for stdin");
  const options: { model?: string; maxTokens?: number; temperature?: number } = {};
  const model = args.flags["model"];
  if (model !== undefined) options.model = model;
  const mt = args.flags["max-tokens"];
  if (mt !== undefined) {
    const n = Number(mt);
    if (!/^\d+$/.test(mt) || n < 1 || n > 32000) problems.push("--max-tokens must be an integer from 1 to 32000");
    else options.maxTokens = n;
  }
  const temp = args.flags["temperature"];
  if (temp !== undefined) {
    const n = Number(temp);
    if (temp.trim() === "" || !Number.isFinite(n) || n < 0 || n > 2) problems.push("--temperature must be a number from 0 to 2");
    else options.temperature = n;
  }
  if (problems.length > 0) return { problems };
  let prompt = words[0]!;
  if (prompt === "-") {
    try {
      prompt = readStdin();
    } catch {
      return { problems: ["cannot read the prompt from stdin"] };
    }
  }
  if (prompt.length === 0) return { problems: ["the prompt is empty"] };
  return { prompt, options };
}

export async function dispatchAi(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (sub === undefined || args.flags["help"] === "true") {
    printAiHelp();
    return sub === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  try {
    if (sub === "generate") {
      const got = generateFromArgs(args);
      if ("problems" in got) {
        emitError(format, new KError({
          code: "K9O_INVALID_FIELD_VALUE",
          message: `k9o ai generate: ${got.problems.join("; ")}`,
          context: {},
          recommendation: "k9o ai generate 'Write a haiku' [--model <id>] [--max-tokens N] [--temperature T]",
        }));
        return EXIT_USAGE;
      }
      const { client } = clientFromProfile(args, { requireProject: true });
      const env = await client.ai.generate(got.prompt, got.options);
      if (format !== "json") {
        const u = env.data.usage;
        process.stderr.write(`model ${env.data.modelId}, ${u.promptTokens} prompt + ${u.completionTokens} completion = ${u.totalTokens} tokens\n`);
      }
      emitSuccess(format, env, (r) => r.content);
      return EXIT_SUCCESS;
    }
    if (sub !== "embed") {
      emitError(format, new KError({
        code: "K9O_INVALID_FIELD_VALUE",
        message: `unknown ai subcommand "${sub}"`,
        context: { sub },
        recommendation: "Valid: embed, generate",
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
