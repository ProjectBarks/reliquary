import pefile, capstone
from collections import defaultdict
PATH = r"C:\Users\Brandon\spectra-overlay\vendor\untapped-scry\lib\binding\napi-v5\untapped-scry.node"
pe = pefile.PE(PATH); base = pe.OPTIONAL_HEADER.ImageBase
img = pe.get_memory_mapped_image()
text = next(s for s in pe.sections if b'.text' in s.Name)
code = text.get_data(); code_va = base + text.VirtualAddress
md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64); md.detail=True
X=capstone.x86

# Where is "7.0.11" referenced? That's the version-gate anchor.
i = img.find(b"7.0.11\0")
print(f'"7.0.11" @0x{base+i:x}' if i>=0 else 'not found')
if i>=0:
    va = base+i
    for insn in md.disasm(code, code_va):
        if insn.mnemonic=='lea':
            for o in insn.operands:
                if o.type==X.X86_OP_MEM and o.mem.base==X.X86_REG_RIP and insn.address+insn.size+o.mem.disp==va:
                    print(f"  xref @0x{insn.address:x}")

# Find all version-comparison sites: cmp against small ints on a WORD/DWORD.
# We already know `cmp word ptr [rax], 9`. Enumerate the family.
print("\n=== version comparisons (cmp word/dword [reg], N) where N in 2..12 ===")
sites = defaultdict(list)
for insn in md.disasm(code, code_va):
    if insn.mnemonic in ('cmp','sub') and len(insn.operands)==2:
        a,b = insn.operands
        if a.type==X.X86_OP_MEM and a.mem.base not in (X.X86_REG_RSP,X.X86_REG_RBP,X.X86_REG_RIP,0) \
           and b.type==X.X86_OP_IMM and 2 <= b.imm <= 12 and a.mem.disp in (0,2,4,8):
            sites[b.imm].append((insn.address, insn.op_str, insn.size))
for v in sorted(sites):
    print(f"  vs {v}: {len(sites[v])} sites  e.g. " + ", ".join(f"0x{a:x} ({s})" for a,s,_ in sites[v][:3]))
