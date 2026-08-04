import pefile, capstone
PATH = r"C:\Users\Brandon\spectra-overlay\vendor\untapped-scry\lib\binding\napi-v5\untapped-scry.node"
pe = pefile.PE(PATH); base = pe.OPTIONAL_HEADER.ImageBase
img = pe.get_memory_mapped_image()
text = next(s for s in pe.sections if b'.text' in s.Name)
code = text.get_data(); code_va = base + text.VirtualAddress
md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64); md.detail=True
X=capstone.x86
def cstr(va,n=60):
    o=va-base
    if o<0 or o>=len(img): return None
    e=img.find(b'\0',o,o+n); s=img[o:e if e>0 else o+n]
    try:
        d=s.decode('utf8'); return d if d and all(32<=ord(c)<127 for c in d) else None
    except: return None
for fn,label in [(0x180036930,'findField(class,name)'),(0x180032730,'readField/getOffset')]:
    print(f"\n########## {label} @0x{fn:x} ##########")
    n=0
    for ins in md.disasm(code[fn-code_va:fn-code_va+0x220], fn):
        note=''
        for o in ins.operands:
            if o.type==X.X86_OP_MEM and o.mem.base==X.X86_REG_RIP:
                s=cstr(ins.address+ins.size+o.mem.disp)
                if s: note=f'   ; "{s}"'
            elif o.type==X.X86_OP_MEM and o.mem.base not in (X.X86_REG_RSP,X.X86_REG_RBP,0) and 0<=o.mem.disp<0x300:
                note=f'   <-- +0x{o.mem.disp:x}'
            elif o.type==X.X86_OP_IMM and 0x10 <= o.imm < 0x10000000:
                note += f'   [imm 0x{o.imm:x}]'
        print(f"   0x{ins.address:x}  {ins.mnemonic:<8} {ins.op_str}{note}")
        n+=1
        if ins.mnemonic=='ret' and n>12: break
        if n>75: break
