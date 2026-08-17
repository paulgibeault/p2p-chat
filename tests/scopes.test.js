// Open-game scope gates — the premises this app got wrong once already.
//
// All three are SOURCE gates, and not for want of trying to unit-test the real
// thing: app.js is an IIFE that reads `document` and `Arcade` at import, so
// Node cannot load it without a DOM and a launcher. What these pin is
// therefore the shape of the code rather than its behaviour at runtime — which
// is exactly enough for the failure mode they exist to stop, since each of them
// is a sentence or a fallback that was WRITTEN wrong, and would be written
// wrong again by anybody restoring the relay-era assumptions.
//
// Design: paulgibeault/paulgibeault.github.io plans/tables-2026-08.md.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../tools/stage.mjs";

const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

// The copy gate below reads what can reach a SCREEN, so the comments have to go
// first: this file's whole subject is a set of premises that were wrong once,
// and the code explaining that history quotes the old sentences on purpose.
// Only whole-line comments are stripped, so no string literal is ever touched.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
}

/** The body of a top-level `function name(...) { ... }` in app.js. */
function bodyOf(source, name) {
  const start = source.indexOf("\nfunction " + name + "(");
  assert.notStrictEqual(start, -1, `no top-level function ${name}() in app.js`);
  const open = source.indexOf("{", start);
  const end = source.indexOf("\n}", open);
  assert.ok(end > open, `could not find the end of ${name}()`);
  return source.slice(open, end);
}

// The fallback this replaced said: a peer we heard onReady from is probably
// still reachable while our own session is up, because fellow joiners were
// relayed and had no departure signal. Relay is deleted, so a peer outside the
// roster is unreachable — and a liveness answer that consults session-wide
// status, or the onReady dedupe set, is that deleted world coming back.
test("isLive() answers from the roster alone", () => {
  const body = bodyOf(app, "isLive");
  // Both names on purpose. The set is `greetedIds` now — it was `knownLiveIds`
  // while it doubled as this fallback — and a gate that named only one of them
  // would be disarmed by a rename in either direction. That is not
  // hypothetical: renaming the set silently defanged this very assertion, and
  // only re-running the break-test caught it.
  assert.ok(!/greetedIds|knownLiveIds/.test(body),
    "isLive() consults the onReady greeting set — that is the relay-era fallback (issue #19 item 3)");
  assert.ok(!/currentStatus/.test(body),
    "isLive() consults session-wide status — per-peer liveness is the roster's answer, not the session's");
  assert.ok(/roster\[i\]\.status/.test(body), "isLive() should read per-peer status from the roster");
});

// Consent is the launcher's to take: a game may ask and never grant. So the one
// call site has to sit behind a real capability check — not behind an inference
// from invite()'s return value, which answers 0 both for "no cap" and for
// "nobody to ask".
test("the invite door is unreachable without the peer.invite cap", () => {
  const calls = app.match(/Arcade\.peer\.invite\(/g) || [];
  assert.strictEqual(calls.length, 1, "expected exactly one Arcade.peer.invite() call site");

  const body = bodyOf(app, "knock");
  const guard = body.indexOf("!canInvite");
  const call = body.indexOf("Arcade.peer.invite(");
  assert.ok(guard !== -1 && guard < call,
    "knock() must return early on !canInvite before calling Arcade.peer.invite()");

  // And the cap read must be a cap read, not a version sniff or a truthiness
  // test on the function's existence alone.
  assert.ok(/caps\(\)/.test(app) && /'peer\.invite'/.test(app),
    "canInvite should come from Arcade.peer.caps() containing 'peer.invite'");
});

// The first paint has to know what session it is in. renderConvList decides the
// header door from currentStatus and draws each row's dot from the roster, so
// reading either after the first render shows a frame of a screen that knows
// nothing — on a mid-session mount, long enough for the ask-to-chat door to
// appear and vanish. Pinned here rather than in a browser: the window is one
// frame wide, and a poll that misses it would pass for the wrong reason.
test("init() reads transport state before the first paint", () => {
  const body = bodyOf(app, "init");
  const roster = body.indexOf("Arcade.peer.peers()");
  const status = body.indexOf("Arcade.peer.status()");
  const paint = body.indexOf("showScreen('list')");
  assert.ok(roster !== -1 && status !== -1 && paint !== -1, "init() should read peers(), status(), then paint");
  assert.ok(roster < paint, "the roster is read after the first render");
  assert.ok(status < paint, "the status is read after the first render");
});

// The 2026-08-16 field failure, wearing its UI hat: `idle` was rendered as
// "Not paired", so a user with several paired-and-connected devices was sent
// off to re-run a ceremony that had already succeeded. `idle` means no scope is
// open — nobody has agreed to chat yet — and says nothing about pairing.
test("no surface reads a closed scope as a broken pairing", () => {
  for (const [name, src] of [["app.js", stripComments(app)], ["index.html", stripComments(html)]]) {
    assert.ok(!/Not paired/.test(src), `${name} still renders "Not paired" for a closed scope`);
    assert.ok(!/Pair with a peer/.test(src), `${name} still tells the user to pair when nobody has said yes yet`);
  }
  // Leaving the ROSTER is leaving the chat, not losing the connection: a peer
  // who closes this game, quits it, or gets evicted from the launcher's frame
  // pool departs over a link that is still perfectly up. "Disconnected" was the
  // relay-era word for it and diagnoses a fault that usually isn't there.
  const stripped = stripComments(app);
  assert.ok(!/' disconnected'/.test(stripped) && !/ disconnected"/.test(stripped),
    'a peer leaving the roster is reported as a disconnection');
  assert.ok(/left the chat/.test(stripped), 'the departure line should say the peer left the chat');

  // The pairing instruction survives in exactly one place — the answer knock()
  // gives when the ask reached nobody, which is the one case where it is true.
  const nobody = app.match(/NOBODY_TO_ASK = '((?:[^'\\]|\\.)*)'/);
  assert.ok(nobody, "NOBODY_TO_ASK should still be a single literal");
  assert.ok(/Multiplayer menu/.test(nobody[1]),
    "the ask-reached-nobody answer is where the Multiplayer menu belongs");
});
