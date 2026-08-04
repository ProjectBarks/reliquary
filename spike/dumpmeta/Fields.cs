using System;
using System.IO;
using System.Reflection;
using System.Collections.Generic;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text.Json;

// Emits FieldDef rid -> "DeclaringType.fieldName : signature".
// A CoreCLR FieldDesc stores its FieldDef token in the low 24 bits of the dword
// at +0x08, so this table names every field we decode out of memory exactly.
internal static class Fields
{
    public static void Dump(string dll, string outPath)
    {
        using var fs = File.OpenRead(dll);
        using var pe = new PEReader(fs);
        var md = pe.GetMetadataReader();
        var owner = new Dictionary<int, string>();
        foreach (var th in md.TypeDefinitions)
        {
            var td = md.GetTypeDefinition(th);
            string ns = md.GetString(td.Namespace), nm = md.GetString(td.Name);
            string full = ns.Length > 0 ? $"{ns}.{nm}" : nm;
            foreach (var fh in td.GetFields()) owner[MetadataTokens.GetToken(fh) & 0xFFFFFF] = full;
        }

        var sig = new SigNames();
        var map = new Dictionary<string, object>();
        foreach (var fh in md.FieldDefinitions)
        {
            var fd = md.GetFieldDefinition(fh);
            int rid = MetadataTokens.GetToken(fh) & 0xFFFFFF;
            string type;
            try { type = fd.DecodeSignature(sig, null); } catch { type = "?"; }
            map[rid.ToString()] = new
            {
                n = md.GetString(fd.Name),
                t = owner.TryGetValue(rid, out var o) ? o : "?",
                s = type,
                st = (fd.Attributes & FieldAttributes.Static) != 0
            };
        }
        File.WriteAllText(outPath, JsonSerializer.Serialize(map));
        Console.WriteLine($"wrote {map.Count} FieldDef tokens -> {outPath}");
    }

    // Minimal signature decoder — we only need readable type names.
    private sealed class SigNames : ISignatureTypeProvider<string, object?>
    {
        public string GetArrayType(string e, ArrayShape s) => e + "[]";
        public string GetByReferenceType(string e) => e + "&";
        public string GetFunctionPointerType(MethodSignature<string> s) => "fnptr";
        public string GetGenericInstantiation(string g, System.Collections.Immutable.ImmutableArray<string> a) => g + "<" + string.Join(",", a) + ">";
        public string GetGenericMethodParameter(object? c, int i) => "!!" + i;
        public string GetGenericTypeParameter(object? c, int i) => "!" + i;
        public string GetModifiedType(string m, string u, bool req) => u;
        public string GetPinnedType(string e) => e;
        public string GetPointerType(string e) => e + "*";
        public string GetPrimitiveType(PrimitiveTypeCode c) => c.ToString();
        public string GetSZArrayType(string e) => e + "[]";
        public string GetTypeFromDefinition(MetadataReader r, TypeDefinitionHandle h, byte rawKind)
        { var d = r.GetTypeDefinition(h); var ns = r.GetString(d.Namespace); var n = r.GetString(d.Name); return ns.Length > 0 ? ns + "." + n : n; }
        public string GetTypeFromReference(MetadataReader r, TypeReferenceHandle h, byte rawKind)
        { var d = r.GetTypeReference(h); var ns = r.GetString(d.Namespace); var n = r.GetString(d.Name); return ns.Length > 0 ? ns + "." + n : n; }
        public string GetTypeFromSpecification(MetadataReader r, object? c, TypeSpecificationHandle h, byte rawKind)
        => r.GetTypeSpecification(h).DecodeSignature(this, c);
    }
}
