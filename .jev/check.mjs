#!/usr/bin/env node
/**
 * jev check — the evidence gate every JEV repo runs in CI. Zero dependencies.
 *
 *   node .jev/check.mjs                         static checks only
 *   node .jev/check.mjs --tests "npm test"      also run the suite; 0 tests or any failure is a FAIL
 *
 * Checks (each prints PASS / FAIL with the file that caused it):
 *   lock        vendored .jev files match .jev/lock.json (no hand edits)
 *   scripts     every file a package.json script names exists; every glob matches ≥1 file
 *   placeholder no tracked HTML page is a placeholder or near-empty (< 200 bytes)
 *   unpinned    no code file assigns or defaults a model to an unpinned id, unless the line says
 *               `jev:allow-unpinned` (tests and paths in .jevignore are exempt)
 *   secrets     no TypeSafe key in a tracked file
 *   tests       (with --tests) the suite ran at least one test and none failed
 */
import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const args = process.argv.slice(2);
const testsCmd = args.includes("--tests") ? args[args.indexOf("--tests") + 1] : null;

const results = [];
const record = (name, ok, detail) => results.push({ name, ok, detail });
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

let files = [];
try {
  files = execSync("git ls-files -z", { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 }).split("\0").filter(Boolean);
} catch {
  record("git", false, "not a git checkout; run from the repo root");
}
// .jevignore: one path prefix per line. Those files skip the placeholder and unpinned checks; secrets always run.
const ignore = existsSync(join(root, ".jevignore")) ? readFileSync(join(root, ".jevignore"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")) : [];
const ignored = (f) => f.startsWith(".jev/") || ignore.some((p) => f.startsWith(p));
const isTest = (f) => /(^|\/)(test|tests|__tests__)\//.test(f) || /\.test\.[^/]+$/.test(f);
const read = (f) => { try { return readFileSync(join(root, f), "utf8"); } catch { return ""; } };
const small = (f) => { try { return statSync(join(root, f)).size < 2_000_000; } catch { return false; } };

// lock ------------------------------------------------------------------------
const lockPath = join(root, ".jev/lock.json");
if (existsSync(lockPath)) {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const bad = Object.entries(lock.files ?? {}).filter(([f, h]) => !existsSync(join(root, ".jev", f)) || sha256(join(root, ".jev", f)) !== h);
  record("lock", bad.length === 0, bad.length ? `edited or missing: ${bad.map(([f]) => ".jev/" + f).join(", ")} — re-sync from jev-elder/core` : `jev-core ${lock.version}, ${Object.keys(lock.files).length} files intact`);
} else {
  record("lock", true, "no .jev/ in this repo (skipped)");
}

// scripts ---------------------------------------------------------------------
const globRe = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(?:.*/)?").replace(/\*/g, "[^/]*") + "$");
if (existsSync(join(root, "package.json"))) {
  const pkg = JSON.parse(read("package.json"));
  const missing = [];
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    for (const tok of String(cmd).split(/\s+/)) {
      if (!/\.(ts|mts|mjs|cjs|js|py|sh)$/.test(tok) || tok.startsWith("-") || tok.includes("=") || tok.startsWith("/")) continue;
      const t = tok.replace(/^\.\//, "");
      const ok = t.includes("*") ? files.some((f) => globRe(t).test(f)) : existsSync(join(root, t));
      if (!ok) missing.push(`${name}: ${t}`);
    }
  }
  record("scripts", missing.length === 0, missing.length ? `package.json names files that do not exist → ${missing.join("; ")}` : "every script target exists");
} else {
  record("scripts", true, "no package.json (skipped)");
}

// placeholder -----------------------------------------------------------------
const ph = [];
for (const f of files) {
  if (!/\.html?$/.test(f) || ignored(f)) continue;
  const t = read(f).trim();
  if (/^PLACEHOLDER/.test(t) || t.length < 200) ph.push(`${f} is a placeholder (${t.length} bytes)`);
}
record("placeholder", ph.length === 0, ph.length ? ph.join("; ") : "no placeholder pages");

// unpinned --------------------------------------------------------------------
const unp = [];
const unpinnedUse = /(?:\b(?:model|modelId|model_id|MODEL|MODEL_ID)\s*[:=]|=)\s*["'`]jev-latest["'`]/;
for (const f of files) {
  if (!/\.(ts|tsx|mts|js|mjs|cjs|py|gs)$/.test(f) || ignored(f) || isTest(f) || !small(f)) continue;
  read(f).split("\n").forEach((line, i) => {
    if (unpinnedUse.test(line) && !/jev:allow-unpinned/.test(line)) unp.push(`${f}:${i + 1}`);
  });
}
record("unpinned", unp.length === 0, unp.length ? `unpinned model id in code (add a pin, or mark the line jev:allow-unpinned with a reason) → ${unp.join(", ")}` : "no unpinned model ids in code");

// secrets ---------------------------------------------------------------------
const sec = files.filter((f) => small(f) && /\bts_[A-Za-z0-9]{24,}\b/.test(read(f)));
record("secrets", sec.length === 0, sec.length ? `possible TypeSafe key in ${sec.join(", ")}` : "no keys in tracked files");

// tests -----------------------------------------------------------------------
if (testsCmd) {
  const r = spawnSync(testsCmd, { cwd: root, shell: true, encoding: "utf8", maxBuffer: 256 << 20 });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  let total = 0, failed = 0;
  for (const m of out.matchAll(/^# tests (\d+)$/gm)) total += +m[1];            // node --test (TAP)
  for (const m of out.matchAll(/^# fail (\d+)$/gm)) failed += +m[1];
  for (const m of out.matchAll(/^ℹ tests (\d+)$/gm)) total += +m[1];            // node --test (spec reporter)
  for (const m of out.matchAll(/^ℹ fail (\d+)$/gm)) failed += +m[1];
  for (const m of out.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)) { total += +m[1] + +m[2]; failed += +m[2]; } // cargo
  for (const m of out.matchAll(/Tests:\s+(?:(\d+) failed, )?(\d+) passed/g)) { total += +(m[1] ?? 0) + +m[2]; failed += +(m[1] ?? 0); } // vitest/jest
  const ok = r.status === 0 && total > 0 && failed === 0;
  const why = total === 0 ? "the suite ran 0 tests — a check that observes nothing is not a pass" : `${total - failed}/${total} passed${r.status !== 0 ? `, exit ${r.status}` : ""}`;
  record("tests", ok, `\`${testsCmd}\`: ${why}`);
  if (!ok) process.stderr.write(out.split("\n").slice(-40).join("\n") + "\n");
}

// report ----------------------------------------------------------------------
const w = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(w)}  ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\njev check: ${failed} failing` : "\njev check: all green");
process.exit(failed ? 1 : 0);
