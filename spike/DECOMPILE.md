# Decompiling `untapped-scry.node` — decoded architecture

Tooling: `pip install capstone pefile`; scripts in `spike/memread/*.py`.
Target: `vendor/untapped-scry/lib/binding/napi-v5/untapped-scry.node` (PE32+ x64, MSVC,
static CRT, full RTTI retained, PDB path `D:\a\untapped-scry\...` = CI build).

## Imports — confirms the architecture

```
KERNEL32: OpenProcess, ReadProcessMemory, VirtualQueryEx, K32EnumProcessModulesEx,
          K32GetModuleInformation, K32GetModuleFileNameExW, K32GetMappedFileNameW,
          GetProcAddress, GetModuleHandleA/W, LoadLibraryExA, VirtualQuery
VERSION:  GetFileVersionInfoW, VerQueryValueW      ← game version detection
DELAY (node.exe): 55 × napi_*                      ← why a naive import scan finds none
EXPORTS:  napi_register_module_v1, node_api_module_get_api_version_v1
```

`LoadLibraryExA` + `GetProcAddress` alongside remote-read APIs implies they **map the target's
DLL locally as data** to resolve export RVAs (e.g. `g_dacTable`), then apply the RVA to the
remote module base. Cheaper and more robust than parsing the export table remotely.

## JS API surface (from `napi_set_named_property` / `napi_create_function` sites)

```
classes : DotNetCoreScry  DotNetCoreModule  DotNetCoreClass  DotNetCoreObject
          DotNetCoreStruct  DotNetCoreArray  GodotScry  Il2CppScry  MonoScry
          Il2CppUnityScene  Il2CppUnityComponent
methods : get  getValue  at  getClass  getClassName  getFieldNames  getBaseAddress
          getModule  getScry  getMetadataContext  getMonoImage  getGodotEngine
          getRootGameObjects  getScriptingObject  hasClasses
errors  : "No such property"  "No such class"  "Scry must not be NULL"
          "Failed to bootstrap .NET Core metadata"
```

`getFieldNames` proves it enumerates fields **by name** at runtime — no hardcoded offsets.

## Property accessor — `DotNetCoreObject::get(name)` @ `0x180006280`

```asm
mov rcx, [rbx + 0x30]      ; +0x30 = class handle
call 0x180036930           ; findField(class, name) -> FieldDesc wrapper
cmp  qword [rsp+0x40], 0
je   -> "No such property"
movzx ebx, byte [rbx+0x28] ; enumerateProperties flag
call 0x180032730           ; readField(field, obj) -> value
```

## ⭐ FieldDesc decode — `readField` @ `0x180032730`

```asm
mov  rdi, [rcx + 0x58]     ; +0x58 = Scry (memory reader)
mov  rbx, [rax + 0x60]     ; Scry vtable +0x60 = read32
mov  rdx, [r14]            ; FieldDesc address in the TARGET
add  rdx, 8                ; FieldDesc + 0x08
call rbx                   ; read32(FieldDesc+0x08)
shr  ecx, 0x18             ; >> 24
and  cl, 1                 ; & 1        →  m_isStatic
mov  [r14+0xb2], cl        ; cached
```

This is CoreCLR's `FieldDesc` bitfield at `+0x08`
(`m_mb:24, m_isStatic:1, m_isThreadLocal:1, m_isRVA:1, m_prot:3, …`).

> **Why an earlier mask search found nothing:** they extract single bits with
> `shr`+`and 1`, never a wide `AND 0x7FFFFFF` mask. Searching for the classic masks
> produced a false negative that briefly derailed the plan.

## ⭐ Runtime-version branch (the .NET 9 refactor, handled explicitly)

```asm
cmp  word ptr [rax], 9      ; CoreCLR major version
jb   older
call [rax + 0x78]           ; is64Bit
lea  rdx, [rbx + 8]         ; +0x08
call read32 ; shr 1 ; and 1 ; .NET 9+ path
older:
call [rax + 0x78]
call read32 ; test al, 6    ; pre-.NET 9 path
```

They keep **per-version offsets** — independent confirmation that the layout changed in
.NET 9 (matching `GetAuxiliaryData()->GetLoaderModule()` in `release/9.0` source).

