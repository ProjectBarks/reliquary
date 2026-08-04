import pefile, capstone
PATH = r"C:\Users\Brandon\spectra-overlay\vendor\untapped-scry\lib\binding\napi-v5\untapped-scry.node"
pe = pefile.PE(PATH, fast_load=True); pe.parse_data_directories()
base = pe.OPTIONAL_HEADER.ImageBase
text = next(s for s in pe.sections if b'.text' in s.Name)
code = text.get_data(); code_va = base + text.VirtualAddress
md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64); md.detail = True
data = pe.get_memory_mapped_image()

def find_func_start(addr):
    # walk back to a likely prologue (int3 padding then push/sub)
    off = addr - code_va
    for back in range(0x40, 0x900, 1):
        p = off - back
        if p < 4: break
        if data[base + text.VirtualAddress + p - 1 - base + base - base] if False else False: pass
        # look for 0xCC padding immediately before
        if code[p-1] == 0xCC and code[p] in (0x48,0x40,0x55,0x53,0x56,0x57):
            return code_va + p
    return addr - 0x120

start = find_func_start(0x18000b0c1)
print(f"=== bootstrap fn ~0x{start:x} (xref at 0x18000b0c1) ===")
size = 0x18000b0c1 - start + 0x200
disp_consts = {}
for insn in md.disasm(code[start-code_va:start-code_va+size], start):
    marker = ""
    # collect memory displacements — these are STRUCT OFFSETS
    for op in insn.operands:
        if op.type == capstone.x86.X86_OP_MEM and op.mem.base != 0 and op.mem.base != capstone.x86.X86_REG_RIP:
            d = op.mem.disp
            if 0 < d < 0x400:
                disp_consts[d] = disp_consts.get(d,0)+1
                marker = f"   <-- offset +0x{d:x}"
    print(f"  0x{insn.address:x}  {insn.mnemonic:<7} {insn.op_str}{marker}")
    if insn.address > 0x18000b0c1 + 0x40: break

print("\n=== struct offsets used in this function (freq) ===")
for d,c in sorted(disp_consts.items(), key=lambda x:-x[1])[:25]:
    print(f"  +0x{d:<4x} used {c}x")
