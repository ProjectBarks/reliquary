using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;

// Dumps the modding contract + our target types straight out of the game's
// managed assembly, so the mod is written against the real API rather than guesses.

string dll = args.Length > 0
    ? args[0]
    : @"C:\Program Files (x86)\Steam\steamapps\common\Slay the Spire 2\data_sts2_windows_x86_64\sts2.dll";

using var fs = File.OpenRead(dll);
using var pe = new PEReader(fs);
var md = pe.GetMetadataReader();

string S(StringHandle h) => md.GetString(h);

// Which namespaces/types to dump in full
string[] wantNs = { "MegaCrit.Sts2.Core.Modding" };
string[] wantTypes = {
    "NGame", "NRun", "NCombatRoom", "NCombatPilesContainer", "NGridCardHolder",
    "NCardRewardSelectionScreen", "NMerchantRoom", "CardModel", "ModManifest",
    "ModManager", "ModHelper", "ModSource"
};

Console.WriteLine($"# {Path.GetFileName(dll)}  types={md.TypeDefinitions.Count}\n");

foreach (var th in md.TypeDefinitions)
{
    var td = md.GetTypeDefinition(th);
    string ns = S(td.Namespace), nm = S(td.Name);
    bool hit = wantNs.Any(w => ns == w) || wantTypes.Contains(nm);
    if (!hit) continue;

    var attrs = td.Attributes;
    string kind = (attrs & TypeAttributes.Interface) != 0 ? "interface" : "class";
    Console.WriteLine($"== {kind} {ns}.{nm}");

    // base type
    if (!td.BaseType.IsNil && td.BaseType.Kind == HandleKind.TypeReference)
    {
        var br = md.GetTypeReference((TypeReferenceHandle)td.BaseType);
        Console.WriteLine($"   : {S(br.Namespace)}.{S(br.Name)}");
    }

    foreach (var fh in td.GetFields())
    {
        var fd = md.GetFieldDefinition(fh);
        var vis = fd.Attributes & FieldAttributes.FieldAccessMask;
        string st = (fd.Attributes & FieldAttributes.Static) != 0 ? "static " : "";
        Console.WriteLine($"   field {vis,-9} {st}{S(fd.Name)}");
    }
    foreach (var ph in td.GetProperties())
    {
        var pd = md.GetPropertyDefinition(ph);
        Console.WriteLine($"   prop            {S(pd.Name)}");
    }
    foreach (var mh in td.GetMethods())
    {
        var mdf = md.GetMethodDefinition(mh);
        var vis = mdf.Attributes & MethodAttributes.MemberAccessMask;
        string st = (mdf.Attributes & MethodAttributes.Static) != 0 ? "static " : "";
        string n = S(mdf.Name);
        if (n.StartsWith("get_") || n.StartsWith("set_")) continue;
        Console.WriteLine($"   method {vis,-9} {st}{n}");
    }
    Console.WriteLine();
}
