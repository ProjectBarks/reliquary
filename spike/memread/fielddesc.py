import pefile, capstone
from collections import Counter, defaultdict
PATH = r"C:\Users\Brandon\spectra-overlay\vendor\untapped-scry\lib\binding\napi-v5\untapped-scry.node"
pe = pefile.PE(PATH, fast_load=True); pe.parse_data_directories()
base = pe.OPTIONAL_HEADER.ImageBase
text = next(s for s in pe.sections if b'.text' in s.Name)
code = text.get_data(); code_va = base + text.VirtualAddress
md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64); md.detail=True
X = capstone.x86

# CoreCLR bitfield masks: FieldDesc packs {mb:24, isStatic:1, ...} and m_dwOffset is
# masked with 0x7FFFFFF / 0x3FFFFFF; MethodTable flags use 0x0FFFFFFF etc.
INTERESTING = {0x7ffffff:'FieldDesc offset mask (27b)', 0x3ffffff:'FieldDesc mask (26b)',
               0xffffff:'RID mask (24b)', 0x7fff:'15b', 0x1fffffff:'29b',
               0x2000000:'static bit', 0x4000000:'bit26', 0x8000000:'bit27'}
found = defaultdict(list)
for insn in md.disasm(code, code_va):
    if insn.mnemonic in ('and','shr','shl','test','cmp','mov') :
        for op in insn.operands:
            if op.type == X.X86_OP_IMM and op.imm in INTERESTING:
                found[op.imm].append((insn.address, f"{insn.mnemonic} {insn.op_str}"))
print("=== CoreCLR-characteristic bitfield constants in code ===")
for k,v in sorted(found.items(), key=lambda x:-len(x[1])):
    print(f"\n0x{k:x}  ({INTERESTING[k]}) — {len(v)} sites")
    for a,s in v[:6]: print(f"   0x{a:x}  {s}")
