import pefile, capstone
PATH = r"C:\Users\Brandon\spectra-overlay\vendor\untapped-scry\lib\binding\napi-v5\untapped-scry.node"
pe = pefile.PE(PATH, fast_load=True); pe.parse_data_directories()
base = pe.OPTIONAL_HEADER.ImageBase
text = next(s for s in pe.sections if b'.text' in s.Name)
code = text.get_data(); code_va = base + text.VirtualAddress
md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64); md.detail=True
X=capstone.x86; SKIP={X.X86_REG_RSP,X.X86_REG_RBP,X.X86_REG_RIP}

# DotNetCoreModuleImpl vtable[9] — richest offset set, likely the metadata walk.
for fn,label in [(0x1800586f0,'DotNetCoreModuleImpl::vt[9]'), (0x180058bc0,'vt[13]')]:
    print(f"\n=== {label} @0x{fn:x} ===")
    n=0
    for insn in md.disasm(code[fn-code_va:fn-code_va+0x260], fn):
        note=""
        for op in insn.operands:
            if op.type==X.X86_OP_MEM and op.mem.base not in SKIP and op.mem.base!=0 and 0<op.mem.disp<0x200:
                note=f"   <-- +0x{op.mem.disp:x}"
        if insn.mnemonic in ('call','lea','mov','add','cmp','movzx','test') :
            print(f"  0x{insn.address:x}  {insn.mnemonic:<6} {insn.op_str}{note}")
        n+=1
        if insn.mnemonic=='ret' or n>90: break
