import pefile, capstone, struct
PATH = r"C:\Users\Brandon\spectra-overlay\vendor\untapped-scry\lib\binding\napi-v5\untapped-scry.node"
pe = pefile.PE(PATH, fast_load=True); pe.parse_data_directories()
base = pe.OPTIONAL_HEADER.ImageBase
img  = pe.get_memory_mapped_image()
def rd8(va):
    o = va - base
    return struct.unpack_from('<Q', img, o)[0] if 0 <= o < len(img)-8 else 0
def rd4(va):
    o = va - base
    return struct.unpack_from('<I', img, o)[0] if 0 <= o < len(img)-4 else 0

CLASSES = ['DotNetCoreModuleImpl','DotNetCoreModule','ScryCached','ScryWin64','ScryWin',
           'WinNativeInterfaceDefaultImpl','Il2CppMetadataContextImpl','MonoImageImpl']
print("=== MSVC RTTI: TypeDescriptor -> COL -> vtable ===")
found = {}
for cls in CLASSES:
    nm = f'.?AV{cls}@@'.encode()
    i = img.find(nm)
    if i < 0: print(f"  {cls}: name not found"); continue
    type_desc = base + i - 0x10          # TypeDescriptor starts 0x10 before the name
    td_rva = type_desc - base
    # find RTTICompleteObjectLocator: has pTypeDescriptor as an RVA at +0x0c
    col = None
    off = 0
    while True:
        j = img.find(struct.pack('<I', td_rva), off)
        if j < 0: break
        cand = base + j - 0x0c          # COL start
        if rd4(cand) in (0,1) and rd4(cand+0x14) == (cand - base):   # signature + selfRVA
            col = cand; break
        off = j + 1
    if col is None:
        print(f"  {cls}: TypeDescriptor 0x{type_desc:x} but no COL"); continue
    # vtable: the qword immediately BEFORE the vtable equals the COL address
    k = img.find(struct.pack('<Q', col))
    vtbl = base + k + 8 if k >= 0 else None
    print(f"  {cls:<20} td=0x{type_desc:x} col=0x{col:x} vtable={'0x%x'%vtbl if vtbl else '?'}")
    if vtbl: found[cls] = vtbl

# Dump the first N virtual methods of the key classes
md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64); md.detail = True
text = next(s for s in pe.sections if b'.text' in s.Name)
code = text.get_data(); code_va = base + text.VirtualAddress
X = capstone.x86; SKIP={X.X86_REG_RSP,X.X86_REG_RBP,X.X86_REG_RIP}
for cls in ('DotNetCoreModuleImpl','ScryWin64'):
    if cls not in found: continue
    print(f"\n=== {cls} vtable methods ===")
    for vi in range(16):
        fn = rd8(found[cls] + vi*8)
        if not (code_va <= fn < code_va+len(code)): break
        consts=[]
        try:
            for insn in md.disasm(code[fn-code_va:fn-code_va+0x300], fn):
                for op in insn.operands:
                    if op.type==X.X86_OP_MEM and op.mem.base not in SKIP and op.mem.base!=0:
                        if 0 < op.mem.disp < 0x200: consts.append(op.mem.disp)
                if insn.mnemonic=='ret': break
        except Exception: pass
        u=sorted(set(consts))
        print(f"  [{vi}] 0x{fn:x}  offsets: {', '.join('+0x%x'%c for c in u[:12])}")
