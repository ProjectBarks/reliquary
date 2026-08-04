# Spike: replacing the proprietary native reader

Goal: drop `untapped-scry.node` (closed-source C++ N-API memory reader) and get the
same game state from our own open-source implementation — then run both side by side,
diff them, and close the gaps until fidelity is 100%.

## Findings so far

### The game is wide open (verified against the shipped binaries)

| Fact | Evidence |
| --- | --- |
| Godot 4 (MegaCrit's custom "MegaDot") + **.NET 9 CoreCLR** | `coreclr.dll`, `hostfxr`, `GodotSharp.dll` loaded in-process |
| Game logic in **`sts2.dll` (8.9 MB managed, NOT obfuscated)** | plain type/field names in metadata |
| **Official mod support** | `sts2.dll` exports `IMod`, `ModInitializer`, `ModManifest`, `LoadMod`, `Workshop` |
| Runtime patching already shipped | `0Harmony.dll`, `MonoMod.Backports.dll`, `MonoMod.ILHelpers.dll` |

### Binding gap analysis — `node spike/verify-bindings.mjs`

Every type/field our reader depends on, checked against `sts2.dll` metadata:

```
FIELDS  78/79 resolved   (missing: _turnState)
CLASSES 13/13 resolved
```

**The entire binding surface is resolvable by name.** No offset reverse-engineering
is required — a reimplementation can bind by type/field name via reflection.
Report: `spike/binding-report.json`.

### Approaches evaluated

| Path | Verdict |
| --- | --- |
| **In-process C# mod** (Harmony + official mod API) → WS/HTTP → Electron | ✅ **Recommended** |
| Fork [STS2MCP](https://github.com/Gennadiyev/STS2MCP) (MIT, already serves state on `:15526`) | ✅ Best first spike / fallback |
| Log + save-file parsing (`%APPDATA%\SlayTheSpire2`) | ⚠️ Post-run analytics only — not live enough for combat |
| DIY external memory reading (memoryjs + Godot offsets) | ❌ Very high effort/risk; MegaDot ≠ stock Godot offsets |
| **ClrMD** | ❌ **Disqualified** — live attach uses `PssCreateSnapshot`, which *suspends* the game |

Why the mod wins: exact typed data (vs. guessed offsets), event-driven push (vs. 150 ms
polling), clear startup errors (vs. silently wrong values), no `OpenProcess`/
`ReadProcessMemory` anti-cheat/AV surface, cross-platform from one build, and it deletes
the C++ addon *and* the proprietary binaries from this repo.

## Shadow harness (built, working)

`src/main/shadow/` runs alongside the live provider under `SPECTRA_SHADOW=1`:

- **`recordPrimary(snap)`** — records every snapshot the current scry provider emits to
  `<userData>/shadow/primary.jsonl`. This is the ground-truth fixture.
- **`compareCandidate(key, value, source)`** — diffs a candidate source's snapshot against
  the primary for the same key; every mismatch is logged to `shadow/diffs.jsonl` with a
  structural path (`pileState.draw[3].id`), both values, and a reason.
- **`shadowStats()` / `flushShadowSummary()`** — running fidelity % (matched / compared),
  written to `shadow/summary.jsonl` on quit.

Verified capturing live: `sts2.pileState`, `sts2.enemiesState`, `sts2.nGameState`,
`sts2.layoutState`, `sts2.cardData`, `sts2.settings`.

```bash
SPECTRA_DEBUG=1 SPECTRA_SHADOW=1 npm run dev
```

## Next steps

1. Install [STS2MCP](https://github.com/Gennadiyev/STS2MCP), curl `localhost:15526`, diff its
   JSON against the keys above — confirms coverage before writing any C#.
2. Scaffold `Reliquary.dll` mod (net9.0, refs `sts2.dll`/`GodotSharp.dll`/`0Harmony.dll`);
   one Harmony hook; push state over WebSocket.
3. Wire it as a `compareCandidate` source → drive fidelity to 100% off `diffs.jsonl`.
4. Flip the default source, keep scry behind a flag, then delete the native addon + `vendor/`.

Blocker for step 2: no .NET SDK on this machine (`winget install Microsoft.DotNet.SDK.9`).
