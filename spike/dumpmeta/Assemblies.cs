using System;
using System.IO;
using System.Collections.Generic;
using System.Reflection;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text.Json;

// Emits one metadata file per managed assembly: TypeDef rid -> name, and
// FieldDef rid -> {name, declaring type, signature, static}.
//
// Multi-assembly matters because TypeDef rids are only unique WITHIN an
// assembly. A CoreLib type will happily match an sts2 rid, so the reader has to
// know which token map belongs to which loaded Module. Naming GodotSharp's types
// is also what makes engine-side objects (Control, Node) readable at all.
internal static class Assemblies
{
    static readonly string[] Wanted = {
        "sts2.dll", "GodotSharp.dll", "System.Private.CoreLib.dll",
        "System.Collections.dll", "System.Runtime.dll"
    };

    public static void Dump(string gameDir, string outDir)
    {
        Directory.CreateDirectory(outDir);
        var index = new List<object>();
        foreach (var name in Wanted)
        {
            string path = Path.Combine(gameDir, name);
            if (!File.Exists(path)) { Console.WriteLine($"skip (missing) {name}"); continue; }
            try
            {
                var (types, fields) = One(path);
                string outPath = Path.Combine(outDir, Path.GetFileNameWithoutExtension(name) + ".json");
                File.WriteAllText(outPath, JsonSerializer.Serialize(new { asm = name, types, fields }));
                index.Add(new { asm = name, file = Path.GetFileName(outPath), types = types.Count, fields = fields.Count });
                Console.WriteLine($"{name,-32} {types.Count,6} types  {fields.Count,6} fields");
            }
            catch (Exception e) { Console.WriteLine($"FAILED {name}: {e.Message}"); }
        }
        File.WriteAllText(Path.Combine(outDir, "index.json"), JsonSerializer.Serialize(index));
        Console.WriteLine($"wrote {index.Count} assemblies -> {outDir}");
    }

    static (Dictionary<string, string>, Dictionary<string, object>) One(string dll)
    {
        using var fs = File.OpenRead(dll);
        using var pe = new PEReader(fs);
        var md = pe.GetMetadataReader();

        var types = new Dictionary<string, string>();
        var owner = new Dictionary<int, string>();
        foreach (var th in md.TypeDefinitions)
        {
            var td = md.GetTypeDefinition(th);
            string ns = md.GetString(td.Namespace), nm = md.GetString(td.Name);
            string full = ns.Length > 0 ? ns + "." + nm : nm;
            types[(MetadataTokens.GetToken(th) & 0xFFFFFF).ToString()] = full;
            foreach (var fh in td.GetFields()) owner[MetadataTokens.GetToken(fh) & 0xFFFFFF] = full;
        }

        var sig = new SigNames();
        var fields = new Dictionary<string, object>();
        foreach (var fh in md.FieldDefinitions)
        {
            var fd = md.GetFieldDefinition(fh);
            int rid = MetadataTokens.GetToken(fh) & 0xFFFFFF;
            string t;
            try { t = fd.DecodeSignature(sig, null); } catch { t = "?"; }
            fields[rid.ToString()] = new
            {
                n = md.GetString(fd.Name),
                t = owner.TryGetValue(rid, out var o) ? o : "?",
                s = t,
                st = (fd.Attributes & FieldAttributes.Static) != 0
            };
        }
        return (types, fields);
    }

    private sealed class SigNames : ISignatureTypeProvider<string, object>
    {
        public string GetArrayType(string e, ArrayShape s) => e + "[]";
        public string GetByReferenceType(string e) => e + "&";
        public string GetFunctionPointerType(MethodSignature<string> s) => "fnptr";
        public string GetGenericInstantiation(string g, System.Collections.Immutable.ImmutableArray<string> a) => g + "<" + string.Join(",", a) + ">";
        public string GetGenericMethodParameter(object c, int i) => "!!" + i;
        public string GetGenericTypeParameter(object c, int i) => "!" + i;
        public string GetModifiedType(string m, string u, bool req) => u;
        public string GetPinnedType(string e) => e;
        public string GetPointerType(string e) => e + "*";
        public string GetPrimitiveType(PrimitiveTypeCode c) => c.ToString();
        public string GetSZArrayType(string e) => e + "[]";
        public string GetTypeFromDefinition(MetadataReader r, TypeDefinitionHandle h, byte rawKind)
        { var d = r.GetTypeDefinition(h); var ns = r.GetString(d.Namespace); var n = r.GetString(d.Name); return ns.Length > 0 ? ns + "." + n : n; }
        public string GetTypeFromReference(MetadataReader r, TypeReferenceHandle h, byte rawKind)
        { var d = r.GetTypeReference(h); var ns = r.GetString(d.Namespace); var n = r.GetString(d.Name); return ns.Length > 0 ? ns + "." + n : n; }
        public string GetTypeFromSpecification(MetadataReader r, object c, TypeSpecificationHandle h, byte rawKind)
        => r.GetTypeSpecification(h).DecodeSignature(this, c);
    }
}
