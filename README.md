# P2P Chat

A demonstration game for [Paul's Arcade](https://paulgibeault.github.io) — a
neatly appointed messaging interface that proves out the arcade's
launcher-owned multiplayer framework (`Arcade.peer.*`).

Players pair through the arcade's **Multiplayer** menu (QR code or reply
link, no signaling server). The launcher's transport is a star topology — a
host plus any number of joiners in one live session — so this game supports
any number of simultaneously-connected peers, not just a single pair.

## Features

- A two-screen layout: a **conversations screen** (most-recently-active
  first, with unread badges and live-status dots) and a **full-page chat**
  you tap into, with a back button to return. Group rows list every member
  inline with a per-member presence dot that updates in real time. Peer
  identity comes from the SDK's roster/presence APIs (`Arcade.peer.onReady`
  / `Arcade.peer.onPeersChange`) — no hand-rolled hello handshake. A
  conversation is "live" when its peer (or, for a group, any of its members)
  is currently reachable; otherwise it's a read-only archive of past history
  until they reconnect.
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
- Text chat with message history per thread, persisted across reloads via
  `Arcade.state`.
- File/image transfer — chunked and reassembled over the data channel (no
  binary/file support exists at the framework level, so this game owns that
  chunking itself; see `app.js`). Files live inline in the chat: images as
  thumbnails, everything else as a card with a download link; previewable
  types (image/video/audio/PDF) open in a lightbox. Group file shares fan
  out individually to each member.
- A compact status pill on the conversations screen shows transport state
  (standalone / not paired / connecting / connected / reconnecting).

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
`onMessage` / `self()` / `onReady` / `peers()` / `onPeersChange` — see
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
