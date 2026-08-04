import pefile, capstone
from collections import Counter
PATH = r"C:\Users\Brandon\spectra-overlay\vendor\untapped-scry\lib\binding\napi-v5\untapped-scry.node"
pe = pefile.PE(PATH, fast_load=True); pe.parse_data_directories()
base = pe.OPTIONAL_HEADER.ImageBase
text = next(s for s in pe.sections if b'.text' in s.Name)
code = text.get_data(); code_va = base + text.VirtualAddress
md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64); md.detail = True
X = capstone.x86
SKIP = {X.X86_REG_RSP, X.X86_REG_RBP, X.X86_REG_RIP}

def struct_offsets(start, size):
    """Field offsets from non-stack base registers = real struct accesses."""
    c = Counter()
    try:
        for insn in md.disasm(code[start-code_va:start-code_va+size], start):
            for op in insn.operands:
                if op.type == X.X86_OP_MEM and op.mem.base not in SKIP and op.mem.base != 0:
                    d = op.mem.disp
                    if 0 <= d < 0x200: c[d]+=1
            if insn.mnemonic in ('ret','jmp') and insn.address-start > size*0.6: break
    except Exception: pass
    return c

# The functions called right before the error string is built are the bootstrap workers.
CALLEES = [0x1800760ec, 0x180003e70, 0x180001480, 0x180006230]
print("=== struct-field offsets per bootstrap callee (rsp/rbp excluded) ===")
agg = Counter()
for fn in CALLEES:
    c = struct_offsets(fn, 0x400)
    agg.update(c)
    top = ', '.join(f"+0x{d:x}({n})" for d,n in c.most_common(10))
    print(f"  fn 0x{fn:x}: {top}")

print("\n=== aggregate most-used struct offsets ===")
for d,n in agg.most_common(20):
    print(f"  +0x{d:<4x} {n}x")

# Also: the DotNetCore reader functions. Find them via the .NET error strings.
data = pe.get_memory_mapped_image()
for s in [b"Failed to read array item class.", b"Could not read MonoClass namespace"]:
    i = data.find(s)
    if i<0: continue
    va = base+i
    for insn in md.disasm(code, code_va):
        if insn.mnemonic=='lea':
            for op in insn.operands:
                if op.type==X.X86_OP_MEM and op.mem.base==X.X86_REG_RIP:
                    if insn.address+insn.size+op.mem.disp == va:
                        print(f"\n{s[:28]!r} xref @0x{insn.address:x}")
                        c = struct_offsets(insn.address-0x300, 0x400)
                        print("   nearby struct offsets:", ', '.join(f"+0x{d:x}({n})" for d,n in c.most_common(12)))
