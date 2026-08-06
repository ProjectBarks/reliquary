<p align="center">
  <img src="resources/icon.png" width="112" alt="Reliquary" />
</p>

<h1 align="center">Reliquary</h1>

<p align="center">
  A transparent, click-through <b>Slay the Spire 2</b> companion overlay —<br/>
  deck tracker, deck-conditioned draft advice, and incoming-attack forecasts.
</p>

<p align="center">
  <a href="https://github.com/ProjectBarks/reliquary/releases/latest">
    <img alt="Download Reliquary for Windows"
         src="https://img.shields.io/badge/Download%20for%20Windows-b47bff?style=for-the-badge&logo=windows&logoColor=white" />
  </a>
</p>

<p align="center">
  <a href="https://github.com/ProjectBarks/reliquary/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/ProjectBarks/reliquary?color=b47bff&label=latest" /></a>
  <img alt="Electron" src="https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white" />
  <img alt="React" src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" />
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-b47bff" />
</p>

---

**Reliquary** reads live game state directly from Slay the Spire 2's process memory and paints
a HUD over the game — no log files, no manual input. It's modeled on the Untapped.gg Companion,
rebuilt from scratch on Electron + React.

![Reliquary dashboard](docs/screenshots/dashboard.png)

## Features

- **Deck tracker** — draw-pile odds grouped by type (Attack / Skill / Power / Other), with
  per-group draw-% and card counts. Collapsible, and draggable to reposition.
- **Draft advice** — deck-conditioned *"for your deck"* letter grades on card rewards,
  choose-a-card, and shop cards, alongside global tier, win-rate, pick-rate, and the owned
  cards driving each pick. An animated placeholder shows while a grade is still loading.
- **Attack forecast** — total incoming damage and hit count from enemy intents, in combat.
- **Branded dashboard** — a frameless companion window with **Home / Debug / Logs** tabs:
  live status, overlay toggles, a syntax-highlighted game-state inspector, and a streaming
  in-app log viewer.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/overlay-combat.png" alt="Deck tracker and attack forecast" /></td>
    <td width="50%"><img src="docs/screenshots/overlay-reward.png" alt="Deck-conditioned draft advice" /></td>
  </tr>
  <tr>
    <td align="center"><sub>Deck tracker + attack forecast, in combat</sub></td>
    <td align="center"><sub>Deck-conditioned draft advice on a card reward</sub></td>
  </tr>
</table>

> The overlay shots use the built-in demo data (`SPECTRA_STUB`), hence the "stub data" badge.

## How it works

- **Game state** comes from process memory via a vendored native module (`untapped-scry`),
  read on a ~150 ms poll loop and diffed so the UI only updates on real change.
- **Card metadata** (names, types, costs, art) is fetched from the Untapped CDN.
- **Advice & stats** come from the Spire Codex API (`/api/cards`,
  `/api/runs/metrics/cards`, `POST /api/draft-advice`), primed once per data version and cached.
- Two windows share one React bundle via hash routing: a transparent, click-through,
  always-on-top **overlay** pinned to the game window, and a normal **dashboard**.

## Requirements

- Windows 10/11
- Node.js 20+
- Slay the Spire 2

## Getting started

### Install (just want to use it)

