import pefile, capstone
from collections import defaultdict
PATH = r"C:\Users\Brandon\spectra-overlay\vendor\untapped-scry\lib\binding\napi-v5\untapped-scry.node"
pe = pefile.PE(PATH); base = pe.OPTIONAL_HEADER.ImageBase
text = next(s for s in pe.sections if b'.text' in s.Name)
code = text.get_data(); code_va = base + text.VirtualAddress
md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64); md.detail=True
X=capstone.x86

# Map IAT: import thunk address -> napi function name
iat = {}
for entry in pe.DIRECTORY_ENTRY_IMPORT:
    dll = entry.dll.decode()
    for imp in entry.imports:
        if imp.name: iat[imp.address] = f"{dll}:{imp.name.decode()}"
print(f"imports: {len(iat)}")
napi_names = sorted({v.split(':')[1] for v in iat.values() if 'napi' in v.lower()})
print(f"napi imports ({len(napi_names)}): {', '.join(napi_names[:14])}")

# Find call sites for the interesting napi funcs
WANT = {'napi_get_value_string_utf8','napi_get_value_string_latin1','napi_create_string_utf8',
        'napi_get_property','napi_create_object','napi_get_cb_info','napi_create_bigint_uint64',
        'napi_get_value_bigint_uint64','napi_create_uint32','napi_create_int32'}
sites = defaultdict(list)
for insn in md.disasm(code, code_va):
    if insn.mnemonic == 'call':
        for op in insn.operands:
            if op.type==X.X86_OP_MEM and op.mem.base==X.X86_REG_RIP:
                tgt = insn.address + insn.size + op.mem.disp
                nm = iat.get(tgt)
                if nm:
                    f = nm.split(':')[1]
                    if f in WANT: sites[f].append(insn.address)
print("\n=== N-API call sites ===")
for k,v in sorted(sites.items(), key=lambda x:-len(x[1])):
    print(f"  {k:<34} {len(v)} sites  e.g. {' '.join('0x%x'%a for a in v[:5])}")
