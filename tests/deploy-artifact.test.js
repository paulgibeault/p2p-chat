// The deploy artifact contains everything the game asks for at runtime —
// and nothing it shouldn't.
//
// Three lists have to agree and none of them check each other: index.html's
// script/link tags, the service worker's precache list, and what the deploy
// actually publishes. Checking the repo instead of the artifact does not
// catch a drift between them: every file is obviously present in a checkout.
// So stage for real (the same tools/stage.mjs the deploy job runs) and read
// what came out.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stage, ROOT } from "../tools/stage.mjs";

const OUT = stage(fs.mkdtempSync(path.join(os.tmpdir(), "stage-")));
const has = (rel) => fs.existsSync(path.join(OUT.outDir, rel));

/** Literal local src/href targets — an expression built in JS isn't a filename. */
function indexRefs() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  return [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !/^(https?:|\/\/|data:|mailto:|#|\/)/.test(u))
    .filter((u) => /^[\w./-]+$/.test(u))
    .map((u) => u.split(/[?#]/)[0])
    .filter(Boolean);
}

/** Relative precache entries out of sw.js, without running SW globals. */
function precached() {
  const sw = path.join(ROOT, "sw.js");
  if (!fs.existsSync(sw)) return [];
  return [...fs.readFileSync(sw, "utf8").matchAll(/['"]\.\/([^'"]*?)['"]/g)]
    .map((m) => m[1].split(/[?#]/)[0]);
}

test("every file index.html loads is published", () => {
  const missing = indexRefs().filter((r) => !has(r));
  assert.deepStrictEqual(missing, [], `index.html loads files the deploy drops: ${missing.join(", ")}`);
});

test("every precached file is published", () => {
  // "" is "./" — the directory itself, served as index.html.
  const missing = precached().map((e) => e || "index.html").filter((r) => !has(r));
  assert.deepStrictEqual(missing, [], `sw.js precaches files the deploy drops: ${missing.join(", ")}`);
});

test("manifest icons and relative start_url are published", { skip: !fs.existsSync(path.join(ROOT, "manifest.json")) }, () => {
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const wanted = (man.icons || []).map((i) => i.src);
  // A root-absolute start_url ("/<gameId>/") is the deployed arcade path, not
  // a file this repo publishes.
  if (man.start_url && !man.start_url.startsWith("/")) wanted.push(man.start_url);
  const missing = wanted
    .map((u) => u.replace(/^\.\//, "").split(/[?#]/)[0] || "index.html")
    .filter((r) => !has(r));
  assert.deepStrictEqual(missing, [], `manifest names files the deploy drops: ${missing.join(", ")}`);
});

test("launcher-root files stay out of our precache", { skip: !fs.existsSync(path.join(ROOT, "sw.js")) }, () => {
  // /arcade-sdk.js and /arcade-audio.js come from the launcher origin by
  // design and are deliberately uncached. Assert that intent, so a
  // well-meaning "fix" that precaches them fails here and not on a stale
  // install in someone's browser.
  const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  const shell = [...sw.matchAll(/['"]([^'"]*arcade-(?:sdk|audio)\.js)['"]/g)].map((m) => m[1]);
  assert.deepStrictEqual(shell, [], `sw.js must not precache launcher files: ${shell.join(", ")}`);
});

test("dev-only files stay out of the artifact", () => {
  const leaked = ["package.json", "README.md", "tests", "tools", "docs", "scratch", "scripts", "go.sh"]
    .filter((f) => has(f));
  assert.deepStrictEqual(leaked, [], `dev files published: ${leaked.join(", ")}`);
});

test("the artifact has an index.html", () => {
  assert.ok(has("index.html"), "dist/index.html missing — nothing would serve");
});

test.after(() => fs.rmSync(OUT.outDir, { recursive: true, force: true }));
