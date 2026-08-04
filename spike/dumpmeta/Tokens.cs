using System;
using System.IO;
using System.Collections.Generic;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Text.Json;

// Emits TypeDef token -> full type name for sts2.dll. CoreCLR stores a type's
// TypeDef token in its MethodTable (+0x0A), so this table lets us identify
// MethodTables in memory EXACTLY, with no heuristics.
internal static class Tokens
{
    public static void Dump(string dll, string outPath)
    {
        using var fs = File.OpenRead(dll);
        using var pe = new PEReader(fs);
        var md = pe.GetMetadataReader();
        var map = new Dictionary<string, string>();
        foreach (var th in md.TypeDefinitions)
        {
            var td = md.GetTypeDefinition(th);
            int token = MetadataTokens.GetToken(th);      // 0x02xxxxxx
            string ns = md.GetString(td.Namespace);
            string nm = md.GetString(td.Name);
            map[(token & 0xFFFFFF).ToString()] = ns.Length > 0 ? $"{ns}.{nm}" : nm;
        }
        File.WriteAllText(outPath, JsonSerializer.Serialize(map));
        Console.WriteLine($"wrote {map.Count} TypeDef tokens -> {outPath}");
    }
}
