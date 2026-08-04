import pefile, capstone
PATH = r"C:\Users\Brandon\spectra-overlay\vendor\untapped-scry\lib\binding\napi-v5\untapped-scry.node"
pe = pefile.PE(PATH); base = pe.OPTIONAL_HEADER.ImageBase
img = pe.get_memory_mapped_image()
text = next(s for s in pe.sections if b'.text' in s.Name)
code = text.get_data(); code_va = base + text.VirtualAddress
md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64); md.detail=True
X=capstone.x86
def cstr(va,n=80):
    o=va-base
    if o<0 or o>=len(img): return None
    e=img.find(b'\0',o,o+n); s=img[o:e if e>0 else o+n]
    try:
        d=s.decode('utf8'); return d if d and all(32<=ord(c)<127 for c in d) else None
    except: return None

for NEEDLE in [b"No such property\0", b"No such class\0", b"getFieldNames\0"]:
    i = img.find(NEEDLE)
    if i < 0: continue
    va = base + i
    print(f"\n########## {NEEDLE[:-1].decode()!r} @0x{va:x} ##########")
    for insn in md.disasm(code, code_va):
        if insn.mnemonic!='lea': continue
        for op in insn.operands:
            if op.type==X.X86_OP_MEM and op.mem.base==X.X86_REG_RIP and insn.address+insn.size+op.mem.disp==va:
                print(f"--- xref @0x{insn.address:x}; showing 0x160 bytes before ---")
                st = insn.address - 0x160
                for ins in md.disasm(code[st-code_va:st-code_va+0x190], st):
                    note=''
                    for o2 in ins.operands:
                        if o2.type==X.X86_OP_MEM and o2.mem.base==X.X86_REG_RIP:
                            s=cstr(ins.address+ins.size+o2.mem.disp)
                            if s: note=f'   ; "{s}"'
                        elif o2.type==X.X86_OP_MEM and o2.mem.base not in (X.X86_REG_RSP,X.X86_REG_RBP,0) and 0<o2.mem.disp<0x200:
                            note=f'   <-- +0x{o2.mem.disp:x}'
                    print(f"   0x{ins.address:x}  {ins.mnemonic:<7} {ins.op_str}{note}")
                break
        else: continue
        break
