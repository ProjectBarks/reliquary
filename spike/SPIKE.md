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

## The official mod contract (extracted from the game itself)

`spike/dumpmeta` is a .NET tool that reads `sts2.dll`'s metadata directly — so the mod is
written against the real API, not guesses. Full dump: `spike/game-api.txt` (844 lines).

```
MegaCrit.Sts2.Core.Modding
├─ ModInitializerAttribute   → field: initializerMethod        (entry point)
├─ ModManifest               → id, name, author, description, version,
│                              hasPck, hasDll, dependencies,
│                              affectsGameplay, minGameVersion
├─ ModManager / ModLoadState / ModSource / ModSettings
└─ ModHelper  (public static)
     ├─ SubscribeForRunStateHooks      ← official run-state events
     ├─ SubscribeForCombatStateHooks   ← official combat-state events
     ├─ IterateAllRunStateSubscribers
     └─ AddModelToPool / ConcatModelsFromMods
   + RunHookSubscriptionDelegate, CombatHookSubscriptionDelegate
```

**The game hands us event hooks for exactly the state we need** — no polling, no patching
required for the core data.

Object graph roots (both static singletons — everything else hangs off these):

```
NGame.Instance : Godot.Control
  └─ RootSceneContainer, CurrentRunNode, InspectCardScreen, InspectRelicScreen, …
NRun.Instance
  └─ CombatRoom, MerchantRoom, EventRoom, RestSiteRoom, TreasureRoom, MapRoom, GlobalUi
```

Regenerate anytime:

```bash
cd spike/dumpmeta && dotnet run > ../game-api.txt
```

## Environment (verified against this install)

| | |
| --- | --- |
| Game | `v0.107.1` (commit 59260271) — key compat off `release_info.json`, **not** assembly version (always `0.1.0.0`) |
| Godot | 4.5.1 · Runtime: **self-contained .NET 9.0.7** · Harmony **2.4.2** (shipped) |
| Mod root | `<game>\mods\` — **does not exist yet, must be created** |
| Logs | `sts2_stdout.log` / `sts2_stderr.log` in game root |

**`Microsoft.AspNetCore.App` is NOT shipped** → Kestrel/minimal API is impossible (hostfxr already
consumed its runtimeconfig before our DLL loads). But `System.Net.HttpListener`,
`System.Net.WebSockets`, `System.Net.Sockets`, `System.IO.Pipes` **are** shipped → zero-dependency
HTTP + WebSocket server for free.

## Mod design rules (learned from STS2MCP, MIT, 458★ — our blueprint)

```csharp
[ModInitializer(nameof(Initialize))]
public static class Reliquary {
    public static void Initialize() {
        new Harmony("me.brandonbarker.reliquary").PatchAll(typeof(Reliquary).Assembly);
        var tree = (SceneTree)Engine.GetMainLoop();          // static access, no Node needed
        tree.Connect(SceneTree.SignalName.ProcessFrame, Callable.From(OnProcessFrame));
    }
}
```

1. **Prefer the game's 144 semantic hooks over Harmony.** `AfterCardChangedPiles` gives push-based
   deck-tracker updates with zero polling; `AfterModifyingCardRewardOptions` fires exactly when the
   draft-advice panel needs data. Escalation order: override models → hooks → Harmony last.
2. **The scene tree is NOT thread-safe.** Build an immutable snapshot on `ProcessFrame` and publish
   it with one atomic `volatile` reference write; the HTTP thread only reads that reference.
   No locks, no scene access off-thread.
3. **Always guard `GodotObject.IsInstanceValid(node)`** — a freed node is a *hard process crash*,
   not an exception.
4. **Scene-tree child order ≠ visual order.** Sort `Control` nodes by `GlobalPosition` for card
   rewards, or they come back scrambled intermittently.
5. **Reflection must walk the hierarchy** — `Type.GetField(NonPublic)` does *not* search base
   classes. Iterate `t = t.BaseType` with `DeclaredOnly`, cache in a `ConcurrentDictionary`.
6. Never `.Wait()`/`.Result` a game `Task` inside a patch — deadlocks the command sequencer.
7. Manifest: set **`affects_gameplay: false`** so runs aren't flagged as modded
   (`IsRunningModded` / `GetGameplayRelevantModNameList` exist in the assembly).
8. Call `_listener.Stop()` on shutdown or the game hangs on quit; throttle pushes (don't serialize
   at 144 Hz).

Most state is **public** — no reflection needed for the core:
`combatState.DrawPile.Cards` · `.DiscardPile` · `.ExhaustPile` · `.Hand` ·
`(monster.NextMove as MoveState).Intents` · `merchantRoom.GetLocalInventory()` ·
`MegaCrit.Sts2.Core.Runs.RunManager.Instance`

## Reference implementations

| Repo | Why | License |
| --- | --- | --- |
| [Gennadiyev/STS2MCP](https://github.com/Gennadiyev/STS2MCP) | **Blueprint.** Mod + HttpListener REST on `:15526`; solves main-thread queue, IsInstanceValid, position-sorted holders, v0.107 changes | MIT ✅ |
| [WRXinYue/STS2-KitLib](https://github.com/WRXinYue/STS2-KitLib) | Modular toolkit, WS live-reload | MIT ✅ |
| [S0ul3r/BoberInSpire](https://github.com/S0ul3r/BoberInSpire) | Closest analog: C# mod → JSON → WS → overlay | ⚠️ unstated — read only |
| [elliotttate/sts2-modding-mcp](https://github.com/elliotttate/sts2-modding-mcp) | Auto-decompiles sts2.dll via ilspycmd, indexes 3048 entities + 144 hooks | MIT ✅ |
| [Modding-Tutorial](https://fresh-milkshake.github.io/Modding-Tutorial/) | De-facto handbook | — |

**Not applicable:** GDWeave and godot-mod-loader target *GDScript* games; StS2's logic is managed
C# with an official loader. BepInEx has no mature Godot loader.

## Next steps

1. Install [STS2MCP](https://github.com/Gennadiyev/STS2MCP), curl `localhost:15526`, diff its
   JSON against the keys above — confirms coverage before writing any C#.
2. Scaffold `Reliquary.dll` mod (net9.0, refs `sts2.dll`/`GodotSharp.dll`/`0Harmony.dll`);
   one Harmony hook; push state over WebSocket.
3. Wire it as a `compareCandidate` source → drive fidelity to 100% off `diffs.jsonl`.
4. Flip the default source, keep scry behind a flag, then delete the native addon + `vendor/`.

Blocker for step 2: no .NET SDK on this machine (`winget install Microsoft.DotNet.SDK.9`).
