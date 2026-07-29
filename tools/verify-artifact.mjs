// The deploy artifact contains everything the app asks for at runtime — and
// nothing it shouldn't.
//
// IDENTICAL IN EVERY FLEET REPO. Do not edit one copy: change the canonical
// file and re-copy it (GAME_INTEGRATION §13a). It is a plain script rather
// than a node:test file on purpose — the fleet runs three different test
// runners, and every one of them can call this.
//
// It imports ./stage.mjs, which is the ONLY per-app part: static apps copy
// tracked files, bundled apps run their bundler, curated apps use their own
// file list. All of them export the same contract:
//
//   stage(outDir) -> { outDir }   // produce the deploy artifact in outDir
//   ROOT                          // repo root
//
// Three lists have to agree and none of them check each other: index.html's
// tags, the service worker's precache list, and what the deploy publishes.
// Checking the repo instead of the artifact cannot catch a drift between
// them — every file is obviously present in a checkout. So stage for real
// and read what came out.
//
// Usage: node tools/verify-artifact.mjs [--keep <dir>]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stage, ROOT } from "./stage.mjs";

/** Literal local src/href targets — an expression built in JS isn't a filename. */
function indexRefs(dir) {
  const idx = path.join(dir, "index.html");
  if (!fs.existsSync(idx)) return [];
  return [...fs.readFileSync(idx, "utf8").matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !/^(https?:|\/\/|data:|mailto:|#|\/)/.test(u))
    .filter((u) => /^[\w./-]+$/.test(u))
    .map((u) => u.split(/[?#]/)[0])
    .filter(Boolean);
}

/** Relative precache entries out of sw.js, without running service-worker globals. */
function precached(dir) {
  const sw = path.join(dir, "sw.js");
  if (!fs.existsSync(sw)) return { entries: [], launcher: [] };
  const src = fs.readFileSync(sw, "utf8");
  return {
    entries: [...src.matchAll(/['"]\.\/([^'"]*?)['"]/g)].map((m) => m[1].split(/[?#]/)[0]),
    launcher: [...src.matchAll(/['"]([^'"]*arcade-(?:sdk|audio)\.js)['"]/g)].map((m) => m[1]),
  };
}

/** Returns a list of human-readable failures; empty means the artifact is sound. */
export function verify(dir) {
  const bad = [];
  const has = (rel) => fs.existsSync(path.join(dir, rel));

  if (!has("index.html")) bad.push("no index.html in the artifact — nothing would serve");

  for (const ref of indexRefs(dir)) {
    if (!has(ref)) bad.push(`index.html loads ${ref}, the deploy drops it`);
  }

  const sw = precached(dir);
  for (const entry of sw.entries) {
    // "" is "./" — the directory itself, served as index.html.
    if (!has(entry || "index.html")) bad.push(`sw.js precaches ./${entry}, the deploy drops it`);
  }
  // The game↔launcher boundary, checked from whichever side this repo is on.
  // A game loads /arcade-sdk.js and /arcade-audio.js from the launcher origin
  // and must NOT precache them — caching another origin's SDK is how an app
  // pins itself to a stale one. The launcher publishes those same files, so
  // for it precaching is correct. Detect which side we are by whether the
  // artifact ships the SDK itself; no per-repo configuration, so this file
  // stays byte-identical fleet-wide.
  const ownsSdk = has("arcade-sdk.js");
  if (!ownsSdk) {
    for (const f of sw.launcher) bad.push(`sw.js must not precache the launcher file ${f}`);
  }

  const manPath = path.join(dir, "manifest.json");
  if (fs.existsSync(manPath)) {
    const man = JSON.parse(fs.readFileSync(manPath, "utf8"));
    const wanted = (man.icons || []).map((i) => i.src);
    // A root-absolute start_url ("/<gameId>/") is the deployed arcade path,
    // not a file this repo publishes.
    if (man.start_url && !man.start_url.startsWith("/")) wanted.push(man.start_url);
    for (const u of wanted) {
      const rel = u.replace(/^\.\//, "").split(/[?#]/)[0] || "index.html";
      if (!has(rel)) bad.push(`manifest names ${u}, the deploy drops it`);
    }
  }

  // Things that are never legitimately published, whatever the app. Prose is
  // deliberately not on this list: a game's staging drops markdown anyway,
  // and the launcher's published site IS its documentation.
  for (const dev of ["package.json", "package-lock.json", "tests", "tools", "scratch", "scripts", "go.sh"]) {
    if (has(dev)) bad.push(`dev-only ${dev} is published`);
  }

  return bad;
}

/** Stage into a temp dir, verify, clean up. Throws with every failure listed. */
export function verifyStaged() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-"));
  try {
    stage(tmp);
    const bad = verify(tmp);
    if (bad.length) throw new Error("deploy artifact is not sound:\n  - " + bad.join("\n  - "));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  try {
    verifyStaged();
    console.log("artifact verified: every referenced file is published, no dev files leak");
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
}
