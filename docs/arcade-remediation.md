# Plan — P2P Chat (`paulgibeault/p2p-chat`, gameId `p2p-chat`) — ✅ COMPLETE

**All items shipped** in PR [#2 `arcade-review-fixes`](https://github.com/paulgibeault/p2p-chat/pull/2)
(merged 2026-07-10). Verified in code 2026-07-10.

| # | Item | Where it landed |
| - | ---- | --------------- |
| 1 | Stored XSS: `sanitizeId()` charset-clamps every peer-supplied id; `alt`/title escaped (critical) | `app.js:24-26,462-537,661` (`2262fa5`) |
| 2 | File-send parks during `interrupted`, drains on reconnect | `app.js:370-374,605-609` (`4dbe7d9`) |
| 3 | Reduced-motion consumes `--motion-scale` with multiply semantics | `styles.css:81-82,170,265` |
| 4 | `Arcade.player.onChange` → update name + re-hello | `app.js:799-804` |
| 5 | No-op `migrate('v1')` sentinel | `app.js:783` |
| 6 | `payload.chunks` bounded by `MAX_CHUNKS` | `app.js:10,499-503` |
| 7 | Catalog entry resolved by **removing** the TEMP launcher button | launcher `index.html` (no p2p-chat entry) |

## Remaining actions (housekeeping only)
- **Close the paired integration issue [p2p-chat #1](https://github.com/paulgibeault/p2p-chat/issues/1)** — its PR is merged.
- **Decision still open (launcher-side, framework A7/§7):** promote p2p-chat to a real
  release (add the `profile.html #games` mirror) **or** leave it out. Tracked as launcher
  issue [#25](https://github.com/paulgibeault/paulgibeault.github.io/issues/25). Button is
  already removed, so "leave out" is the current default.
- Framework asks this app surfaced (peer identity/roster, sendBlob delivery-ack) already
  **shipped in the SDK** (B6/B7) but p2p-chat hasn't adopted them yet — low-priority, optional.
