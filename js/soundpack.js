// p2p-chat sound pack — the game's own sound design.
//
// Loaded as a plain script after /sdk/v3/arcade-audio.js. The launcher's
// tools/soundpack renderer loads this same file to produce audition WAVs, so
// what gets approved by ear is what plays.
//
// ── v1 — sonar ────────────────────────────────────────────────────────────
// Of the three packs written in this pass this is the only one that keeps its
// predecessor's identity, because SONAR is the only palette that says the
// thing this app is actually for: there is no server. Peers appear and vanish
// off a local scope, device to device, and you can hear whether anything is
// out there. Every other messaging app ships two interchangeable chimes.
//
// What changes is that the room stops being decoration and becomes the
// subject. Under spec cues this was sonar-SHAPED TONES — sine pings with a
// hand-scheduled second copy standing in for an echo. Under graph cues the
// convolution room can just be the water.
//
//   THE ROOM IS INVERTED FROM THE REST OF THE FLEET. sow-duku's room exists
//   to say "outside" and is explicitly never a tail you could point to. This
//   one is long, dark and slow, and THE TAIL IS THE ENTIRE POINT, because the
//   tail is distance. It is the only room in the fleet you are supposed to
//   notice.
//
//   AN ECHO REPEATS THE PITCH; A DEPARTURE CHANGES IT. That single rule
//   separates the two presence cues, which are otherwise the same gesture.
//   A peer arriving is a ping and then THE SAME NOTE coming back, quieter and
//   darker — something out there answered. A peer leaving is a ping and then
//   two LOWER notes, each fainter than the last, and nothing ever returns at
//   the pitch that was sent. Nothing is answering; the contact is receding.
//
//   A RETURN HAS NO CONTACT CLICK. Water eats the transient first, so every
//   returning copy in this pack is built by taking the strike away rather
//   than by adding a delay. (pi-game's corridor works the same way — the two
//   packs were written together and share the physics.)
//
// Six cues:
//
//   peer-joined        a ping, and the same note answering
//   peer-left          a ping, and two fainter notes going away
//   message-received   a contact right next to you
//   message-sent       the same contact, heading away
//   transfer-complete  a run of returns resolving
//   error              the lock breaks
//
// Register plan, so simultaneous cues occupy different bands:
//   pings 620–1180 · returns 560–1050 · message pops 470–1150
//   error 90–430 · contacts 3000+
//
// LEVEL NEVER VARIES PER PLAY. `message-received` in particular stays the
// quietest thing in the pack that still registers — that constraint is
// inherited verbatim from the chiptune profile and its reasoning was right:
// it fires often, and it lands while someone is mid-sentence reading, so
// startling them is a worse failure than being faint.
//
// The archived chiptune profile is kept verbatim in audio/chiptune-archive.mjs
// and is what a player on a stale service-worker cache still hears.

