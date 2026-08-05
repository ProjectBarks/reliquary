# Reliquary — product context

Durable product truth. No visual decisions live here; those belong to the code
and to per-surface briefs.

## What it is

A companion overlay for **Slay the Spire 2**. It reads live game state directly
from the game's process memory and paints a HUD on top of the game window: deck
tracker, incoming-attack forecast, and deck-conditioned draft advice on card
rewards, shops, and ancient/event choices.

Unofficial, and not affiliated with MegaCrit or Untapped.gg. Modeled on the
Untapped.gg Companion, rebuilt on Electron + React.

## Who it is for

**The public.** It ships as a signed-by-nobody `.exe` from GitHub Releases, and
strangers install it. This is the single most consequential fact about the
design:

- A first-time user arrives having just clicked past a Windows SmartScreen
  warning. They are provisionally trusting, and one bad first impression sends
  them away.
- They do not know what "scry", "Codex", or an overlay window is. They may not
  have the game running when they first launch.
- They are game-literate but app-illiterate: assume deep Slay the Spire
  knowledge, explain only Reliquary's own concepts.

Consequence: first-run, empty, and failure states are first-class requirements,
not polish. The app must never claim to be working when it is not.

## Two surfaces, two jobs

| Surface | Job | Seen for |
| --- | --- | --- |
| **In-game overlay** | Give numbers at a glance, mid-decision, over a busy game | hours |
| **Dashboard** | Answer "is this working?", change what's drawn, and produce a bug report | seconds, twice a session |

The dashboard is the *only* place a stranger can understand the app or diagnose
it, because the overlay is transparent and click-through and says nothing about
itself.

## What makes it different

It reads memory rather than log files, so it is live and needs no manual input.
Draft advice is conditioned on the deck you actually have, not global win rates
alone — that is the thing a generic tier list cannot do.

## Constraints that bind design

- **Windows-only** in practice (the memory reader is Win32).
- **The overlay is click-through and transparent.** It cannot host controls, and
  a render failure there is invisible — no error, just nothing.
- **The game must not be modified.** External reads only; no mod, no injection,
  no save-file access. This is a promise worth stating to users.
- **Everything degrades.** The game may be closed, the reader may fail to load,
  the Codex API may be down or rate-limited. Each has to have an honest state.
- **Offline-capable.** Advice data is remote; its absence must not break the app.
- **Anonymous diagnostics only.** No game content, account, or file paths leave
  the machine. Users can switch it off in the UI.

## Non-goals

Not a mod, not a cheat, not a replay analyser, not a deck builder, not a
launcher. It does not tell you what to pick — it shows you what the numbers say.
