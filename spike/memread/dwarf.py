"""Extract C++ struct layouts from the DWARF the game ships in its .exe.

Godot's engine-side objects are plain C++, so the only way to read a Control's
rect out of memory is to know its field offsets. This build carries 766 MB of
DWARF, which means the offsets are published rather than guessed.

Usage:  python dwarf.py Control CanvasItem Node Object
"""
import struct
import sys

import pefile
from elftools.dwarf.dwarfinfo import DWARFInfo, DwarfConfig, DebugSectionDescriptor
from elftools.common.utils import struct_parse

EXE = r"C:\Program Files (x86)\Steam\steamapps\common\Slay the Spire 2\SlayTheSpire2.exe"
WANT_SECTIONS = (
    ".debug_info", ".debug_abbrev", ".debug_str", ".debug_line",
    ".debug_str_offsets", ".debug_line_str", ".debug_loc", ".debug_ranges",
    ".debug_addr", ".debug_aranges",
)


def load_sections(path):
    pe = pefile.PE(path, fast_load=True)
    f = open(path, "rb")
    sym = pe.FILE_HEADER.PointerToSymbolTable
    f.seek(sym + pe.FILE_HEADER.NumberOfSymbols * 18)
    size = struct.unpack("<I", f.read(4))[0]
    f.seek(sym + pe.FILE_HEADER.NumberOfSymbols * 18)
    strtab = f.read(size)

    out = {}
    for s in pe.sections:
        raw = s.Name.rstrip(b"\x00").decode("latin1")
        name = raw
        if raw.startswith("/"):
            off = int(raw[1:])
            name = strtab[off:strtab.index(b"\x00", off)].decode("latin1")
        if name in WANT_SECTIONS:
            f.seek(s.PointerToRawData)
            data = f.read(s.SizeOfRawData)
            out[name] = DebugSectionDescriptor(
                stream=__import__("io").BytesIO(data),
                name=name,
                global_offset=0,
                size=len(data),
                address=s.VirtualAddress,
            )
    return out


def make_dwarf(sections):
    get = sections.get
    return DWARFInfo(
        config=DwarfConfig(little_endian=True, default_address_size=8, machine_arch="x64"),
        debug_info_sec=get(".debug_info"),
        debug_aranges_sec=get(".debug_aranges"),
        debug_abbrev_sec=get(".debug_abbrev"),
        debug_frame_sec=None,
        eh_frame_sec=None,
        debug_str_sec=get(".debug_str"),
        debug_loc_sec=get(".debug_loc"),
        debug_ranges_sec=get(".debug_ranges"),
        debug_line_sec=get(".debug_line"),
        debug_pubtypes_sec=None,
        debug_pubnames_sec=None,
        debug_addr_sec=get(".debug_addr"),
        debug_str_offsets_sec=get(".debug_str_offsets"),
        debug_line_str_sec=get(".debug_line_str"),
        debug_loclists_sec=None,
        debug_rnglists_sec=None,
        debug_sup_sec=None,
        gnu_debugaltlink_sec=None,
        debug_types_sec=None,
    )


def die_name(die):
    v = die.attributes.get("DW_AT_name")
    if not v:
        return None
    n = v.value
    return n.decode("latin1") if isinstance(n, bytes) else str(n)


def member_offset(die):
    a = die.attributes.get("DW_AT_data_member_location")
    if a is None:
        return None
    v = a.value
    if isinstance(v, int):
        return v
    if isinstance(v, list) and v and v[0] == 0x23:  # DW_OP_plus_uconst
        val, shift = 0, 0
        for b in v[1:]:
            val |= (b & 0x7F) << shift
            shift += 7
            if not b & 0x80:
                break
        return val
    return None


def type_name(cu, die, depth=0):
    if depth > 6:
        return "?"
    ref = die.attributes.get("DW_AT_type")
    if not ref:
        return "void"
    try:
        t = cu.get_DIE_from_refaddr(ref.value + cu.cu_offset)
    except Exception:
        return "?"
    tag = t.tag
    if tag == "DW_TAG_pointer_type":
        return type_name(cu, t, depth + 1) + "*"
    if tag in ("DW_TAG_const_type", "DW_TAG_volatile_type", "DW_TAG_typedef"):
        n = die_name(t)
        return n if (tag == "DW_TAG_typedef" and n) else type_name(cu, t, depth + 1)
    return die_name(t) or tag


def main():
    wanted = set(sys.argv[1:]) or {"Control"}
    found = {}
    sections = load_sections(EXE)
    print(f"sections: {', '.join(sorted(sections))}", file=sys.stderr)
    dw = make_dwarf(sections)

    n_cu = 0
    for cu in dw.iter_CUs():
        n_cu += 1
        if n_cu % 200 == 0:
            print(f"  ...{n_cu} CUs, found {len(found)}/{len(wanted)}", file=sys.stderr)
        try:
            dies = list(cu.iter_DIEs())
        except Exception:
            continue
        for die in dies:
            if die.tag not in ("DW_TAG_structure_type", "DW_TAG_class_type"):
                continue
            name = die_name(die)
            if name not in wanted or name in found:
                continue
            members = []
            for ch in die.iter_children():
                if ch.tag == "DW_TAG_member":
                    off = member_offset(ch)
                    if off is None:
                        continue  # static member
                    members.append((off, die_name(ch), type_name(cu, ch)))
                elif ch.tag == "DW_TAG_inheritance":
                    members.append((member_offset(ch) or 0, f"<base {type_name(cu, ch)}>", ""))
            if members:
                size = die.attributes.get("DW_AT_byte_size")
                found[name] = (size.value if size else None, sorted(members))
                # Godot keeps a class's real state in a nested `Data` struct, so
                # the outer layout alone is not enough — emit nested types too.
                for ch in die.iter_children():
                    if ch.tag not in ("DW_TAG_structure_type", "DW_TAG_class_type"):
                        continue
                    sub = []
                    for gc in ch.iter_children():
                        if gc.tag == "DW_TAG_member":
                            o = member_offset(gc)
                            if o is not None:
                                sub.append((o, die_name(gc), type_name(cu, gc)))
                    if sub:
                        sz = ch.attributes.get("DW_AT_byte_size")
                        found[f"{name}::{die_name(ch)}"] = (sz.value if sz else None, sorted(sub))
        if all(w in found for w in wanted):
            break

    print(f"scanned {n_cu} CUs", file=sys.stderr)
    for name in sorted(found) if "--all" in sys.argv else sys.argv[1:]:
        if name not in found:
            print(f"\n=== {name}: NOT FOUND")
            continue
        size, members = found[name]
        print(f"\n=== {name}  (sizeof={size})")
        for off, nm, ty in members:
            print(f"  +0x{off:04x}  {nm:34} {ty}")


if __name__ == "__main__":
    main()
