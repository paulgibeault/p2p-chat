# P2P Chat

A demonstration game for [Paul's Arcade](https://paulgibeault.github.io) — a
neatly appointed messaging interface that proves out the arcade's
launcher-owned multiplayer framework (`Arcade.peer.*`).

Two players pair through the arcade's **Multiplayer** menu (QR code or
reply link, no signaling server), then this game lets them exchange text
messages and files directly over the resulting WebRTC data channel.

## Features

- Text chat with message history, persisted across reloads via `Arcade.state`.
- File/image transfer — chunked and reassembled over the data channel (no
  binary/file support exists at the framework level, so this game owns that
  chunking itself; see `app.js`).
- A dedicated Files tab for managing everything sent or received in the
  session (download, remove individual files, clear all).
- "Clear chat" / "Clear files", connection-status banner, and a lightbox for
  image previews.

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
