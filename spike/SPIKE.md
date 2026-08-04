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

> ### ⚠️ DIRECTION CORRECTION
> An earlier pass recommended replacing the native module with an **in-game C# mod**.
> **That was wrong** — it changes what Reliquary *is*: game-folder install, a consent
> popup, disabled Steam achievements, and it only works while the game cooperates.
> Reliquary is an **external, read-only memory reader**; the goal is our own binary of
> the *same kind*, not a different architecture. **All mod code and installed binaries
> have been deleted.** The sections below about the mod API remain only as reference on
> the game's internals. The live plan is **"CoreCLR bootstrap SOLVED"** at the bottom.

| Path | Verdict |
| --- | --- |
| **Own external memory reader** (koffi + `g_dacTable` bootstrap) | ✅ **THE PLAN** — same architecture as today, our code |
| In-process C# mod | ❌ Rejected — changes the product; needs install + consent, kills achievements |
| Log + save-file parsing | ❌ Post-run only — not live enough for combat |
| **ClrMD** | ❌ Disqualified — live attach uses `PssCreateSnapshot`, which *suspends* the game |

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

## ✅ Working mod skeleton — `spike/mod/` (builds clean, 0 errors)

`SpectraBridge` compiles against the real v0.107.1 game assemblies (`<Private>false</Private>`, so
no game DLLs are copied). It has `[ModInitializer]`, a main-thread pump, `HttpListener` + WebSocket
broadcast, a Run/Combat JSON snapshot builder, and a Harmony postfix on `RunManager.EnterRoom`.

```bash
cd spike/mod && dotnet build -c Release      # → 17.9 KB SpectraBridge.dll
```

`spike/apidump/` is an API explorer — `dotnet run -- CombatState PlayerCombatState` dumps real
members (incl. private fields) without launching the game. **Keep this**: most published guidance
is version-stale, so verify against the installed build rather than trusting docs.

### ⚠️ Corrections to earlier assumptions (verified against metadata + a green build)

1. **`IMod` does not exist.** The contract is `[ModInitializer(nameof(Method))]` on a class — no
   interface. Omit the attribute entirely and the loader auto-runs `Harmony.PatchAll`.
2. **`CombatState` has NO `DrawPile`/`DiscardPile`/`ExhaustPile`** — those live on
   **`PlayerCombatState`**. STS2MCP's published state code targets an older build and **will not
   compile against v0.107.1**. Use it for architecture, not for field paths.
3. Model identity is `AbstractModel.Id` (not `.ModelId`); `Creature` uses `.CurrentHp`/`.MaxHp`.

### Real v0.107.1 state access

```csharp
if (!RunManager.Instance.IsInProgress) return;
RunState run = RunManager.Instance.DebugOnlyGetState();   // Act, ActFloor, TotalFloor,
                                                          // AscensionLevel, CurrentRoom, Map
Player me = run.Players[0];                               // Gold, Relics, Deck, Creature
if (run.CurrentRoom is CombatRoom && CombatManager.Instance.IsInProgress) {
    CombatState cs   = CombatManager.Instance.DebugOnlyGetState();  // RoundNumber, Enemies
    PlayerCombatState p = me.PlayerCombatState;   // Hand/DrawPile/DiscardPile/ExhaustPile,
}                                                 // Energy, TurnNumber, Phase
```

Scene-tree fallback: `(SceneTree)Engine.GetMainLoop()`, root `/root/Game`,
run subtree `/root/Game/RootSceneContainer/Run/...` (literal paths present in the binary).

### Manifest + install

`<game>/mods/<ModId>/` — **create it; it does not exist.** Ship `SpectraBridge.dll` +
`SpectraBridge.json`. Fields (JSON names): `id` (**required**, must match the DLL basename),
`name`, `author`, `description`, `version` (valid semver), `has_pck`, `has_dll`, `dependencies`
(`id` + `min_version`), `affects_gameplay` (**set false**), `min_game_version`.

**Gotcha:** mod loading is gated behind a first-launch consent popup (`PlayerAgreedToModLoading`) —
nothing loads until the user accepts. Also, an `HttpListener` prefix on `127.0.0.1` may need
`netsh http add urlacl` on some non-admin setups; prefer the literal `localhost` prefix.

