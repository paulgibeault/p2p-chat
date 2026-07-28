// p2p-chat — chiptune sound profile (frozen archive).
//
// PROVENANCE
//   Source repo:   paulgibeault/p2p-chat     (base branch: master, not main)
//   Source file:   app.js (registerSfxCues)
//   Branch:        audio-retune @ c97ff877febfbf1a64cbe60fbf20eec6a3ec29a1
//   Draft PR:      paulgibeault/p2p-chat#8
//   Archived:      2026-07-24
//
// Nothing loads this file. It is data, preserved verbatim, awaiting a
// selectable sound-profile system. See ./README.md.
//
// ── SOUND IDENTITY (from the source header, verbatim) ───────────────────────
// Sound identity: SONAR. The whole point of this app is the direct
// device-to-device link — peers appearing and disappearing off a local
// radar with no server in between — so the palette is a sonar/radio one
// rather than the interchangeable two-note chimes every messaging app
// ships. Three ideas carry it:
//   * Presence is a contact on the scope. A peer arriving is a high ping
//     with one quiet echo returning: something out there answered. A peer
//     leaving is that same ping sliding down and fading below the noise
//     floor, with no echo — nothing answers.
//   * Messages are soft physical pops (a click of noise for the attack, a
//     short pitched body under it), not doorbells. Received is the higher,
//     louder one — it moved toward you. Sent is its quieter, lower sibling
//     — it moved away. Received is deliberately the quietest thing in the
//     palette that still registers: it fires often and lands while someone
//     is mid-sentence reading, so startling is a worse failure than faint.
//   * transfer-complete keeps its rising triad and error its low
//     descending buzz — those gestures were already right. They are only
//     retuned to sit in the same register and envelope family as the
//     pings, so everything sounds like one radio.
// Volume + the global mute are launcher-owned (Arcade.settings.audioVolume)
// — this app adds NO in-game volume/mute UI.
//
// Envelopes stay conservative: per-voice dur <= 0.25s, gain <= 0.35.
// NOTE: every cue below except 'peer-left' is an ARRAY, and array cues
// ignore per-play overrides — play(name, {freq}) merges onto
// single-object cues only. No call site passes overrides today; if one
// ever needs to, that cue has to stay (or go back to) a single object.

export const CUES = {
  // Sonar contact: the ping, then one quiet echo returning. The echo
  // starts 0.15s after the ping starts — 0.03s after it ends — so the
  // pair reads as one gesture with a tail instead of two separate events.
  'peer-joined': [
    { type: 'sine', freq: 1175, toFreq: 1100, dur: 0.12, gain: 0.24, attack: 0.002, release: 0.11 },
    { type: 'sine', freq: 1175, toFreq: 1100, dur: 0.12, gain: 0.07, attack: 0.002, release: 0.11, delay: 0.15 },
  ],

  // The same ping sinking below the noise floor, and nothing echoes back.
  'peer-left': { type: 'sine', freq: 1100, toFreq: 700, dur: 0.25, gain: 0.18, attack: 0.005, release: 0.22 },

  // Soft pop: noise transient and pitched body struck together (delay 0).
  'message-received': [
    { type: 'noise', dur: 0.012, gain: 0.05, attack: 0.001, release: 0.011, delay: 0 },
    { type: 'sine', freq: 740, dur: 0.07, gain: 0.16, attack: 0.003, release: 0.065, delay: 0 },
  ],

  // Same pop, lower and quieter — it left you rather than arrived.
  'message-sent': [
    { type: 'noise', dur: 0.010, gain: 0.03, attack: 0.001, release: 0.009, delay: 0 },
    { type: 'sine', freq: 587, dur: 0.06, gain: 0.09, attack: 0.003, release: 0.055, delay: 0 },
  ],

  // Rising triad, unchanged in shape, landing on the ping's own pitch so
  // a finished transfer sounds like the link itself answering.
  'transfer-complete': [
    { type: 'sine', freq: 659, dur: 0.07, gain: 0.20, attack: 0.002, release: 0.06 },
    { type: 'sine', freq: 880, dur: 0.07, gain: 0.20, attack: 0.002, release: 0.06 },
    { type: 'sine', freq: 1100, toFreq: 1175, dur: 0.13, gain: 0.22, attack: 0.002, release: 0.12 },
  ],

  // Low descending buzz, same two-step shape, now enveloped and sagging
  // in pitch like a signal losing its lock.
  'error': [
    { type: 'triangle', freq: 300, toFreq: 280, dur: 0.10, gain: 0.26, attack: 0.004, release: 0.05 },
    { type: 'triangle', freq: 220, toFreq: 180, dur: 0.18, gain: 0.24, attack: 0.004, release: 0.16 },
  ],
};

// ── NOT-STATIC-DATA ────────────────────────────────────────────────────────
// No runtime-derived cue parameters — no call site passes per-play overrides.
//
// One cross-cue relationship that is design, not data: 'peer-joined',
// 'peer-left' and 'transfer-complete' are deliberately built on the SAME ping
// pitch (1100–1175 Hz). 'peer-joined' pings down 1175→1100 and echoes;
// 'peer-left' slides that ping away 1100→700 with no echo; 'transfer-complete'
// resolves its triad up onto 1100→1175, i.e. back onto the arrival ping. Any
// replacement profile has to keep those three pitched against each other or
// the sonar metaphor collapses.
export const PING_PITCH_FAMILY = {
  arrival: [1175, 1100],
  departure: [1100, 700],
  transferResolve: [1100, 1175],
};