(function (global) {
  'use strict';
  const S = global.ArcadeAudioElements;

  // Every cue here is built from the element library's gestures, so with the
  // library absent — a stale service-worker cache, or running standalone off
  // the launcher origin — there is nothing registrable and the game's audio
  // module takes its fallback path. Bail before dereferencing S: this file is
  // a plain script, and a throw here would surface as a page error even though
  // the fallback itself works. Also covers an OLDER library that predates
  // registerPack, which is the same stale-cache scenario one version on.
  if (!S || typeof S.registerPack !== 'function') return;

  // Water. Long, slow, and very dark: the high shelf is the deepest in the
  // fleet because water absorbs the top end almost immediately, and a bright
  // tail here would read as a cathedral instead of a depth. The pre-delay is
  // long for the same reason — the first reflection has to arrive late enough
  // to be heard as a separate arrival rather than as part of the ping.
  const ROOM = {
    dur: 3.4,
    decay: 1.60,
    preDelay: 0.030,
    wet: 0.95,
    shelfHz: 1900,
    shelfDb: -10,
    seed: 5150,
  };

  // How far out each cue is. This is the pack's main expressive control and
  // it is doing real work: the two presence cues are FAR (they are about
  // something at a distance), the message pops are NEAR (they are about
  // something in your hand), and the gap between 0.07 and 0.38 is most of
  // what makes a peer event and a message event feel like different kinds of
  // thing before you have identified either.
  const SENDS = {
    'peer-joined': 0.30,
    'peer-left': 0.38,
    'message-received': 0.07,
    'message-sent': 0.20,
    'transfer-complete': 0.26,
    'error': 0.20,
  };

  // Levels, by layer.
  const PING = 0.20;      // a contact on the scope
  const RETURN = 0.058;   // what comes back
  const NEAR = 0.085;     // a message arriving — the quietest thing that registers
  const AWAY = 0.070;     // a message leaving
  const CHAIN = 0.15;     // the transfer
  const BREAK = 0.18;     // the error

  // The transducer. One voice for every presence cue: a struck ring with a
  // near-harmonic partial over it and a very short attack — definite in
  // pitch, so that "the same note came back" is a thing the ear can actually
  // check. `click` is the contact; a RETURN does not have one.
  function ping(ctx, o, t, r, p) {
    const g = p.gain;
    if (p.click) {
      S.strike(ctx, o, t, {
        dur: S.between(r, 0.0022, 0.0034), hp: 3600 * S.cents(r, 100),
        gain: g * 0.30, seed: (r() * 1e6) | 0,
      });
    }
    S.body(ctx, o, t, {
      f0: p.f, gain: g,
      partials: [
        { ratio: 1.00, gain: 1.00, decay: p.decay, detune: 4, attack: 0.004 },
        { ratio: 2.02, gain: 0.20 * p.bright, decay: p.decay * 0.42, detune: 9, attack: 0.003 },
      ],
    });
  }

  const CUES = {
    // A PEER ARRIVED — a ping out, and the same note answering from a long
    // way off. The return is quieter, darker, has no contact on it, and sits
    // at THE SAME PITCH: that is what makes it an echo rather than a second
    // event, and it is the whole difference between this cue and `peer-left`.
    'peer-joined': function (ctx, o, t, params, r) {
      const f = S.between(r, 1020, 1090);
      ping(ctx, o, t, r, { f, gain: PING, decay: S.between(r, 0.17, 0.21), bright: 1.0, click: true });
      ping(ctx, o, t + S.between(r, 0.32, 0.37), r, {
        f: f * S.cents(r, 8),                       // the same note, near enough
        gain: RETURN, decay: S.between(r, 0.22, 0.27), bright: 0.35, click: false,
      });
      return 1.1;
    },

    // A PEER LEFT — the same ping, and then two more, each lower and fainter
    // than the last. Nothing ever comes back at the pitch that was sent, so
    // nothing is answering: the contact is moving away under its own power
    // and then it is out of range. Sent furthest into the room of anything in
    // the pack, and it ends on the room alone.
    'peer-left': function (ctx, o, t, params, r) {
      const f = S.between(r, 880, 930);
      ping(ctx, o, t, r, { f, gain: PING * 0.85, decay: S.between(r, 0.17, 0.21), bright: 0.85, click: true });
      ping(ctx, o, t + S.between(r, 0.26, 0.30), r, {
        f: f * S.between(r, 0.83, 0.86), gain: PING * 0.34,
        decay: S.between(r, 0.19, 0.23), bright: 0.5, click: false,
      });
      ping(ctx, o, t + S.between(r, 0.55, 0.61), r, {
        f: f * S.between(r, 0.69, 0.72), gain: PING * 0.13,
        decay: S.between(r, 0.22, 0.26), bright: 0.25, click: false,
      });
      return 1.6;
    },

    // A MESSAGE ARRIVED — a contact right next to you. Water, not a bell: a
    // droplet's plink is a fast UPWARD sweep, because the cavity left by the
    // impact shrinks as it collapses. Near-dry, so it is unmistakably in the
    // room with you rather than out on the scope.
    //
    // The quietest thing in the pack that still registers, and it stays that
    // way. It fires constantly and it arrives while someone is mid-sentence
    // reading; faint is a much cheaper failure than startling.
    'message-received': function (ctx, o, t, params, r) {
      S.droplet(ctx, o, t, {
        f0: S.between(r, 590, 650), f1: S.between(r, 1080, 1200),
        dur: S.between(r, 0.042, 0.055), tone: 2600,
        gain: NEAR, seed: (r() * 1e6) | 0,
      });
      return 0.4;
    },

    // A MESSAGE SENT — the same contact, heading away. Lower, a touch
    // quieter, and sent three times as far into the room: the dry onset says
    // it left from here, the wet tail says it is going somewhere else. Pitch
    // and distance carry the direction; level barely moves, because a sent
    // message is not less important than a received one.
    'message-sent': function (ctx, o, t, params, r) {
      S.droplet(ctx, o, t, {
        f0: S.between(r, 440, 490), f1: S.between(r, 780, 860),
        dur: S.between(r, 0.048, 0.062), tone: 2100,
        gain: AWAY, seed: (r() * 1e6) | 0,
      });
      return 0.6;
    },

    // A TRANSFER FINISHED — a run of returns resolving. A file is not one
    // arrival, it is many, so this is three pings climbing to the pitch the
    // presence cue uses, and only the last one gets an answer. Landing on
    // that note is what makes a finished transfer sound like the LINK
    // confirming rather than like a separate jingle: it is the same voice
    // saying the same thing it says when a peer appears.
    'transfer-complete': function (ctx, o, t, params, r) {
      const top = S.between(r, 1020, 1090);
      const steps = [top * 0.70, top * 0.84, top];
      for (let i = 0; i < 3; i++) {
        ping(ctx, o, t + i * S.between(r, 0.115, 0.135), r, {
          f: steps[i] * S.cents(r, 10), gain: CHAIN * (0.72 + i * 0.14),
          decay: S.between(r, 0.13, 0.17), bright: 0.8 + i * 0.1, click: i === 0,
        });
      }
      ping(ctx, o, t + S.between(r, 0.56, 0.62), r, {
        f: top * S.cents(r, 8), gain: RETURN * 0.9,
        decay: S.between(r, 0.24, 0.29), bright: 0.3, click: false,
      });
      return 1.4;
    },

    // THE LOCK BREAKS — an error. The one cue with no ping in it at all and
    // no return of any kind: the voice that has been answering all along
    // simply is not there. What is left is the mechanism failing — a short
    // low grind losing its grip, and the weight of it going down — and then
    // the water, with nothing in it.
    //
    // Deliberately the darkest thing in the pack. The archived profile used a
    // descending triangle buzz, which sat in the same register as the pings
    // and could be mistaken for one at low volume; keeping the error entirely
    // below the voice is what stops that.
    'error': function (ctx, o, t, params, r) {
      S.creak(ctx, o, t, {
        f0: S.between(r, 390, 430), f1: S.between(r, 150, 175), Q: 6.5,
        lp: 950, dur: S.between(r, 0.22, 0.27), rate: 1.9, rate1: 0.55,
        gain: BREAK * 0.50, attack: 0.02, seed: (r() * 1e6) | 0,
      });
      S.thump(ctx, o, t + S.between(r, 0.16, 0.21), {
        f0: S.between(r, 96, 108), f1: S.between(r, 44, 52),
        dur: S.between(r, 0.34, 0.42), attack: 0.025,
        gain: BREAK, seed: (r() * 1e6) | 0,
      });
      return 1.5;
    },
  };

  // Published under the framework's well-known handle (arcade-audio.js
  // registerPack) so the game's audio module and the launcher's soundpack
  // toolchain both reach it without either side knowing this game's name.
  S.registerPack({ name: 'p2p-chat', ROOM, SENDS, CUES });
})(typeof window !== 'undefined' ? window : globalThis);