MegaCrit ships **`sts2.xml`** (5.3 MB of real doc comments for `sts2.dll`) and references an
official example mod at `gitlab.com/megacrit/sts2/example-mod`.

## Cross-platform: ✅ confirmed Windows + macOS + Linux

StS2 ships **native** builds for all three ([Steam](https://store.steampowered.com/app/2868840/Slay_The_Spire_2/) has three
System Requirements tabs; [MegaCrit FAQ](https://www.megacrit.com/faq/) confirms). The mod loader is
managed .NET, so it is portable — with runtime proof, not inference:

- Linux: `--- RUNNING MODDED! --- Loaded 7 mods (7 total)` ([ModConfig-STS2 #3](https://github.com/xhyrzldf/ModConfig-STS2/issues/3))
- macOS + Linux: [STS2FirstMod](https://github.com/jiegec/STS2FirstMod) — *"Tested to build & run in both macOS and Linux."*
- MegaCrit's own [mod uploader](https://github.com/megacrit/sts2-mod-uploader) ships `osx-arm64`, `osx-x64`, `linux-x64` binaries
- STS2MCP: *"the same DLL … work[s] on Windows, Linux, and macOS."* No repo surveyed claims Windows-only.

**This is the whole reason to switch.** `untapped-scry.node` is a PE32+ Windows DLL using
`OpenProcess`/`ReadProcessMemory` — macOS was *impossible*. Our mod is `net9.0` with **no
RuntimeIdentifier** → one platform-agnostic assembly.

| OS | game assemblies | mods folder |
| --- | --- | --- |
| Windows | `<game>/data_sts2_windows_x86_64/` | `<game>/mods/` |
| macOS | `SlayTheSpire2.app/Contents/Resources/data_sts2_macos_arm64/` | `…/SlayTheSpire2.app/Contents/MacOS/mods/` |
| Linux | `<game>/data_sts2_linuxbsd_x86_64/` | `~/.local/share/Steam/steamapps/common/Slay the Spire 2/mods/` |

Platform gotchas: lowercase `mods` on Unix (case-sensitive FS) · Linux Harmony native detours can
fail (`mm-exhelper.so` on `noexec /tmp`, `_Unwind_RaiseException`) — *managed loading is portable,
native detouring is fragile, so prefer semantic hooks over Harmony · possible Apple-Silicon `.pck`
`binary_format/architecture=msil` requirement (unverified) · one secondary source claims macOS needs
launching via Finder with Rosetta (unverified).

## Docs reality: there is no public official documentation

- **`gitlab.com/megacrit/sts2/example-mod` is PRIVATE** (403 web/raw, 404 API). The string in the
  binary is an internal reference — not a public resource.
- The only official public repo is [sts2-mod-uploader](https://github.com/megacrit/sts2-mod-uploader), which documents
  *Workshop publishing only* — not the mod API, manifest schema, or hooks.
- Community wiki, verbatim: *"As STS2 does not have a formal modding API, nearly all of the
  information here has been gathered and maintained by the modding community."*

**→ `spike/modding-docs.xml` (extracted from the shipped `sts2.xml`) is therefore the most
authoritative modding documentation available anywhere** — MegaCrit's own doc comments, exactly
matching your installed build. Regenerate after any patch.

Best community sources: [fresh-milkshake handbook](https://fresh-milkshake.github.io/Modding-Tutorial/) (11 chapters, pinned
v0.103.3 — Windows-only paths) · [ModSmith](https://cpimhoff.github.io/Sts2-ModSmith/) (**only one documenting all 3
platforms**) · [BaseLib](https://github.com/Alchyr/BaseLib-StS2) · [RitsuLib](https://github.com/BAKAOLC/STS2-RitsuLib) (only lib that versions
against game API generation).

**No API stability policy exists.** *"Early Access updates can change signatures and loader
contracts."* / *"Compilation is only the first compatibility check."* Breakage is already observable
across releases — re-validate every patch. Also note: **active Workshop mods disable Steam
achievements**, and mod loading requires the first-run consent popup.

## Shipping our own binary — what's actually left

**Our binary is `SpectraBridge.dll`** (`spike/mod/`, builds clean). It replaces
`untapped-scry.node` + `untapped-node-native.node` entirely — no C++, no node-gyp, no
`OpenProcess`.

### Parity contract — 4 keys

`sts2.cardData` (CDN) and `sts2.settings` (SettingsStore) are **out of scope**; the native reader
only owns these:

| Key | Source in the mod |
| --- | --- |
| `sts2.pileState` | `player.PlayerCombatState` → `Hand`/`DrawPile`/`DiscardPile`/`ExhaustPile` |
| `sts2.enemiesState` | `CombatManager.Instance.DebugOnlyGetState()` → `Enemies`, `(m.NextMove as MoveState).Intents` |
| `sts2.nGameState` | `RunManager.Instance.DebugOnlyGetState()` → `CurrentRoom`, `Act`, + `NGame.Instance` screen flags |
| `sts2.layoutState` | scene-tree walk, `FindAllSortedByPosition<NCardHolder>` + `merchantRoom.GetLocalInventory()` |

`layoutState` is the hard one — it needs on-screen **positions** (`GlobalPosition`/size → screen
fractions) for tip anchoring, so it must be built on the main thread from `Control` nodes.

### The shadow loop is wired and ready

`src/main/shadow/ModBridgeSource.ts` polls the mod (`http://localhost:17832/state`, 250 ms,
exponential backoff when absent) and pipes each key into `compareCandidate()` — **read-only and
non-authoritative**. Every field mismatch lands in `shadow/diffs.jsonl` with an exact path.

```bash
SPECTRA_DEBUG=1 SPECTRA_SHADOW=1 SPECTRA_BRIDGE=1 npm run dev
```

Work the loop: play → read `diffs.jsonl` → fix the mod's snapshot builder → repeat until
`summary.jsonl` fidelity hits 100%.

### Checklist to cut over

1. Build the snapshot builder in `spike/mod/ModEntry.cs` for the 4 keys, emitting **our exact
   JSON shapes** (`Sts2PileState` etc. in `src/shared/types.ts`) so no translation layer is needed.
2. `dotnet build -c Release` → copy `SpectraBridge.dll` + `SpectraBridge.json` to
   `<game>/mods/SpectraBridge/`; accept the in-game consent popup.
3. Run with `SPECTRA_BRIDGE=1`, drive fidelity to 100% off `diffs.jsonl`.
4. Add a `ModBridgeProvider` implementing the same `emit()` contract as `Sts2ScryProvider`;
   select it by setting, defaulting to scry.
5. Flip the default; keep scry behind a flag for one release.
6. **Delete** `src/main/scry/native.ts`'s scry paths, `vendor/`, the `asarUnpack`/`extraResources`
   native config — and drop `vendor/` back into `.gitignore`. This removes the proprietary
   binaries from the public repo.
7. Enable macOS/Linux targets in electron-builder (now possible — see cross-platform above).

### Risks to carry

- **No API stability policy** → keep the field map config-driven and make reflection return `null`
  rather than throw, so a renamed field degrades one widget instead of crashing the game.
- **Never touch the scene tree off the main thread** — build an immutable snapshot in
  `ProcessFrame`, publish by one volatile write.
- `GodotObject.IsInstanceValid` on every node — a freed node is a hard crash.
- Prefer semantic hooks over Harmony (Linux native-detour fragility).

## ✅ Verified schema parity — `spike/paritycheck`

An executable gate that diffs our hand-coded builder against **real recorded output** from the
proprietary reader (`shadow/primary.jsonl`). Runs without the game; exit 0 = parity.

```bash
cd spike/paritycheck && dotnet run
# DERIVED  sts2.layoutState: provider-enriched from _raw.visibleItems (live-verified)
# SCHEMA PARITY OK — 3 keys match the recorded reader output
```

| Key | Status |
| --- | --- |
| `sts2.nGameState` | ✅ exact — every field + type matches |
| `sts2.pileState` | ✅ exact (+ additive `exhaust`, which the old reader never read) |
| `sts2.enemiesState` | ✅ exact |
| `sts2.layoutState` | ⏳ provider-derived — mod emits `_raw.visibleItems`; needs live run |
| `sts2.cardData` / `sts2.settings` | n/a — CDN / SettingsStore, never reader-owned |

Field mapping, all verified against the real assembly:

| Ours | Game API |
| --- | --- |
| `id` | `Id.Entry` (via `EntryOf`) |
| `upgradeLevel` | `CardModel.CurrentUpgradeLevel` |
| `enchantment` | `CardModel.Enchantment.Id` |
| `isPermanent` | `CardModel.DeckVersion != null` |
| `cost` / `defaultCost` / `costsX` | `EnergyCost.GetResolved()` / `CanonicalEnergyCost`¹ / `HasEnergyCostX`¹ |
| piles | `PlayerCombatState.{DrawPile,Hand,DiscardPile,ExhaustPile}.Cards` |
| enemies / intents | `CombatState.Enemies` → move → `Intents` → `IntentType` + `GetIntentLabel()` |
| room / act / character | `RunState.CurrentRoom` / `.CurrentActIndex` / `Players[0].Character.Id` |

¹ non-public — reached via the null-safe reflection helper.

`Layout.VisibleItems()` emits the **raw** contract (`source` + items with screen-fraction
`cx/cy/w/h`), keeping Codex enrichment in Electron so the advice pipeline is untouched. It also
carries the corrected source taxonomy (`cardReward` / `chooseACard` / `grid`) rather than the
legacy reader's bug, and sorts holders by on-screen position.

### ⛔ Blocked on a one-time user consent gate

```
[INFO] Found mod manifest file …\mods\SpectraBridge\SpectraBridge.json
[INFO]   0: Spectra Bridge (SpectraBridge)
[INFO] Skipping loading mod SpectraBridge, user has not yet seen the mods warning
```

StS2 requires the player to accept an in-game "confirm mod loading" popup before it will load any
third-party DLL. Until that's accepted the mod cannot run, so **live value-level parity and the
shadow diff cannot be collected**. Everything else is done and armed:

```bash
SPECTRA_DEBUG=1 SPECTRA_SHADOW=1 SPECTRA_BRIDGE=1 npm run dev   # polls 127.0.0.1:15600
```

## Next steps

1. Install [STS2MCP](https://github.com/Gennadiyev/STS2MCP), curl `localhost:15526`, diff its
   JSON against the keys above — confirms coverage before writing any C#.
2. Scaffold `Reliquary.dll` mod (net9.0, refs `sts2.dll`/`GodotSharp.dll`/`0Harmony.dll`);
   one Harmony hook; push state over WebSocket.
3. Wire it as a `compareCandidate` source → drive fidelity to 100% off `diffs.jsonl`.
4. Flip the default source, keep scry behind a flag, then delete the native addon + `vendor/`.

Blocker for step 2: no .NET SDK on this machine (`winget install Microsoft.DotNet.SDK.9`).

## ✅ CoreCLR bootstrap SOLVED — `spike/memread/`

The hard part is done. Chain, all verified live against the running game:

```
coreclr.dll export table  →  g_dacTable  (the ONLY CoreCLR symbol the
                                          proprietary binary references)
        ↓
DacGlobals[]  — ~30 live heap roots (SystemDomain / ThreadStore / module lists)
        ↓
pointer walk  →  sts2.dll's PEAssembly/Module  (found in 108 steps, depth 1)
        ↓
MethodTables  →  FieldDescs  →  field offsets  →  object reads
```

Verified output:

```
coreclr.dll base = 0x7fff64400000
g_dacTable       = 0x7fff647dde50
DacGlobals[0]    = 0x239f0c08170   HEAP OBJECT
...
FOUND sts2.dll base stored at struct 0x239eee8e060 + 0x30  (path dac[10]+0x140)
```

Why this matters: we locate the module by **searching for its known PE base**, not by
hard-coding a DacGlobals index — so a CoreCLR layout change between .NET versions doesn't
break it. That was the single biggest risk in the whole plan.

### Files

| File | Purpose |
| --- | --- |
| `reader.mjs` | Win32 primitive — `OpenProcess`/`ReadProcessMemory`/`EnumProcessModulesEx` via **koffi** (no C++ toolchain, no node-gyp) |
| `pe.mjs` | Remote PE export-table parser (resolves `g_dacTable` by name) |
| `probe.mjs` | Attach + module enumeration + PE header validation |
| `dac.mjs` | Locates `g_dacTable`, dumps DacGlobals |
| `roots.mjs` | Classifies DacGlobals entries → heap roots |
| `findmod.mjs` | Walks roots → finds sts2's Module by its PE base |

### Remaining to parity

1. Module → MethodTable list; match `MegaCrit.Sts2.Core.Nodes.NGame` by name.
2. MethodTable → FieldDesc chain → offset per field (all 78 names already verified present).
3. Static field read → `NGame.Instance` / `NRun.Instance`, then walk instance fields.
4. `System.String` decode (length + UTF-16) for card ids; Godot `Control` pos/size for anchors.
5. Feed snapshots into the existing shadow comparer → drive diffs to zero.

### MethodTable discovery (partial)

`spike/memread/mtables.mjs` locates a type table from the module anchor by validating
candidates structurally (sane `m_BaseSize`, plausible parent/module pointers):

```
anchor struct 0x239eee8e060 (+0x30 = sts2 base)
TYPE TABLE FOUND  array 0x239eee8ea60
  MethodTable-shaped entries in first 32: 13
```

⚠️ **Heuristic is noisy** — only 1/32 entries agreed on a common loader Module, so the
candidate array is probably a mix of real MethodTables and false positives. Before building
on it, the MethodTable field offsets should be pinned from CoreCLR source for .NET 9
(`vm/methodtable.h`) rather than inferred, and validated by resolving a *known* type name
end-to-end (e.g. `NGame`) via the EEClass → name path.

### Honest status

| Layer | State |
| --- | --- |
| Win32 attach / read / module enum | ✅ working, validated against PE headers |
| `g_dacTable` → DacGlobals | ✅ working |
| DacGlobals → sts2 Module anchor | ✅ working, version-agnostic |
| Module → MethodTable array | 🟡 candidate found, heuristic unverified |
| MethodTable → EEClass → FieldDesc → offsets | ❌ not started |
| Name→offset map for the 78 fields | ❌ not started |
| Object reads / string decode / Godot nodes | ❌ not started |
| Snapshots fed to shadow comparer | ❌ not started — **zero diffs collected** |

The bootstrap (the part everyone says is hardest) is done. What remains is the CoreCLR type
system walk, which is well-documented in MIT-licensed runtime source but is genuinely
multi-day work — it is NOT a session-scale task.

### Token-based MethodTable validation — methodology proven, offsets WRONG

`spike/dumpmeta --tokens` emits TypeDef-token → type-name for all **9,410** sts2 types.
CoreCLR stores a type's TypeDef token inside its MethodTable, so this turns identification
from guesswork into an **exact match** — the right methodology.

`spike/memread/validate.mjs` applies it, and the first run looked like success:

```
TYPE TABLE VALIDATED @0x239ef2d4aa8   25/25 entries resolve to REAL sts2 type names
   tok=0x081f size=32760  MegaCrit.Sts2.Core.Models.Events.RanwidTheElder   (×25)
```

**It was a false positive.** All 25 entries shared one token and `baseSize = 0x7FF8` —
uninitialised memory that happened to satisfy loose shape checks. Tightened the validator to
require a sane base size (0x18..0x2000, 8-aligned) *and* mostly-distinct tokens:

```
no validated type table found
```

**Conclusion: the assumed MethodTable layout is wrong for .NET 9.** The guessed offsets
(`+0x04` base size, `+0x0A` token) do not hold. They must be taken from CoreCLR's
`vm/methodtable.h` for the exact runtime version (9.0.7), not from recollection.

This is a *useful* negative: the validator now rejects plausible-looking garbage, which is the
exact failure mode that would otherwise ship a reader that silently returns wrong card ids.

**Next concrete step:** pin `MethodTable` / `EEClass` / `FieldDesc` offsets from CoreCLR 9.0.7
source (or cross-check against the shipped `mscordaccore.dll`, whose DAC structures mirror
them), then re-run `validate.mjs` — it will confirm the layout the moment the offsets are right,
because token→name matching is exact.

### ROOT CAUSE of the failed validation (.NET 9 MethodTable refactor)

Fetched CoreCLR `release/9.0` source. Two facts explain the failure:

1. `SIZEOF__MethodTable_ = 0x10 + 6 * TARGET_POINTER_SIZE` — so a MethodTable is 16 bytes of
   scalars followed by **6 pointers** (0x40 total). The scalar block guess was structurally fine.
2. **The killer** — from `methodtable.inl`, verbatim:

   ```cpp
   inline PTR_Module MethodTable::GetLoaderModule()
   {
       LIMITED_METHOD_DAC_CONTRACT;
       return GetAuxiliaryData()->GetLoaderModule();
   }
   ```

   In .NET 9 the loader module is **NOT a direct field on MethodTable** — it lives in
   `MethodTableAuxiliaryData`, reached through a pointer. My validator checked
   `MethodTable+0x18` for a back-pointer to the Module, so it could never match; every
   "hit" was coincidence, which is why the surviving candidates were `RanwidTheElder ×25`.

The same refactor likely moved the TypeDef token (`m_wToken`) into auxiliary data too —
`GetTypeDefRid`/`GetCl` are not in `methodtable.h`/`.inl`, consistent with that.

**Corrected plan:** resolve `MethodTableAuxiliaryData`'s layout first, then
`MethodTable → GetAuxiliaryData() → { LoaderModule, token }`. The token→name validator in
`validate.mjs` is already correct and will confirm the layout instantly once it reads the
token from the right place — it is exact, not heuristic.

## ✅ MethodTable layout DERIVED (empirically, from the live process)

Breakthrough anchor: **every `System.String` shares one MethodTable**, and strings are
findable by their text. 324 game strings (`DEFECT1_EPOCH`, …) all pointed to
`0x7fff0497bf40` — a 100%-certain MethodTable, no heuristics.

Decoding it, then cross-checking against ~1,500 harvested MethodTables:

| Offset | Field | How it was confirmed |
| --- | --- | --- |
| `+0x04` | `m_BaseSize` | System.String's base size is exactly **22** — matches |
| `+0x0C` / `+0x0E` | `m_wNumVirtuals` / `m_wNumInterfaces` | String = 27 virtuals, **9 interfaces** ✓ |
| `+0x10` | `m_pParentMethodTable` | always a plausible MT pointer |
| **`+0x18`** | **`m_pModule`** | **1280/1500 MTs share one address**; `+0x18→+0x0` is identical for 1500/1500 (the Module vtable) |
| **`+0x20`** | **`m_pAuxiliaryData`** | `+0x20→+0x8` yields the **same Module** — matches .NET 9's `GetAuxiliaryData()->GetLoaderModule()` |
| `+0x28` | `m_pEEClass` / `m_pCanonMT` | union, per source |

Modules found by grouping MTs on `+0x18`: `0x7fff04b329c8` (1762 types),
`0x7fff04864000` (676), `0x7fff0503bb90` (204), `0x7fff04c85938` (133).

### TypeDef token: still unlocated

Multiple attempts all returned **chance-level noise or false positives**:
- `+0x0A` (the .NET 8 location) scores *below* chance
- A `100% hit rate at +0x04` looked like success but is just `m_BaseSize` — small integers
  always resolve against a 9,410-entry token map. **uniq=39 across 1,762 types** exposed it.

The token map is too dense to be a discriminator on its own. Confirmed it is **not** in the
MethodTable's first 0x10 bytes in .NET 9.

## Disassembly path (recommended next, per user direction)

Hand-deriving offsets keeps yielding plausible garbage. Reading the proprietary binary's own
constants is more reliable. Tooling is now installed (`pip install capstone pefile`) and
`spike/memread/disasm*.py` demonstrate:

- Locating strings and their code xrefs, e.g.
  `'Failed to bootstrap .NET Core metadata' @0x1800b2f50`, xref `lea r8,[rip+0xa7e88]` @ `0x18000b0c1`
- Extracting struct-field offsets while excluding rsp/rbp stack slots

**Next step:** the binary retains full RTTI (`DotNetCoreScry`, `DotNetCoreObject`,
`DotNetCoreModule`, `GodotNode`, …). Walk RTTI → vtables → the member functions of
`DotNetCoreModule`/`DotNetCoreObject`, and read the CoreCLR offsets straight out of *their*
code instead of inferring them. That converts guesswork into transcription.

## ✅ RTTI → vtable → disassembly WORKS (transcription, not guessing)

Per the "decompile instead of deriving" direction. Tooling: `pip install capstone pefile`;
scripts `spike/memread/rtti.py`, `deep.py`.

MSVC RTTI is intact, so `TypeDescriptor → CompleteObjectLocator → vtable` resolves cleanly:

| Class | TypeDescriptor | vtable |
| --- | --- | --- |
| `DotNetCoreModuleImpl` | `0x1800d1a28` | `0x1800b4788` (16 virtuals recovered) |
| `ScryWin64` | `0x1800d1fc0` | `0x1800b4bf8` (16 virtuals recovered) |

Note: only the **`*Impl`** classes carry real logic — the abstract bases are thunks
(`DotNetCoreModule`'s vtable is 15× the same stub).

### Decoded object layout + call convention

From `DotNetCoreModuleImpl::vt[9]` (`0x1800586f0`), the richest method:

```asm
mov rdi, [r14 + 0x30]      ; +0x30 = Scry (memory-reader) interface
mov rbx, [rdi]             ; its vtable
call [rbx + 0x78]          ; predicate — likely is64Bit()
mov edx, 4
add rdx, [r14 + 0x100]     ; +0x100 = TARGET-process base address
call [rbx + 0x40]          ; read at base+0x04
mov rdx, [r14 + 0x100]
add rdx, 0xa
call [rbx + 0x60]          ; read at base+0x0a
mov r10, [rdx + 0x10] ; call r10   ; bulk read(dst, size, src)
```

**Recovered so far**

| Symbol | Meaning |
| --- | --- |
| `DotNetCoreModuleImpl+0x30` | pointer to the Scry memory-reader interface |
| `DotNetCoreModuleImpl+0x100` | a base address in the target process |
| `DotNetCoreModuleImpl+0xa8` | cache/lookup structure (`+0x8/+0x10/+0x19/+0x20` walked) |
| `Scry::vt+0x10` | bulk read (dst, size, src) |
| `Scry::vt+0x40` | read (4-byte) |
| `Scry::vt+0x60` | read (different width) |
| `Scry::vt+0x78` | predicate (is64Bit) |

The `base+0x04` / `base+0x0a` reads line up with `m_BaseSize` / `m_wToken` — the same offsets
my empirical pass confirmed for base size. This is exactly the transcription the direction
called for: **read their constants instead of inferring ours.**

**Next:** enumerate the remaining `*Impl` vtables (`Il2CppMetadataContextImpl`, `MonoImageImpl`,
`WinNativeInterfaceDefaultImpl`), and walk `vt[9]`/`vt[13]` fully to recover the complete
MethodTable→FieldDesc traversal. Then the 78 field names become offsets and the reader can
emit snapshots into the shadow comparer.

### Negative result that reshapes the plan

Searched the entire `.text` for CoreCLR's characteristic bitfield masks
(`0x7FFFFFF`, `0x3FFFFFF`, `0xFFFFFF`, static-bit tests) — used to unpack
`FieldDesc::m_dwOffset` and RIDs:

```
=== CoreCLR-characteristic bitfield constants in code ===
   (none)
```

**They do not hand-unpack FieldDescs.** The constant histogram over the
`DotNetCoreModuleImpl` cluster is dominated by `0x28`, `0x0f`, `0x1f` — MSVC `std::string`
SSO constants — i.e. much of that region is string handling, consistent with resolving
**names**, not bit-twiddling offsets.

Combined with the only CLR symbol being `g_dacTable`, the likely design is: use the DAC
table for runtime roots, and parse **.NET metadata out of the target's mapped image** to map
names → tokens (which fits the `base+0x04` / `base+0x0a` reads landing on metadata-header
fields), rather than reimplementing CoreCLR's internal bitfields.

Recovered Scry interface slots (called via `[rbx+N]`): `+0x40` (8×), `+0x78` (12×),
`+0x70`, `+0x10`. Hot object offsets in the cluster: `+0x0`, `+0x8`, `+0x19`, `+0x20`,
`+0x10`, `+0x30`, `+0x40`, `+0x78`, `+0x48`.

**Implication:** the remaining work is to determine whether they walk the metadata `#~`
stream from target memory. If so, our reader can do the same — and we already have a working
metadata parser (`spike/dumpmeta`) plus `spike/memread` to read target memory, so the two
halves exist and just need joining.
