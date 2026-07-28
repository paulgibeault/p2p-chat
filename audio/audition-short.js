// p2p-chat — the short audition. THE one to listen to first.
//
//   node ../paulgibeault.github.io/tools/soundpack/render.mjs \
//     --config soundpack.config.json --audition short
//
// A listening file, not a diagnostic one: every sound once, in the order you
// meet it, then the pair the whole design rests on, then a real session.
//
// v1 keeps the chiptune profile's sonar identity but not its material, so
// there is no meaningful A/B against the archive — the gesture is the same
// and the instrument is not. The long diagnostic timeline gets written after
// this file has had its first ear pass, so that it proves whatever actually
// needed proving.
//
(function (global) {
  'use strict';
  const A = global.ArcadeAudition;

  const GAP = 1.30;   // this room has a long tail and every cue ends in it
  const TAIL = 2.6;

  const SECTIONS = [
    {
      title: 'A · The six sounds',
      note: 'Each once, in the order you meet them. A peer arriving is a ping and the SAME note answering from a long way off. A peer leaving is a ping and then two lower, fainter notes with nothing ever coming back. Messages are water right next to you — received sweeps up and stays near, sent is lower and further out. A finished transfer climbs to the peer pitch and gets one answer, so the link itself confirms. The error is the only cue with no ping and no return in it at all: the voice that has been answering is simply not there.',
      items: [
        A.play('peer-joined', { label: 'a peer joined — ping, and the same note comes back' }),
        A.play('peer-left', { label: 'a peer left — lower, fainter, and nothing answers' }),
        A.play('message-received', { label: 'a message arrived — near, and the quietest thing here' }),
        A.play('message-sent', { label: 'a message sent — the same water, going away' }),
        A.play('transfer-complete', { label: 'a file finished — a run of returns resolving' }),
        A.play('error', { label: 'ERROR — the lock breaks, and the water is empty' }),
      ],
    },
    {
      title: 'B · The pair that must not blur',
      note: 'Joined and left are the same gesture in the same voice, and the ONLY thing separating them is whether the note that comes back is the note that went out. An echo repeats the pitch; a departure changes it. Heard back to back that should be obvious — but in use these arrive minutes apart, from a pocket, with the screen off, so the test is whether the shape survives on its own. If joined-then-left ever reads as one long event, the pack has failed regardless of how good the water sounds. Then the same pair with no reverb at all: dry, the design should visibly stop working, which is how you know the room is carrying it rather than decorating it.',
      items: [
        A.custom('joined · left · joined · left — alternating', 8.4, (ctx, bus, t, r) => {
          for (let i = 0; i < 2; i++) {
            A.fire(ctx, bus, 'peer-joined', t + i * 4.2, r);
            A.fire(ctx, bus, 'peer-left', t + i * 4.2 + 2.1, r);
          }
        }),
        A.play('peer-joined', { label: 'joined — DRY, no water at all', send: 0 }),
        A.play('peer-left', { label: 'left — DRY, no water at all', send: 0 }),
        A.custom('three peers joining in a row — a session filling up', 4.6, (ctx, bus, t, r) => {
          [0.0, 1.3, 2.5].forEach((at) => A.fire(ctx, bus, 'peer-joined', t + at, r));
        }),
      ],
    },
    {
      title: 'C · A conversation',
      note: 'Real traffic. Someone joins, you talk back and forth at the pace people actually type, a file goes over, a second peer joins mid-conversation, and then the link drops. Two things to listen for: whether `message-received` is still comfortable on the twentieth one (it is the cue most likely to become irritating, and the only defence is that it is faint), and whether the pings still cut through when messages are flying — they occupy the same octave on purpose, so that everything sounds like one radio, and that is exactly the choice that could go wrong.',
      items: [
        A.custom('a peer joins and you start talking', 9.0, (ctx, bus, t, r) => {
          A.fire(ctx, bus, 'peer-joined', t + 0.2, r);
          [1.6, 2.0, 2.35].forEach((at) => A.fire(ctx, bus, 'message-received', t + at, r));
          A.fire(ctx, bus, 'message-sent', t + 3.4, r);
          [4.5, 4.85].forEach((at) => A.fire(ctx, bus, 'message-received', t + at, r));
          A.fire(ctx, bus, 'message-sent', t + 5.9, r);
          A.fire(ctx, bus, 'message-sent', t + 6.3, r);
          A.fire(ctx, bus, 'message-received', t + 7.4, r);
        }),
        A.custom('a burst — someone typing fast, twenty in eight seconds', 9.0, (ctx, bus, t, r) => {
          let at = 0.2;
          for (let i = 0; i < 20; i++) { A.fire(ctx, bus, 'message-received', t + at, r); at += 0.28 + (i % 4) * 0.11; }
        }),
        A.custom('a file goes over while the conversation continues', 6.4, (ctx, bus, t, r) => {
          A.fire(ctx, bus, 'message-sent', t + 0.2, r);
          [1.1, 1.5].forEach((at) => A.fire(ctx, bus, 'message-received', t + at, r));
          A.fire(ctx, bus, 'transfer-complete', t + 2.4, r);
          A.fire(ctx, bus, 'message-received', t + 4.1, r);
        }),
        A.custom('a second peer joins mid-sentence', 5.4, (ctx, bus, t, r) => {
          [0.2, 0.55].forEach((at) => A.fire(ctx, bus, 'message-received', t + at, r));
          A.fire(ctx, bus, 'peer-joined', t + 1.0, r);
          A.fire(ctx, bus, 'message-sent', t + 2.3, r);
          A.fire(ctx, bus, 'message-received', t + 3.1, r);
        }),
        A.custom('the link drops — an error, and then everyone is gone', 7.2, (ctx, bus, t, r) => {
          A.fire(ctx, bus, 'message-sent', t + 0.2, r);
          A.fire(ctx, bus, 'error', t + 1.4, r);
          A.fire(ctx, bus, 'peer-left', t + 3.1, r);
          A.fire(ctx, bus, 'peer-left', t + 4.4, r);
        }),
      ],
    },
  ];

  A.publish({ gap: GAP, tail: TAIL, sections: SECTIONS });
})(typeof window !== 'undefined' ? window : globalThis);