## Recovered interface / object layout

| Symbol | Meaning |
| --- | --- |
| `Scry::vt + 0x40` | read pointer (64-bit) |
| `Scry::vt + 0x60` | read32 |
| `Scry::vt + 0x70` | (called on class object) |
| `Scry::vt + 0x78` | predicate — is64Bit / version |
| `Scry::vt + 0x10` | bulk read (dst, size, src) |
| `<obj> + 0x00` | target address of the managed object |
| `<obj> + 0x30` | class handle |
| `<obj> + 0x38` | sub-object (type/class) |
| `<obj> + 0x48` | context |
| `<obj> + 0x58` | Scry pointer |
| `<obj> + 0xb2/0xb3/0xf4` | cached flags |
| `DotNetCoreModuleImpl + 0x30` | Scry pointer |
| `DotNetCoreModuleImpl + 0x100` | target base address |
| `DotNetCoreModuleImpl + 0xa8` | lookup cache |

## Key functions

| Address | Role |
| --- | --- |
| `0x1800032e0` | `napi_register_module_v1` (SEH wrapper → `0x180003320`) |
| `0x180006280` | `DotNetCoreObject::get(name)` |
| `0x180036930` | `findField(class, name)` |
| `0x180032730` | `readField(field, obj)` — FieldDesc decode |
| `0x1800586f0` | `DotNetCoreModuleImpl::vt[9]` — metadata walk |
| `0x1800b4788` | `DotNetCoreModuleImpl` vtable |
| `0x1800b4bf8` | `ScryWin64` vtable |

## Next

Trace `findField` (`0x180036930` → `0x1800369f0`, `0x180037c90`) to recover the
name → FieldDesc lookup: whether it walks `EEClass`'s FieldDescList or a metadata-built map.
Then `FieldDesc+0x0C & 0x7FFFFFF` should yield the instance offset, completing the chain.

---

# Research findings (external)

## 🔑 `untapped-scry`'s lineage is PUBLIC — and there's an MIT rewrite

Nothing exists publicly under the name `untapped-scry` (npm: no package; GitHub: 0 repos; the
`D:\a\...` PDB path just confirms a GitHub-Actions build). **But its ancestry is documented:**

```
HearthMirror (HearthSim, OPEN SOURCE C#)   ← MonoClass, MonoClassField, MonoImage,
   → C++ port (ifeherva, 2017)                MonoObject, MonoStruct — an EXACT match
   → closed-sourced, rebranded "Scry"         for untapped-scry's RTTI names
   → ScryDotNet (.NET binding)
   → untapped-scry (our N-API binding)
```

- HearthMirror mirror: <https://github.com/Bright1992/HearthMirror> (`Mono/MonoClass.cs`,
  `MonoClassField.cs`, `MonoImage.cs`, `MonoObject.cs`, `MonoStruct.cs`, `Mirror.cs`,
  `Cache.cs`, `Offsets.cs`, `ProcessView.cs`) — original repo now 404s
- C++ port announced: <https://hearthsim.info/blog/2017/2017-update/>
- **MIT rewrite of the closed-source version: <https://github.com/hackf5/unityspy>**
- "Scry integration" PR: <https://github.com/HearthSim/Hearthstone-Deck-Tracker/pull/4486>
  → Scry runs **out-of-process** and talks IPC/RPC to the host app
- `ScryDotNet.ScryInitializationException` leaks in
  <https://github.com/HearthSim/Hearthstone-Deck-Tracker/issues/4628>

`Scry*/ScryCached/WinNativeInterface` mirror HearthMirror's `Mirror`/`Cache`/`ProcessView`.
The `*FingerprintHeuristic` classes are bespoke (no public project uses that terminology) —
structural fingerprinting instead of AOB signatures, which is why it survives engine churn.
**Not** derived from Il2CppDumper / Il2CppInspector / MelonLoader / frida-il2cpp-bridge.

HearthSim's own description (<https://help.hearthsim.net/en/articles/8377705>): *"standard
Windows and macOS APIs to access the game's memory in read-only mode"*, *"does not inject or
'hook' any code"* — same architecture as ours.

