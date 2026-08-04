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
