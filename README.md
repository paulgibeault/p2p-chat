# P2P Chat

A demonstration game for [Paul's Arcade](https://paulgibeault.github.io) — a
neatly appointed messaging interface that proves out the arcade's
launcher-owned multiplayer framework (`Arcade.peer.*`).

Two players pair through the arcade's **Multiplayer** menu (QR code or
reply link, no signaling server), then this game lets them exchange text
messages and files directly over the resulting WebRTC data channel.

## Features

- A tab per known peer. `Arcade.peer` is a strictly 1:1 connection — only one
  device can be live at a time — but this game remembers every peer it has
  ever exchanged a hello with (keyed by a self-generated persistent id, not
  just a display name) and gives each its own thread. Only the tab matching
  the currently-connected peer is "live"; every other known peer's tab is a
  read-only archive of past history until that peer reconnects.
- Text chat with message history per peer, persisted across reloads via
  `Arcade.state`.
- File/image transfer — chunked and reassembled over the data channel (no
  binary/file support exists at the framework level, so this game owns that
  chunking itself; see `app.js`).
- A dedicated Files tab per peer for managing everything sent or received
  with them (download, remove individual files, clear all).
- "Clear chat" / "Clear files" (scoped to the peer tab in view),
  connection-status banner, and a lightbox for image previews.

## Integration notes

This game only talks to `Arcade.peer.status()` / `onStatus` / `send` /
`onMessage` — see [GAME_INTEGRATION.md](https://github.com/paulgibeault/paulgibeault.github.io/blob/main/GAME_INTEGRATION.md)
in the launcher repo for the full contract. No WebRTC, QR, or signaling code
lives here.

## Local development

From the launcher repo:

```sh
./dev.sh ../p2p-chat
```

Then open `http://127.0.0.1:4791/` and launch **P2P Chat** from the grid, or
open `http://127.0.0.1:4791/p2p-chat/` directly for standalone mode (no
multiplayer, `Arcade.peer.status()` is `'unavailable'`).
