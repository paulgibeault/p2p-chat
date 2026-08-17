# P2P Chat

A demonstration game for [Paul's Arcade](https://paulgibeault.github.io) — a
neatly appointed messaging interface that proves out the arcade's
launcher-owned multiplayer framework (`Arcade.peer.*`).

Players pair through the arcade's **Multiplayer** menu (QR code or reply
link, no signaling server). Pairing is durable and one-time; it is not, on its
own, permission to chat. This chat is live on a connection only once **both
ends have agreed to run it** — an *open-game scope* — so the conversation list
starts with a **👋 Ask to chat** door rather than advice about pairing. Any
number of devices can be in the chat at once; every one of them is a direct
link, because the launcher never forwards a frame between links.

That last point is the whole delivery model: **there is no relay**. A device
this one has no link to is unreachable, permanently, and no reconnect changes
that. Group chats therefore fan out to the members *this* device can reach —
see the group notes below.

## Features

- A two-screen layout: a **conversations screen** (most-recently-active
  first, with unread badges and live-status dots) and a **full-page chat**
  you tap into, with a back button to return. Group rows list every member
  inline with a per-member presence dot that updates in real time. Peer
  identity comes from the SDK's roster/presence APIs (`Arcade.peer.onReady`
  / `Arcade.peer.onPeersChange`) — no hand-rolled hello handshake. A
  conversation is "live" when its peer (or, for a group, any of its members)
  is in the chat right now; otherwise it's a read-only archive of past
  history. The dots and the thread subtitle say "in this chat" rather than
  "online" on purpose: with no relay, reachable-from-here is the only kind of
  presence this app can honestly report, and a member can be sitting in the
  group on their own device and still receive nothing sent from this one.
- **👋 Ask to chat** — the invite door, behind the launcher's `peer.invite`
  capability. It asks the launcher to propose this chat to every connection
  that doesn't already have it open, and reports how many were asked; who
  accepts arrives later, as a device appearing in the roster. On a launcher
  without the capability the door is not shown and the copy points at the
  Multiplayer menu — a game may ask for consent, never grant it, so there is
  no hand-rolled fallback.
- A **⋯ menu** in the chat header holding rename, members (for groups),
  clear chat, and leave/remove — destructive actions take a second
  confirming tap. A rename is local and sticks even if the peer's device
  name or a group's synced name later changes.
- **Group chats** — the ＋ button lets you name a group and pick
  members from your known peers. Membership is a real synced concept: the
  creator's client is the source of truth (an unforgeable `fromDeviceId`,
  not a self-declared field, is what proves who's allowed to update a
  group), and membership changes propagate to everyone — including to
  members who were offline when the change happened, once they reconnect.
  Any member can leave; only the creator can add or remove others.

  **A group can be bigger than its reach.** Membership is synced to everyone,
  but a message only goes to the members this device holds a link to — so a
  partial fan-out labels its own bubble ("sent to 2 of 4") instead of letting
  a timestamp imply the whole group got it. Making the group itself
  host-authoritative (routing through the creator, the way cardstock routes
  its room announcements through the host) was considered and deliberately not
  done: it would put every relayed file chunk through one device and take the
  group dark whenever the creator is offline.
- Text chat with message history per thread, persisted across reloads via
  `Arcade.state`.
- File/image transfer — chunked and reassembled over the data channel. The
  framework *does* ship `sendBlob`, and it honours `{to}`; this game keeps its
  own chunking because a subset fan-out would mean one blob transfer per
  member, the blob envelope has nowhere to carry the `groupId` every frame
  here needs, and one dead target rejects the whole promise instead of being
  pruned (see `app.js` and issue #18). Files live inline in the chat: images as
  thumbnails, everything else as a card with a download link; previewable
  types (image/video/audio/PDF) open in a lightbox. Group file shares fan
  out individually to each member.
- A compact status pill on the conversations screen shows transport state
  (standalone / nobody yet / connecting / connected / reconnecting). "Nobody
  yet" is the `idle` state — no scope open — and it is deliberately *not*
  "not paired": it is a perfectly ordinary reading with several devices paired
  and connected, and calling it a pairing problem sent people to redo a
  ceremony that had already worked.

## Delivery semantics (lossy, at-most-once)

Messages ride the launcher's data channel fire-and-forget: **at-most-once**
delivery, with no acknowledgements, retries, or store-and-forward. A message
sent to an offline peer is simply lost — it stays in the *sender's* local
history, but nothing backfills the recipient when they reconnect. The sender
marks a bubble "not delivered" only when the transport refuses the send
outright; a send the transport accepted can still be lost in flight. (The
transport does replay sends queued during a brief `interrupted` window, but
that is best-effort, not an end-to-end guarantee.) Every message routes to
exactly one conversation: frames carry an optional `groupId`, so a group
message lands only in that group — and only if the sender is a member — and
a direct message lands only in that peer's 1:1 thread. The one
re-sync-on-reconnect exception is group *membership*: the creator re-pushes
the member list to peers as they come back online.

## Integration notes

This game talks to `Arcade.peer.status()` / `onStatus` / `send` /
`onMessage` / `self()` / `onReady` / `peers()` / `onPeersChange` / `caps()` /
`invite()` — see
[GAME_INTEGRATION.md](https://github.com/paulgibeault/paulgibeault.github.io/blob/main/GAME_INTEGRATION.md)
in the launcher repo for the full contract. No WebRTC, QR, or signaling code
lives here. The group-chat protocol (`group-sync` / `group-leave`, plus an
optional `groupId` on `msg`/`file-*` frames) is entirely app-level, layered
on top of the framework's targeted `send(payload, {to})` — the launcher has
no notion of "groups."

## Local development

From the launcher repo:

```sh
./dev.sh ../p2p-chat
```

Then open `http://127.0.0.1:4791/` and launch **P2P Chat** from the grid, or
open `http://127.0.0.1:4791/p2p-chat/` directly for standalone mode (no
multiplayer, `Arcade.peer.status()` is `'unavailable'`).