## 🔑 LiveSplit `asr` — the only real external Godot 4 reader (Apache-2.0)

<https://github.com/LiveSplit/asr> → `src/game_engine/godot/`. **Includes a Node → C# object
chain.** Verified offsets (Godot **4.2**, x64):

| Struct | Field | Offset |
| --- | --- | --- |
| `Object` | `_instance_id` / `script_instance` / class-name ptr | `0x58` / `0x68` / `0xE8` |
| `Node` | parent / owner / children(HashMap) / index / name / tree | `0x128` / `0x130` / `0x138` / `0x1C4` / `0x1D0` / `0x1D8` |
| `CanvasItem` | `global_transform` | `0x450` |
| `SceneTree` | `root` (Window*) | `0x2B0` |
| `CSharpScriptInstance` | `script` / `gchandle` | `0x18` / `0x20` |
| `CSharpGCHandle` | → raw managed instance data | `[gchandle+0x00]` |

⚠️ `asr` does **not** implement `Control`, is 4.2-only, and anchors on a hardcoded
`main_module + 0x0424BE40`.

### Godot 4.5 deltas that break the 4.2 numbers

- `CowData::USize` became **uint64** with `DATA_OFFSET` 16 ⇒ **size at `ptr-8` (u64)**,
  not `ptr-4` (u32) as `asr` hardcodes.
- `StringName::_Data` **dropped `cname`** ⇒ 4.5 is `refcount`(0x00), `static_count`(0x04),
  **`String name` ptr (0x08)**, `hash`(0x10). `asr`'s `CNAME 0x08 / NAME 0x10` is wrong for 4.5.
- `Control` position/size = `data.pos_cache` / `data.size_cache` (`Vector2` each).
- `Node::children` is a **HashMap** in Godot 4 (`children_cache` is a flat array but is
  lazily rebuilt — check `children_cache_dirty`).
- `CanvasItem::global_transform` is lazily computed — check `global_invalid`.

### Better anchor than `SceneTree::singleton`: **`ObjectDB::object_slots`**

`core/object/object.h` — `static ObjectSlot *object_slots; static uint32_t slot_count, slot_max;`
16 bytes/slot, `Object*` at slot+0x8. Walking it enumerates **every live Object** with no tree
traversal. The research notes this appears **unused by the public tooling community**.

## ✅ Toolchain check (run locally): RTTI is STRIPPED from MegaDot

```
MSVC   '.?AV' count : 0
Itanium '_ZTV' count: 0     (in SlayTheSpire2.exe)
```

So **neither** RTTI walk is available on the Godot side — `asr`'s `vtable[-8] → type_info`
trick will NOT work here. Class identity must come from **`Object::_class_name_ptr`**.
(RTTI *is* intact in `untapped-scry.node` itself, which is how we decoded it.)

## MegaDot specifics

