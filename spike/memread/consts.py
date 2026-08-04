import pefile, capstone
from collections import Counter
PATH = r"C:\Users\Brandon\spectra-overlay\vendor\untapped-scry\lib\binding\napi-v5\untapped-scry.node"
pe = pefile.PE(PATH, fast_load=True); pe.parse_data_directories()
base = pe.OPTIONAL_HEADER.ImageBase
text = next(s for s in pe.sections if b'.text' in s.Name)
code = text.get_data(); code_va = base + text.VirtualAddress
md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64); md.detail=True
X=capstone.x86
LO, HI = 0x180056f90, 0x180059400          # DotNetCoreModuleImpl method cluster
imm = Counter(); mem = Counter(); calls = Counter()
for insn in md.disasm(code[LO-code_va:HI-code_va], LO):
    for op in insn.operands:
        if op.type==X.X86_OP_IMM and 0 < op.imm < 0x10000: imm[op.imm]+=1
        if op.type==X.X86_OP_MEM and op.mem.base not in (X.X86_REG_RSP,X.X86_REG_RBP,X.X86_REG_RIP,0):
            if 0 <= op.mem.disp < 0x200: mem[op.mem.disp]+=1
    if insn.mnemonic=='call' and 'qword ptr [' in insn.op_str: calls[insn.op_str]+=1
print("=== immediates (sizes / offsets used as adds) ===")
for k,v in imm.most_common(22): print(f"  0x{k:<6x} ({k:<6}) {v}x")
print("\n=== struct field offsets ===")
for k,v in mem.most_common(18): print(f"  +0x{k:<5x} {v}x")
print("\n=== virtual calls (Scry interface slots) ===")
for k,v in calls.most_common(12): print(f"  {k:<28} {v}x")
