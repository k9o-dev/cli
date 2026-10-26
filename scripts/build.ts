#!/usr/bin/env bun
/**
 * Build the `k9o` CLI into a single Node-runnable bundle at `dist/index.js`.
 *
 * The published npm package's `bin` points at the
 * built JS (not the TS source), so the CLI runs under a plain `node`
 * runtime — not just Bun. We:
 *   1. bundle `src/index.ts` (+ inlined `@k9o/core`) with `--target=node`
 *   2. rewrite the leading `#!/usr/bin/env bun` shebang → `#!/usr/bin/env node`
 *   3. mark the output executable (so the npm bin symlink + direct exec work)
 *
 * Run via `bun run build`. Invoked automatically by `prepublishOnly`.
 */

import { chmodSync } from "node:fs";

const OUT = "dist/index.js";

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "node",
  naming: "index.js",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// Bun preserves the source `#!/usr/bin/env bun` shebang; the Node-distributed
// binary must invoke `node`. Rewrite only the first line.
const file = Bun.file(OUT);
const contents = await file.text();
const NODE_SHEBANG = "#!/usr/bin/env node";
const patched = contents.startsWith("#!")
  ? NODE_SHEBANG + contents.slice(contents.indexOf("\n"))
  : `${NODE_SHEBANG}\n${contents}`;
await Bun.write(OUT, patched);
chmodSync(OUT, 0o755);

console.log(`built ${OUT} (node target, node shebang, +x)`);