Grab the installer from the
[latest release](https://github.com/ProjectBarks/reliquary/releases/latest) —
`Reliquary-<version>-setup.exe` — and run it. It installs for the current user with no prompts
and no elevation, which is also what lets updates apply silently later. Everything it needs is
bundled; there are no extra steps. Launch Reliquary, then start Slay the Spire 2 (either order works).

Windows SmartScreen will warn on first run because the installer is unsigned: choose
**More info → Run anyway**. From then on Reliquary
[keeps itself up to date](#updates) automatically.

### Build from source (development)

```bash
npm install
npm run dev          # launches the dashboard + overlay (electron-vite)
```

Try it without the game, using built-in demo data:

```powershell
$env:SPECTRA_STUB = 1; npm run dev
```

Build a Windows installer (NSIS → `release/`):

```bash
npm install --save-dev electron-builder
npm run dist
```

Regenerate the app icon (`build/icon.ico` + `resources/icon.png`):

```bash
npm run icon
```

## The native module

Reliquary reads game memory through small vendored native modules in `vendor/`
(`untapped-scry` — the memory reader — and `untapped-node-native` — Win32 window helpers).
They're bundled into the packaged app (electron-builder `extraResources`), so the installer
works out of the box with no extra setup. If the module ever fails to load, the app still
launches: the dashboard runs, `SPECTRA_STUB` demo mode works, and the overlay waits for the game.

## Hotkeys

| Shortcut | Action |
| --- | --- |
| `Ctrl + Shift + H` | Hide / show all overlays |

## Tech stack

Electron 33 · React 18 · TypeScript · styled-components · electron-vite · electron-builder ·
PostHog (diagnostics).

## Updates

Reliquary updates itself over the air from GitHub Releases via
[`electron-updater`](https://www.electron.build/docs/features/auto-update/). It checks shortly
after launch and every few hours, downloads new versions in the background, and installs them
**on quit** — never mid-session, because the overlay sits on top of a running game and relaunching
underneath a run in progress would be worse than shipping the fix a session later.

Updates install **silently** — no wizard, no elevation prompt, no reinstall flow. A pill in the
titlebar shows download progress and turns into a **Restart** button once an update is staged. Ignoring it is fine; the update still installs the next time you close the app. The
**Debug** tab shows the running version and has a **Check for updates** button for checking on
demand.

Set `SPECTRA_NO_UPDATE=1` to disable update checks.

## Diagnostics

Reliquary reads another process's memory and paints a click-through window over a game. When
that breaks it usually breaks *silently* — no error, just an overlay that stopped showing
numbers. So the app reports crashes and degraded states (game not found, native module missing,
Codex rate-limited, a panel that failed to render) to PostHog, with breadcrumbs and recent log
lines attached so the cause is reconstructable.

**What is sent:** a random install id, app/OS/GPU versions, error messages and stack traces, and
counters for which subsystems are failing.

**What is never sent:** your name, account, Steam id, file paths (they are scrubbed), or anything
about the run you are playing — no deck, cards, or game content.

Turn it off entirely by setting `SPECTRA_TELEMETRY=0`. The **Debug** tab shows exactly what the
reporter is doing, including every issue recorded in the current session.

Builds ship with a PostHog *project* key baked in, so reporting works out of the box. That key is
write-only — it can send events and nothing else, grants no read access, and is extractable from
any built binary regardless of where it is stored, so there is nothing gained by hiding it.

To point a build at a different project, or to build with reporting compiled out entirely:

```bash
POSTHOG_KEY=phc_yourkey npm run dist   # your own project
POSTHOG_KEY= npm run dist              # nothing is ever sent
```

## Disclaimer

Reliquary is an **unofficial**, personal/educational project. It is not affiliated with or
endorsed by MegaCrit (Slay the Spire) or Untapped.gg. Reading game memory and using third-party
APIs may conflict with a game's or a service's terms of use — use at your own risk.

## Acknowledgements

Reliquary is only possible thanks to the data behind it:

- 💜 **[Spire Codex](https://spire-codex.com)** — for the card stats and deck-conditioned
  draft-advice API that powers every recommendation Reliquary makes. Thank you!
- **[Untapped.gg](https://untapped.gg)** — for the Slay the Spire 2 card-metadata CDN, and for
  the Companion overlay that inspired this project.
- **[MegaCrit](https://www.megacrit.com)** — for making Slay the Spire 2.

## License

[MIT](LICENSE) © Brandon Barker — for the application code in this repository. The vendored
native module and any third-party assets or APIs are not covered and remain the property of
their respective owners.
