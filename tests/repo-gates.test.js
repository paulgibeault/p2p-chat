// Structural gates for the deployed site — zero-dep, discovery-driven, and
// identical across fleet apps that carry it (it tests whatever exists).
//
// These catch the deploy-staging bug class: a file index.html or sw.js asks
// for that isn't tracked ships a broken page or a service worker that fails
// install. Game logic lives inline/browser-side; these gates are what keep
// the published artifact honest until logic moves into testable modules.
const { test } = require("node:test");
const assert = require("node:assert");
const { execSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const tracked = execSync("git ls-files -z", { cwd: ROOT, encoding: "utf8" })
  .split("\0").filter(Boolean);

test("every tracked JS file parses", () => {
  for (const f of tracked.filter((f) => /\.(js|mjs)$/.test(f))) {
    const r = spawnSync(process.execPath, ["--check", f], { cwd: ROOT });
    assert.strictEqual(r.status, 0,
      `node --check ${f} failed:\n${r.stderr}`);
  }
});

test("every tracked JSON file parses", () => {
  for (const f of tracked.filter((f) => f.endsWith(".json"))) {
    assert.doesNotThrow(
      () => JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8")),
      `${f} is not valid JSON`);
  }
});

test("every local src/href in index.html resolves to a tracked file", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const missing = [];
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const u = m[1];
    // Root-absolute paths (/arcade-sdk.js) are launcher-owned; external,
    // data:, anchors and template strings aren't files of this repo.
    if (/^(https?:|\/\/|\/|data:|mailto:|#)/.test(u) || u.includes("${")) continue;
    const clean = u.split(/[?#]/)[0];
    if (clean && !fs.existsSync(path.join(ROOT, clean))) missing.push(u);
  }
  assert.deepStrictEqual(missing, [],
    `index.html references untracked files: ${missing.join(", ")}`);
});

test("every sw.js precache entry exists", { skip: !fs.existsSync(path.join(ROOT, "sw.js")) }, () => {
  const src = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  const missing = [];
  for (const m of src.matchAll(/['"]\.\/([^'"]*?)['"]/g)) {
    const clean = m[1].split(/[?#]/)[0];
    if (clean && !fs.existsSync(path.join(ROOT, clean))) missing.push("./" + m[1]);
  }
  assert.deepStrictEqual(missing, [],
    `sw.js precaches missing files: ${missing.join(", ")}`);
});

test("manifest.json is coherent", { skip: !fs.existsSync(path.join(ROOT, "manifest.json")) }, () => {
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  for (const icon of man.icons || []) {
    const clean = icon.src.replace(/^\.\//, "").split(/[?#]/)[0];
    assert.ok(fs.existsSync(path.join(ROOT, clean)),
      `manifest icon missing: ${icon.src}`);
  }
  // A root-absolute start_url ("/moon-lit/") is the deployed arcade path, not
  // a file in this repo — only a repo-relative one names a file we can check.
  if (man.start_url && !man.start_url.startsWith("/")) {
    const clean = man.start_url.replace(/^\.\//, "").split(/[?#]/)[0] || "index.html";
    assert.ok(fs.existsSync(path.join(ROOT, clean)),
      `manifest start_url target missing: ${man.start_url}`);
  }
});