- Godot **4.5.1**, C#/.NET 9. Fork source unpublished, **but the NuGet packages are public**:
  `MegaDot.NET.Sdk`, `MegaDot.SourceGenerators`, `MegaDotSharpEditor` — all `4.5.1.5`
  (<https://www.nuget.org/profiles/danielle_megacrit>), verbatim rebrands of the Godot ones.
- The `.5` past upstream + "tweaks for their pipeline" ⇒ **assume offsets need calibration,
  not parity**.

## Strategic implication

`untapped-scry`'s RTTI contains `GodotScry/GodotNode/GodotControl/GodotCanvasItem/GodotLabel/
GodotRichTextLabel` **and** `DotNetCore*`. Combined with our disassembly (the `get(name)` path
goes through `findField` → FieldDesc), the design is:

> **Godot side** → locate nodes / on-screen positions (for tip anchors)
> **CoreCLR side** → read the managed game state by FIELD NAME

C# field *names* are stable across game patches; native Godot offsets are not. So the CoreCLR
half is the durable one and should be built first — which matches where our own spike already is.

### Ranked next steps
1. Read **`unityspy`** (MIT) — a working, readable implementation of the same Mono/CLR
   external-read design this binary descends from.
2. Port `asr`'s Godot module for node/position reads, fixing the 4.5 `CowData`/`StringName`
   deltas and swapping the hardcoded anchor for an `ObjectDB::object_slots` scan.
3. Finish `findField` (`0x180036930`) → `FieldDesc+0x0C & 0x7FFFFFF` for instance offsets.

---

# 🚨 GAME-CHANGER: the shipped game binary contains FULL DEBUG INFO

## ❌ Correction to an earlier claim in this document

I previously wrote *"RTTI is STRIPPED from MegaDot"* based on `grep '.?AV'` (MSVC) and
`grep '_ZTV'` (vtable symbols) both returning 0. **That was a bad test.** Itanium
`type_info::__type_name` strings are **length-prefixed bare names**, not `_ZTV`-prefixed.
Re-tested locally:

```
6Object 18   4Node 73   10CanvasItem 5   7Control 22   9SceneTree 4   8Viewport 11
```

**RTTI is fully retained.** `-s` strips the symbol table but not RTTI, because vtables
reference `type_info` at runtime. Under Itanium ABI the `type_info*` sits at `vtable_ptr - 0x08`.

## ✅ 766 MB of DWARF v4 debug info is shipped in `SlayTheSpire2.exe`

Verified locally (`NumberOfSymbols=0`, but the `/N` long-name sections are DWARF):

```
  /4    4.9 MB   .debug_abbrev
  /45 287.1 MB   .debug_info    (DWARF v4, addr_size=8, 15,756 compile units)
  /57  36.2 MB   .debug_line
  /69 153.8 MB   .debug_loc
  /80  42.3 MB   .debug_ranges
  /94 241.5 MB   .debug_str     ("clang version 19.1.6 …")
  TOTAL 766 MB
```

Build: clang 19.1.6 / llvm-mingw / LLD, cross-compiled from Linux CI, **Itanium ABI**,
`template_release`, `.mono`, single precision, no `DEBUG_ENABLED`/`TOOLS_ENABLED`.
Version string in `.rdata`: **`MegaDot v4.5.1.m.12.mono.custom`**.

**And MegaCrit publishes matching PDBs openly** at <https://megadot.megacrit.com/> with a JSON
directory API (`/api/4.5.1-m.12/symbols/` → `…template_release.x86_64.llvm.mono.pdb.zip`, 107 MB).

**⇒ We never have to guess a Godot offset. They are in the binary.**

## Offsets extracted from the shipped binary's DWARF (x86-64, MegaDot 4.5.1-m.12)

`Object` (sizeof 0x110) — no base class, single vtable ptr at 0, no virtual/multiple inheritance:

| Off | Field |
| --- | --- |
| `0x000` | vtable ptr |
| `0x058` | `ObjectID _instance_id` |
| `0x068` | `ScriptInstance* script_instance` ← C# bridge |
| `0x070` | `Variant script` (24B) |
| **`0x0D8`** | **`const StringName* _class_name_ptr`** ← class identity |
| `0x0F0` | `InstanceBinding* _instance_bindings` |

`Node` (sizeof 0x2F0), `Node::Data` at `0x110`:

| Off | Field |
| --- | --- |
| `0x128` | `Node* parent` |
| `0x138` | `HashMap<StringName,Node*> children` (40B) |
| `0x160` | `bool children_cache_dirty` |
| `0x168` | `LocalVector<Node*> children_cache` → count@`0x168`, **data ptr@`0x170`** |
| `0x1B4` | `int index` |
| **`0x1C0`** | **`StringName name`** |
| `0x1C8` | `SceneTree* tree` |
| `0x1D8` | `Viewport* viewport` |

`CanvasItem` (sizeof 0x410): `visible` `0x370` · `global_transform` **`0x3E8`** · `global_invalid` `0x400`
`Control` (sizeof 0x7F0): **`pos_cache` `0x4B8`** · **`size_cache` `0x4C0`** · `anchor[4]` `0x480`
`SceneTree` (sizeof 0x768): **`Window* root` `0x2C0`**
`StringName::_Data` (sizeof 0x28): refcount `0x00` · **`String name` `0x08`** · hash `0x10`
`ObjectSlot`: **16 bytes**, `validator:39/next_free:24/is_ref_counted:1` in word 0, **`Object*` at `+0x08`**

**Independent corroboration:** GDDumper's `GDHardOffsets.lua` lists Godot 4.5 x64 release
`VPChildren = 0x170`, `VPObjStringName = 0x1C0` — an exact match with the DWARF extraction,
from two unrelated methods.

**MegaDot does NOT change these layouts.** Every member matches stock Godot 4.5-stable
declaration order; the only deltas are expected `#ifdef` eliminations.

## Best bootstrap: `ObjectDB::object_slots` (not SceneTree)

```cpp
for (uint32_t i = 0, count = slot_count; i < slot_max && count; i++)
    if (object_slots[i].validator) { visit(object_slots[i].object); count--; }
```

One bulk `ReadProcessMemory` of `slot_max * 16` bytes enumerates **every live Object** — no tree
walk. The `ObjectSlot` layout is **unchanged across all of Godot 4.x**, unlike `Node` whose
offsets moved on every one of 4.3 → 4.4 → 4.5.

## Class identity in 4 reads, no vtable

```
Object* + 0xD8 -> StringName*  ->  _Data* + 0x08 -> char32_t*
                                   length at (ptr - 8), uint64, includes NUL
```
Exact (`"Button"`, not `"Control"`). Use RTTI (`vptr-8` → `type_info` → `+8` → `4Node`) as an
independent validator so offsets can be self-checked on a new build rather than trusted blindly.

## Godot 4.5 deltas that invalidate older public tables

- `CowData::USize` → **uint64** (4.3+): size at `ptr-8`, not `ptr-4`
- `StringName::_Data` **dropped `cname`**: `name` at `+0x08` in 4.5, `+0x10` in 4.3/4.4
- `Object` gained `signal_mutex` + `_translation_domain` in 4.5 (shifts everything after)
- `Node::Data` gained `accessibility_element` in 4.5; `inside_tree` bit removed
  (4.5's `is_inside_tree()` = `data.tree != null`)

## Revised plan

1. **Extend the DWARF parser into an offset generator** — re-run it after each game update
   instead of maintaining a hardcoded table. (MegaCrit ships a fork revision every few weeks.)
2. Bootstrap on `ObjectDB::object_slots`; version-gate on the `.rdata` version string.
3. Identify classes via `_class_name_ptr`, validate via Itanium RTTI.
4. For managed state: `Object.script_instance (0x68)` → `CSharpInstance` → `gchandle` →
   raw managed object, then the CoreCLR field-name path we decoded from `untapped-scry`.

---

# 🎉 BLOCKER SOLVED — name → MethodTable works

## The token bug: .NET 9 merged two fields

`.NET 8` had `WORD m_wFlags2` + `WORD m_wToken`. **.NET 9 merged them into one DWORD**, with
the rid in bits 8-31 (`methodtable.h:2825`):

```cpp
unsigned GetTypeDefRid() { return m_dwFlags2 >> 8; }   // m_dwFlags2 is at +0x08
mdTypeDef GetCl()        { return TokenFromRid(GetTypeDefRid(), mdtTypeDef); }
```

```
rid   = ReadU32(mt + 0x08) >> 8
token = 0x02000000 | rid
```

Reading a WORD at `+0x0A` (the .NET 8 location) returns `rid >> 8` — garbage. **That single
mistake caused every false positive in this spike.**

### Verified live — `spike/memread/cdac.mjs`

```
1554/1743 MethodTables resolved to REAL sts2 type names (1059 distinct)
   MegaCrit.Sts2.Core.Nodes.Cards.Holders.NGridCardHolder
   MegaCrit.Sts2.Core.Nodes.Cards.Holders.NHandCardHolder
   MegaCrit.Sts2.Core.Nodes.Cards.NCard  …
```

1,059 **distinct** names (vs. the old `RanwidTheElder ×25` false positive), including the exact
types the reader needs. The remaining ~11% are CoreLib/GodotSharp types, correctly absent from
the sts2 token map.

## 🔑 cDAC contract descriptor — no hardcoding needed

`coreclr.dll` **exports `DotNetRuntimeContractDescriptor`**, publishing authoritative offsets
for the exact running build. Verified live at `0x7fff64861d30`:

```
magic "DNCCDAC\0" OK · flags 0x1 (64-bit) · descriptor_size 3201 · 14 pointer_data entries
"MethodTable":{"MTFlags":0,"BaseSize":4,"MTFlags2":8,"EEClassOrCanonMT":40,
               "Module":24,"ParentMethodTable":16,"NumInterfaces":14,
               "NumVirtuals":12,"PerInstInfo":48}
```

**Parse this instead of hardcoding** — it survives game/runtime updates. Struct:
`uint64 magic; uint32 flags; uint32 descriptor_size; const char* descriptor;
uint32 pointer_data_count; uint32 pad; uintptr_t* pointer_data;` (descriptor → UTF-8 JSON).

## Complete chain (all offsets now known)

```
metadata #~/#Strings  →  name → TypeDef rid
Module + 0x150        →  m_TypeDefToMethodTableMap  (LookupMapBase, size 0x20:
                            pNext@0, pTable@8, dwCount@0x10, supportedFlags@0x18)
                         GetElementPtr: walk pNext chain subtracting dwCount
                         ⚠ TYPE_DEF_MAP_ALL_FLAGS = NO_MAP_FLAGS → NO low-bit tagging here
MethodTable + 0x28    →  EEClass (bit0: 0=EEClass, 1=canonical MT → read ITS +0x28)
EEClass + 0x18        →  m_pFieldDescList       (m_pGuidInfo is declared FIRST at 0x00)
FieldDesc (0x10 each) →  +0x00 m_pMTOfEnclosingClass
                         +0x08 dword1: m_mb:24, m_isStatic:1, …
                         +0x0C dword2: m_dwOffset:27, m_type:5
                         offset  = dword2 & 0x07FFFFFF
                         isStatic= (dword1 >> 24) & 1      ← matches the disassembly exactly
field address         =  objAddr + 8 + offset      (ObjectHeaderSize = 0x8)
```

Field count = `m_NumInstanceFields - parent->m_NumInstanceFields + m_NumStaticFields`
(EEClass `+0x42` / `+0x46`). Skip `m_dwOffset >= (1<<27)-7` (unplaced/EnC/RVA sentinels).

`Module` (verified against the descriptor): `m_pPEAssembly` `0xB8` · `m_baseAddress` `0xC0` ·
`m_pAssembly` `0xD8` · `m_TypeDefToMethodTableMap` **`0x150`** · `m_FieldDefToDescMap` `0x1B0`.

`MethodTableAuxiliaryData` (size 0x18): flags `0x00` · **`m_pLoaderModule` `0x08`** ·
`m_hExposedClassObject` `0x10` — confirms our empirical `aux+0x08` finding.

## Prior art: essentially none (we'd be building something novel)

No maintained OSS project reads live CoreCLR objects externally without the DAC.
Cheat Engine's `DotNetDataCollector` uses ICorDebug; `DotNetDataCollectorEx` uses ClrMD (DAC).
The cDAC descriptor is what makes a DAC-free reader maintainable — it's new in .NET 8/9.

## Status

| Layer | State |
| --- | --- |
| Win32 attach / read / regions | ✅ koffi, no C++ toolchain |
| `g_dacTable` → DacGlobals → Module | ✅ |
| **cDAC descriptor → authoritative offsets** | ✅ **live-verified** |
| **name → TypeDef rid → MethodTable** | ✅ **1059 distinct types resolved** |
| MethodTable → EEClass → FieldDesc → offset | 📋 fully specified above, not yet coded |
| Godot node/position reads | 📋 offsets extracted from shipped DWARF |
| Snapshots → shadow diffs | ⬜ next |

## Prior-art survey (final) — and a caveat on the cDAC

Only **two** OSS projects read live CoreCLR externally without the DAC:

| Project | Approach | .NET |
| --- | --- | --- |
| **[tosu](https://github.com/tosuapp/tosu)** (osu!lazer) | hardcoded BCL layouts + **per-game-version offset JSON** (generator is private) + AoB scan + MethodTable flags/BaseSize fingerprinting | 8 |
| **[chrisnas/RuntimeDataContract](https://github.com/chrisnas/RuntimeDataContract)** | parses the cDAC descriptor — the only OSS consumer outside dotnet/runtime | 9/10/11 |

Everything else routes through the DAC: Cheat Engine's `DotNetDataCollector` (ICorDebug —
and **broken on .NET 7/8/9**: `dbgshim` left the shared runtime in .NET 7, and
`ICorDebugHeapEnum` was broken by GC Regions), `DotNetDataCollectorEx` (ClrMD),
ReClass.NET's plugin (vendored ClrMD 0.8, dead since 2021), dnSpy (ICorDebug).
**No Rust crate, no CoreCLR equivalent of Il2CppDumper, no offline field-layout computer.**

### ⚠️ The cDAC does NOT publish FieldDesc until .NET 11

| Runtime | descriptor | EEClass fields published |
| --- | --- | --- |
| 8.0 | **absent** | — |
| **9.0** (ours) | 3,201 B | `MethodTable, NumMethods, CorTypeAttr, InternalCorElementType, NumNonVirtualSlots` — **no FieldDescList** |
| 10.0 | 10,826 B | adds `FieldDescList/NumInstanceFields/NumStaticFields`, but still no `sizeof(FieldDesc)` |
| 11 (main) | — | first to emit `CDAC_TYPE_BEGIN(FieldDesc)` |

**So the split is:**
- **From the cDAC (self-updating):** `MethodTable` (MTFlags/BaseSize/MTFlags2/Module/
  EEClassOrCanonMT/ParentMethodTable/NumVirtuals…), `Object.m_pMethTab`, `String`, `Array`,
  and globals `ObjectToMethodTableUnmask=0x7`, `ObjectHeaderSize=0x8`.
- **Hardcoded from v9.0.7 source (version-gated):** `EEClass+0x18 = m_pFieldDescList`,
  `EEClass+0x42/0x46` field counts, `FieldDesc` = 0x10 bytes with
  `offset = u32[fd+0x0C] & 0x07FFFFFF`, `isStatic = (u32[fd+0x08] >> 24) & 1`,
  `Module+0x150 = m_TypeDefToMethodTableMap`.

Note `ObjectToMethodTableUnmask = 0x7` — mask the low 3 bits off `obj[0]`, not just bit 0.

**We would be building something genuinely novel**: a DAC-free, cDAC-driven external CoreCLR
reader. tosu proves the category works; the cDAC is what makes it maintainable instead of
requiring a private per-build offset generator.

## Final prior-art note + reference implementation to port

A second independent survey confirms the category is nearly empty, and surfaces the best
**struct-definition reference**:

- **[Decimation/Novus](https://github.com/Decimation/Novus)** (C#) — full hardcoded CoreCLR
  type-system structs for **.NET 8+**: `MethodTable.cs` (incl. the EEClass/canonical-MT tagged
  union with `UNION_MASK = 1`), **`EEClass.cs` with `FieldDesc* FieldDescList`,
  `NumInstanceFields`, `NumStaticFields`**, and **`FieldDesc.cs`** with the packed DWORDs
  (`unsigned m_dwOffset : 27; unsigned m_type : 5`, `Offset => ReadBits(UInt2, 0, 27)`).
  ⚠️ It is **in-process** (raw pointers + coreclr imports), so it can't be used directly —
  but it is the cleanest reference for the exact layouts we need to port onto
  `ReadProcessMemory`.
- **[opentelemetry-ebpf-profiler](https://github.com/open-telemetry/opentelemetry-ebpf-profiler)**
  `interpreter/dotnet/data.go` — production **version-keyed offset tables for .NET 6–10**,
  reading `g_dacTable` as a plain exported array (never loading mscordaccore), with a cDAC
  override on 10+. The precedent for how to structure version gating.

⚠️ **Conflicting claim, resolved by our own test:** that survey states the cDAC descriptor is
"a near-empty stub before .NET 10". **Our live read disproves that for this build** —
`descriptor_size = 3201` with a full `MethodTable` contract. Trust the live probe
(`spike/memread/cdac.mjs`), not the secondary claim.

Net: **nothing exists to fork** for external object-field reads on .NET 8/9. The build is
Novus's struct definitions + OTel's version-gating pattern + our cDAC probe, on top of the
koffi reader.
