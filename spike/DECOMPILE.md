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
