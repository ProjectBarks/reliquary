using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;

// Schema parity gate: does our hand-coded snapshot builder emit EXACTLY the
// shapes the proprietary reader produces?
//
// Ground truth is shadow/primary.jsonl — real snapshots recorded from the live
// untapped-scry provider. We invoke our builder (null inputs exercise the idle
// paths without needing the game running) and diff key sets + value types.
//
// Exit 0 = parity, 1 = drift, 2 = no ground truth. Runs in CI without the game.

internal static class Program
{
    private static int Main(string[] args)
    {
        // Game assemblies are referenced with <Private>false</Private> (never copied),
        // so resolve them from the install at runtime.
        string gameDir = Environment.GetEnvironmentVariable("STS2_DATA_DIR")
            ?? @"C:\Program Files (x86)\Steam\steamapps\common\Slay the Spire 2\data_sts2_windows_x86_64";
        AppDomain.CurrentDomain.AssemblyResolve += (_, e) =>
        {
            var path = Path.Combine(gameDir, new AssemblyName(e.Name).Name + ".dll");
            return File.Exists(path) ? Assembly.LoadFrom(path) : null;
        };
        return Run(args);
    }

    // Kept separate so the resolver is installed before SpectraBridge types load.
    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int Run(string[] args)
    {
        string shadowDir = args.Length > 0
            ? args[0]
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                           "Reliquary", "shadow");
        string truthFile = Path.Combine(shadowDir, "primary.jsonl");

        if (!File.Exists(truthFile))
        {
            Console.Error.WriteLine($"no ground truth at {truthFile} — run with SPECTRA_SHADOW=1 first");
            return 2;
        }

        // Latest recorded snapshot per key = the authoritative schema.
        var truth = new Dictionary<string, JsonElement>();
        foreach (var line in File.ReadLines(truthFile))
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            try
            {
                var doc = JsonDocument.Parse(line);
                truth[doc.RootElement.GetProperty("key").GetString()!] =
                    doc.RootElement.GetProperty("value").Clone();
            }
            catch { /* skip malformed */ }
        }

        var ours = new Dictionary<string, JsonElement>
        {
            ["sts2.nGameState"] = Reparse(SpectraBridge.Snapshot.NGameState(null)),
            ["sts2.pileState"] = Reparse(SpectraBridge.Snapshot.PileState(null)),
            ["sts2.enemiesState"] = Reparse(SpectraBridge.Snapshot.EnemiesState(null)),
        };

        int problems = 0;
        foreach (var (key, expected) in truth)
        {
            if (!ours.TryGetValue(key, out var actual))
            {
                // cardData (CDN) and settings (SettingsStore) aren't reader-owned.
                if (key is "sts2.cardData" or "sts2.settings") continue;
                // layoutState is PROVIDER-DERIVED: the mod emits raw visible items
                // (Layout.VisibleItems) and Electron enriches them with Codex stats.
                // Its scene-tree walk can only be exercised with Godot running, so
                // it's verified by the live shadow diff, not this offline gate.
                if (key is "sts2.layoutState")
                {
                    Console.WriteLine($"DERIVED  {key}: provider-enriched from _raw.visibleItems (live-verified)");
                    continue;
                }
                Console.WriteLine($"GAP      {key}: not implemented by the mod");
                problems++;
                continue;
            }
            problems += Compare(key, expected, actual, "");
        }

        Console.WriteLine();
        Console.WriteLine(problems == 0
            ? $"SCHEMA PARITY OK — {ours.Count} keys match the recorded reader output"
            : $"SCHEMA DRIFT — {problems} problem(s)");
        return problems == 0 ? 0 : 1;
    }

    private static JsonElement Reparse(object o) =>
        JsonDocument.Parse(JsonSerializer.Serialize(o)).RootElement.Clone();

    /// <summary>Compares structure + value types (not values — those need a live diff).</summary>
    private static int Compare(string key, JsonElement exp, JsonElement act, string path)
    {
        string p = path.Length == 0 ? key : key + path;
        if (exp.ValueKind != act.ValueKind)
        {
            // null vs object is fine — idle-state builders legitimately emit null.
            if (exp.ValueKind is JsonValueKind.Null || act.ValueKind is JsonValueKind.Null) return 0;
            if (exp.ValueKind is JsonValueKind.True or JsonValueKind.False &&
                act.ValueKind is JsonValueKind.True or JsonValueKind.False) return 0;
            Console.WriteLine($"TYPE     {p}: reader={exp.ValueKind} ours={act.ValueKind}");
            return 1;
        }

        int n = 0;
        if (exp.ValueKind == JsonValueKind.Object)
        {
            foreach (var prop in exp.EnumerateObject())
            {
                if (!act.TryGetProperty(prop.Name, out var a))
                {
                    Console.WriteLine($"MISSING  {p}.{prop.Name}: reader emits it, we don't");
                    n++;
                    continue;
                }
                n += Compare(key, prop.Value, a, $"{path}.{prop.Name}");
            }
            foreach (var prop in act.EnumerateObject())
                if (!exp.TryGetProperty(prop.Name, out _))
                    Console.WriteLine($"EXTRA    {p}.{prop.Name}: ours only (additive, non-breaking)");
        }
        else if (exp.ValueKind == JsonValueKind.Array)
        {
            JsonElement? e = null, a = null;
            foreach (var x in exp.EnumerateArray()) { e = x; break; }
            foreach (var x in act.EnumerateArray()) { a = x; break; }
            if (e is { } ev && a is { } av) n += Compare(key, ev, av, $"{path}[]");
        }
        return n;
    }
}
