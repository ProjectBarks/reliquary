import pefile, capstone
PATH = r"C:\Users\Brandon\spectra-overlay\vendor\untapped-scry\lib\binding\napi-v5\untapped-scry.node"
pe = pefile.PE(PATH); base = pe.OPTIONAL_HEADER.ImageBase
img = pe.get_memory_mapped_image()
text = next(s for s in pe.sections if b'.text' in s.Name)
code = text.get_data(); code_va = base + text.VirtualAddress
md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64); md.detail=True
X=capstone.x86

def cstr(va, n=64):
    o = va - base
    if o<0 or o>=len(img): return None
    e = img.find(b'\0', o, o+n)
    s = img[o:e if e>0 else o+n]
    try: return s.decode('utf8')
    except: return None

# Walk the module registration function, collecting every string it LEAs —
# those are the JS-visible class/method names.
print("=== strings referenced from napi_register_module_v1 (and callees) ===")
seen=set(); queue=[0x1800032e0]; names=[]
while queue:
    fn = queue.pop(0)
    if fn in seen or not (code_va <= fn < code_va+len(code)): continue
    seen.add(fn)
    if len(seen) > 60: break
    try:
        for insn in md.disasm(code[fn-code_va:fn-code_va+0x500], fn):
            if insn.mnemonic=='lea':
                for op in insn.operands:
                    if op.type==X.X86_OP_MEM and op.mem.base==X.X86_REG_RIP:
                        s = cstr(insn.address+insn.size+op.mem.disp)
                        if s and 2 < len(s) < 48 and all(32<=ord(c)<127 for c in s):
                            names.append(s)
            if insn.mnemonic=='call':
                for op in insn.operands:
                    if op.type==X.X86_OP_IMM: queue.append(op.imm)
            if insn.mnemonic=='ret': break
    except Exception: pass
uniq=[]
for n in names:
    if n not in uniq: uniq.append(n)
for n in uniq[:70]: print(f"  {n}")
