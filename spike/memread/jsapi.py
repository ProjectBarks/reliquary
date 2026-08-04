import pefile, capstone
from collections import defaultdict
PATH = r"C:\Users\Brandon\spectra-overlay\vendor\untapped-scry\lib\binding\napi-v5\untapped-scry.node"
pe = pefile.PE(PATH); base = pe.OPTIONAL_HEADER.ImageBase
img = pe.get_memory_mapped_image()
text = next(s for s in pe.sections if b'.text' in s.Name)
code = text.get_data(); code_va = base + text.VirtualAddress
md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64); md.detail=True
X=capstone.x86

# delay-import thunks: map thunk VA -> napi name
thunks={}
for e in getattr(pe,'DIRECTORY_ENTRY_DELAY_IMPORT',[]):
    for i in e.imports:
        if i.name: thunks[i.address]=i.name.decode()
print(f"delay-import thunk slots: {len(thunks)}")

def cstr(va,n=80):
    o=va-base
    if o<0 or o>=len(img): return None
    en=img.find(b'\0',o,o+n); s=img[o:en if en>0 else o+n]
    try:
        d=s.decode('utf8'); return d if d and all(32<=ord(c)<127 for c in d) else None
    except: return None

# Scan all code; when we hit a call to a napi thunk, report recent LEA'd strings.
WANT={'napi_create_function','napi_define_properties','napi_set_named_property','napi_get_named_property','napi_has_property','napi_get_property'}
recent=[]
hits=defaultdict(set)
for insn in md.disasm(code, code_va):
    if insn.mnemonic=='lea':
        for op in insn.operands:
            if op.type==X.X86_OP_MEM and op.mem.base==X.X86_REG_RIP:
                s=cstr(insn.address+insn.size+op.mem.disp)
                if s and 1<len(s)<48: recent.append(s)
                if len(recent)>6: recent.pop(0)
    elif insn.mnemonic=='call':
        for op in insn.operands:
            tgt=None
            if op.type==X.X86_OP_MEM and op.mem.base==X.X86_REG_RIP:
                tgt=insn.address+insn.size+op.mem.disp
            if tgt in thunks and thunks[tgt] in WANT:
                for s in recent: hits[thunks[tgt]].add(s)
                recent=[]
for k,v in hits.items():
    print(f"\n=== {k} — nearby string literals ({len(v)}) ===")
    for s in sorted(v)[:120]: print(f"   {s}")
