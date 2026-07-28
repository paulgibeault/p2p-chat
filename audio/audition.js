// p2p-chat — audition timeline, v1 (diagnostic).
//
//   node ../paulgibeault.github.io/tools/soundpack/render.mjs \
//     --config soundpack.config.json --audition full
//
// The PROVING file — listen to audition-short.js first; come here when
// something in it needs isolating. Written after the first ear pass (v1
// approved with no retunes), so it proves the claims the design stands on
// rather than re-auditioning the material:
//
//   · the pitch rule IS the grammar — an echo repeats the note, a departure
//     changes it, and that has to survive repetition and per-play variation,
//     because it is the only thing separating the two presence cues
//   · the transfer ends on the peer pitch with an answer, which makes it the
//     cue most able to impersonate a joined — they must stay two events
//   · the room is the subject, so it gets audited like one: each tail heard
//     to the end, because a tail you are supposed to notice is a tail that
//     can be WRONG in a way decoration never is
//   · everything shares one octave on purpose, so the collisions the short
//     file brushed past get staged here deliberately, at their worst
//
(function (global) {
  'use strict';
  const A = global.ArcadeAudition;

  const GAP = 1.2;
  const TAIL = 3.0;   // the longest room in the fleet, allowed to finish

  const SECTIONS = [
    {
      title: 'A · The pitch rule, under repetition',
      note: 'Every ping\'s pitch is drawn fresh per play, so "the same note came back" has to be re-established by each joined on its own terms, four times in a row here. Then four departures: each of the three notes is drawn from its own range per play, and every one must still read as going DOWN and going AWAY. The trap this section exists to catch: a per-play draw where the joined\'s return lands near where a left\'s second note would sit, or a left whose first drop is small enough to read as an off echo. If any single repetition is ambiguous, the grammar has a hole exactly as wide as that draw.',
      items: [
        A.repeat('peer-joined', { n: 4, spacing: 2.1, label: 'joined ×4 — four fresh draws, four echoes' }),
        A.repeat('peer-left', { n: 4, spacing: 2.3, label: 'left ×4 — four fresh draws, four departures' }),
        A.custom('joined · left ×3 — alternating, faster than the short file', 10.8, (ctx, bus, t, r) => {
          for (let i = 0; i < 3; i++) {
            A.fire(ctx, bus, 'peer-joined', t + i * 3.6, r);
            A.fire(ctx, bus, 'peer-left', t + i * 3.6 + 1.8, r);
          }
        }),
      ],
    },
    {
      title: 'B · The impersonation risk',
      note: 'The transfer climbs to the peer pitch and gets one answer — deliberately the same voice saying the same thing, so a finished file sounds like the link confirming. That choice has one failure mode: a transfer that reads as a peer JOINING. Heard alternating, the difference should be structural, not subtle — the transfer is three rising contacts with a click only on the first, the joined is one contact and one echo. Then the transfer immediately before and after a real joined, which is how a busy session actually serves them.',
      items: [
        A.custom('transfer · joined ×2 — alternating, the impersonation test', 10.4, (ctx, bus, t, r) => {
          for (let i = 0; i < 2; i++) {
            A.fire(ctx, bus, 'transfer-complete', t + i * 5.2, r);
            A.fire(ctx, bus, 'peer-joined', t + i * 5.2 + 2.6, r);
          }
        }),
        A.custom('a transfer finishes as a peer joins — 300 ms apart', 5.6, (ctx, bus, t, r) => {
          A.fire(ctx, bus, 'transfer-complete', t + 0.2, r);
          A.fire(ctx, bus, 'peer-joined', t + 0.5, r);
        }),
      ],
    },
    {
      title: 'C · Near and far — the distance axis',
      note: 'The gap between a message\'s send of 0.07 and a departure\'s 0.38 is most of what makes a message event and a peer event different KINDS of thing, before either is identified. Message pairs alternating at typing pace first — received up-and-near, sent lower-and-out, and the direction must survive the tenth repetition, because in use it survives the thousandth. Then the axis itself: near · far · near · far, one cue from each end, listening only for placement.',
      items: [
        A.custom('received · sent ×5 — alternating at typing pace', 6.4, (ctx, bus, t, r) => {
          for (let i = 0; i < 5; i++) {
            A.fire(ctx, bus, 'message-received', t + i * 1.2, r);
            A.fire(ctx, bus, 'message-sent', t + i * 1.2 + 0.6, r);
          }
        }),
        A.repeat('message-received', { n: 12, spacing: 0.42, label: 'received ×12 — the most-fired cue, level and patience' }),
        A.custom('near · far · near · far — a message, then a departure', 8.8, (ctx, bus, t, r) => {
          A.fire(ctx, bus, 'message-received', t + 0.2, r);
          A.fire(ctx, bus, 'peer-left', t + 1.4, r);
          A.fire(ctx, bus, 'message-received', t + 4.4, r);
          A.fire(ctx, bus, 'peer-left', t + 5.6, r);
        }),
      ],
    },
    A.everyCueDryWet(
      'D · Each cue — dry, then in the water',
      'First without the room, then in it. This pack is inverted from the rest of the fleet: dry, the presence cues should audibly STOP WORKING — a ping with no water around it is a doorbell — while the message pops should barely change, because they were nearly dry to begin with. If a dry presence cue still sounds finished, the room is decorating this design rather than carrying it, which would be praise anywhere else in the fleet and is a defect here.'
    ),
    {
      title: 'E · The water heard to the end',
      note: 'The only room in the fleet you are supposed to notice, so it gets what no other room gets: audited alone, every tail run to silence with nothing after it. The departure ends on the room and the room has to end on NOTHING — any flutter, any ring-out at one pitch, any sense of a wall, and the ocean becomes a tank. The error ends on the same emptiness and it is the loneliest sound in the pack; the silence after it is doing the cue\'s real work, so it is rendered here at full length.',
      items: [
        A.play('peer-left', { label: 'a departure, and the water after it — uncut', dur: 5.0 }),
        A.play('error', { label: 'the lock breaks, and the water is empty — uncut', dur: 5.5 }),
        A.play('transfer-complete', { label: 'the transfer\'s answer, draining out — uncut', dur: 4.5 }),
      ],
    },
    {
      title: 'F · Collisions, staged',
      note: 'Everything here shares one octave so the app sounds like one radio, and these are the moments that choice has to survive. A ping landing inside a message burst must read as a NEW contact over the traffic, not as a louder message. Two peers arriving in the same instant — the multi-party case — must read as two echoes, not as chorus. And the error arriving mid-conversation must silence the room\'s voice believably: everything before it busy, everything after it empty.',
      items: [
        A.custom('a joined inside a burst — the ping through the traffic', 8.0, (ctx, bus, t, r) => {
          let at = 0.2;
          for (let i = 0; i < 12; i++) { A.fire(ctx, bus, 'message-received', t + at, r); at += 0.26 + (i % 3) * 0.09; }
          A.fire(ctx, bus, 'peer-joined', t + 1.9, r);
        }),
        A.custom('two peers in the same instant — echo, not chorus', 4.8, (ctx, bus, t, r) => {
          A.fire(ctx, bus, 'peer-joined', t + 0.2, r);
          A.fire(ctx, bus, 'peer-joined', t + 0.28, r);
        }),
        A.custom('sent + received in the same instant — crossed messages', 3.6, (ctx, bus, t, r) => {
          A.fire(ctx, bus, 'message-sent', t + 0.2, r);
          A.fire(ctx, bus, 'message-received', t + 0.2, r);
        }),
        A.custom('the error mid-conversation — busy, then empty', 9.0, (ctx, bus, t, r) => {
          [0.2, 0.5, 0.9].forEach((at) => A.fire(ctx, bus, 'message-received', t + at, r));
          A.fire(ctx, bus, 'message-sent', t + 1.3, r);
          A.fire(ctx, bus, 'error', t + 2.1, r);
          A.fire(ctx, bus, 'peer-left', t + 4.6, r);
        }),
      ],
    },
  ];

  A.publish({ gap: GAP, tail: TAIL, sections: SECTIONS });
})(typeof window !== 'undefined' ? window : globalThis);
