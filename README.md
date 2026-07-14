# P2P Chat

A demonstration game for [Paul's Arcade](https://paulgibeault.github.io) — a
neatly appointed messaging interface that proves out the arcade's
launcher-owned multiplayer framework (`Arcade.peer.*`).

Players pair through the arcade's **Multiplayer** menu (QR code or reply
link, no signaling server). The launcher's transport is a star topology — a
host plus any number of joiners in one live session — so this game supports
any number of simultaneously-connected peers, not just a single pair.

## Features

- A tab per known peer, plus tabs for group chats. Peer identity comes from
  the SDK's roster/presence APIs (`Arcade.peer.onReady` /
  `Arcade.peer.onPeersChange`) — no hand-rolled hello handshake. A tab is
  "live" when its peer (or, for a group, any of its members) is currently
  reachable; otherwise it's a read-only archive of past history until they
  reconnect.
- **Renameable tabs** — click the ✎ next to a thread's name to relabel it
  for your own organization. A rename is local and sticks even if the peer's
  device name or a group's synced name later changes.
- **Group chats** — the "+ Group" button lets you name a group and pick
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
  chunking itself; see `app.js`). Group file shares fan out individually to
  each member.
- A dedicated Files tab per thread for managing everything sent or received
  there (download, remove individual files, clear all).
- "Clear chat" / "Clear files" (scoped to the thread in view),
  connection-status banner, and a lightbox for image previews.

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
