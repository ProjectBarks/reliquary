import pefile, capstone, re, sys
PATH = r"C:\Users\Brandon\spectra-overlay\vendor\untapped-scry\lib\binding\napi-v5\untapped-scry.node"
pe = pefile.PE(PATH, fast_load=True)
pe.parse_data_directories()
base = pe.OPTIONAL_HEADER.ImageBase
text = next(s for s in pe.sections if b'.text' in s.Name)
code = text.get_data()
code_va = base + text.VirtualAddress

# 1. locate interesting strings anywhere in the image
targets = [b"Failed to bootstrap .NET Core metadata", b"g_dacTable",
           b"Could not read Il2CppClass name", b"Failed to connect to process"]
data = pe.get_memory_mapped_image()
hits = {}
for t in targets:
    i = data.find(t)
    if i >= 0:
        hits[t.decode()] = base + i
for k,v in hits.items():
    print(f"string {k!r} @ 0x{v:x}")

md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
md.detail = True

# 2. find LEA rip-relative references to those strings
print("\n=== xrefs (lea reg,[rip+..] -> string) ===")
xrefs = []
for insn in md.disasm(code, code_va):
    if insn.mnemonic == 'lea' and len(insn.operands) == 2:
        op = insn.operands[1]
        if op.type == capstone.x86.X86_OP_MEM and op.mem.base == capstone.x86.X86_REG_RIP:
            tgt = insn.address + insn.size + op.mem.disp
            for k,v in hits.items():
                if tgt == v:
                    xrefs.append((insn.address, k))
                    print(f"  0x{insn.address:x}  {insn.mnemonic} {insn.op_str}   -> {k!r}")
if not xrefs:
    print("  (none found)")
