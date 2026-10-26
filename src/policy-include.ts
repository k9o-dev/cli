/**
 * `k9o policy` multi-file `include` composition — a CLI-local affordance,
 * never a backend or wire-format concept: the gateway sees one document.
 *
 * Two composition modes, matching `kubectl apply`:
 *   1. Single-file-imports-many — a policy file's top-level `include`
 *      array names other files whose `rules` merge in. Resolved
 *      automatically by `resolvePolicyDocument([file])`.
 *   2. Explicit multi-file — several standalone files passed as separate
 *      entry points, e.g. `k9o policy apply a.json b.json`. Resolved by
 *      `resolvePolicyDocument([a, b])`.
 *
 * Resolution is entirely client-side, before anything reaches the
 * network: the platform receives exactly one fully-resolved document and
 * never learns the source was multi-file — `include` never appears in
 * the output. The platform
 * re-validates the merged document independently regardless (defense in
 * depth, never a substitute for server-side checks per the standing
 * "verify where the write lands" discipline).
 *
 * Diamond-dependency handling: two files that both
 * include a shared rules file will each pull the shared rules in — that
 * is not a collision. A rule name colliding with a BYTE-IDENTICAL
 * definition is silently deduplicated (the diamond case); a rule name
 * colliding with a DIFFERENT definition is rejected (a genuine authoring
 * collision).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { KError } from "@k9o/core";

type JsonObject = Record<string, unknown>;

export type ResolvedPolicyDocument = {
  rules: JsonObject[];
  policy: JsonObject;
};

const KNOWN_TOP_LEVEL_KEYS = new Set(["include", "rules", "policy"]);

function readPolicyFile(absPath: string): JsonObject {
  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch (e) {
    throw new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `Failed to read ${absPath}: ${e instanceof Error ? e.message : String(e)}`,
      context: { file: absPath },
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `Failed to parse ${absPath} as JSON: ${e instanceof Error ? e.message : String(e)}`,
      context: { file: absPath },
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `${absPath} must contain a JSON object at the top level`,
      context: { file: absPath },
    });
  }
  return parsed as JsonObject;
}

function ruleName(rule: JsonObject, file: string): string {
  const name = rule["name"];
  if (typeof name !== "string" || name.length === 0) {
    throw new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `A rule in ${file} is missing a string "name"`,
      context: { file },
    });
  }
  return name;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, (b as unknown[])[i]));
  }
  const aObj = a as JsonObject;
  const bObj = b as JsonObject;
  const aKeys = Object.keys(aObj).sort();
  const bKeys = Object.keys(bObj).sort();
  if (aKeys.length !== bKeys.length || !aKeys.every((k, i) => k === bKeys[i])) return false;
  return aKeys.every((k) => deepEqual(aObj[k], bObj[k]));
}

/**
 * Merge two `policy:` application blocks. Colliding leaf arrays (rule-name
 * reference lists) concatenate + dedupe rather than reject — referencing
 * a rule from two merged files at the same application point is a
 * redundant no-op, not an error, and concatenation matches the
 * "chaining more rules onto a list can only ever make a policy stricter,
 * never looser" default.
 */
function mergePolicyBlocks(a: unknown, b: unknown, path: string): unknown {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr && bArr) {
    const merged = [...a];
    for (const item of b) if (!merged.some((x) => deepEqual(x, item))) merged.push(item);
    return merged;
  }
  if (!aArr && !bArr && typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const out: JsonObject = { ...(a as JsonObject) };
    for (const [k, v] of Object.entries(b as JsonObject)) out[k] = mergePolicyBlocks(out[k], v, `${path}.${k}`);
    return out;
  }
  throw new KError({
    code: "K9O_INVALID_FIELD_VALUE",
    message: `Conflicting policy definitions at "${path}" across merged files.`,
    context: { path },
  });
}

/**
 * Resolve one or more entry-point policy files into a single merged
 * document — following `include` graphs depth-first, deduplicating
 * diamond-dependency rules, and rejecting genuine name collisions and
 * cycles. `entryFiles` are resolved relative to the caller's cwd;
 * `include` paths inside a file are resolved relative to THAT file's own
 * directory (standard include semantics — a file's includes never depend
 * on where the CLI happened to be invoked from).
 */
export function resolvePolicyDocument(entryFiles: readonly string[]): ResolvedPolicyDocument {
  if (entryFiles.length === 0) {
    throw new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: "resolvePolicyDocument requires at least one file",
      context: {},
    });
  }

  const ruleByName = new Map<string, { def: JsonObject; sourceFile: string }>();
  let policy: JsonObject = {};

  function visit(absPath: string, stack: readonly string[]): void {
    if (stack.includes(absPath)) {
      const cycle = [...stack, absPath];
      throw new KError({
        code: "K9O_INVALID_FIELD_VALUE",
        message: `Circular include detected: ${cycle.join(" -> ")}`,
        context: { cycle },
      });
    }
    const doc = readPolicyFile(absPath);
    const dir = dirname(absPath);

    const includes = doc["include"];
    if (includes !== undefined) {
      if (!Array.isArray(includes) || !includes.every((p) => typeof p === "string")) {
        throw new KError({
          code: "K9O_INVALID_FIELD_VALUE",
          message: `"include" in ${absPath} must be an array of file paths`,
          context: { file: absPath },
        });
      }
      for (const rel of includes) visit(resolvePath(dir, rel), [...stack, absPath]);
    }

    const rules = doc["rules"];
    if (rules !== undefined) {
      if (!Array.isArray(rules)) {
        throw new KError({
          code: "K9O_INVALID_FIELD_VALUE",
          message: `"rules" in ${absPath} must be an array`,
          context: { file: absPath },
        });
      }
      for (const r of rules) {
        if (typeof r !== "object" || r === null || Array.isArray(r)) {
          throw new KError({
            code: "K9O_INVALID_FIELD_VALUE",
            message: `A rule in ${absPath} is not an object`,
            context: { file: absPath },
          });
        }
        const name = ruleName(r as JsonObject, absPath);
        const existing = ruleByName.get(name);
        if (existing === undefined) {
          ruleByName.set(name, { def: r as JsonObject, sourceFile: absPath });
        } else if (!deepEqual(existing.def, r)) {
          throw new KError({
            code: "K9O_POLICY_RULE_COLLISION",
            message: `Rule "${name}" is defined differently in ${existing.sourceFile} and ${absPath} — rename one, or make the two definitions identical.`,
            context: { rule: name, files: [existing.sourceFile, absPath] },
          });
        }
        // else: byte-identical duplicate reached via a diamond include path — dedupe silently.
      }
    }

    const policyBlock = doc["policy"];
    if (policyBlock !== undefined) {
      if (typeof policyBlock !== "object" || policyBlock === null || Array.isArray(policyBlock)) {
        throw new KError({
          code: "K9O_INVALID_FIELD_VALUE",
          message: `"policy" in ${absPath} must be an object`,
          context: { file: absPath },
        });
      }
      policy = mergePolicyBlocks(policy, policyBlock, "policy") as JsonObject;
    }

    const extraKeys = Object.keys(doc).filter((k) => !KNOWN_TOP_LEVEL_KEYS.has(k));
    if (extraKeys.length > 0) {
      throw new KError({
        code: "K9O_INVALID_FIELD_VALUE",
        message: `Unrecognized top-level key(s) in ${absPath}: ${extraKeys.join(", ")}`,
        context: { file: absPath, keys: extraKeys },
      });
    }
  }

  for (const f of entryFiles) visit(resolvePath(f), []);

  return { rules: [...ruleByName.values()].map((v) => v.def), policy };
}
