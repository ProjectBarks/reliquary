using System.Reflection;
using MegaCrit.Sts2.Core.Combat;
using MegaCrit.Sts2.Core.Entities.Players;
using MegaCrit.Sts2.Core.Models;
using MegaCrit.Sts2.Core.Rooms;
using MegaCrit.Sts2.Core.Runs;

namespace SpectraBridge;

/// <summary>
/// Builds snapshots that are byte-for-byte compatible with the shapes the
/// proprietary reader produces (see src/shared/types.ts). Emitting our exact
/// schema means the Electron side needs no translation layer — the mod is a
/// drop-in replacement for untapped-scry.
///
/// MUST be called on the Godot main thread.
/// </summary>
internal static class Snapshot
{
    // ── null-safe reflection, for members whose exact shape varies by build ──
    private static readonly Dictionary<(Type, string), MemberInfo?> Cache = new();

    /// <summary>Field or property by name, walking the full inheritance chain.</summary>
    internal static object? Get(object? src, string name)
    {
        if (src is null) return null;
        var key = (src.GetType(), name);
        MemberInfo? m;
        lock (Cache)
        {
            if (!Cache.TryGetValue(key, out m))
            {
                const BindingFlags F = BindingFlags.Instance | BindingFlags.Public |
                                       BindingFlags.NonPublic | BindingFlags.DeclaredOnly;
                for (var t = src.GetType(); t != null && t != typeof(object); t = t.BaseType)
                {
                    if (t.GetProperty(name, F) is { } p) { m = p; break; }
                    if (t.GetField(name, F) is { } f) { m = f; break; }
                }
                Cache[key] = m;
            }
        }
        try
        {
            return m switch
            {
                PropertyInfo p => p.GetValue(src),
                FieldInfo f => f.GetValue(src),
                _ => null
            };
        }
        catch { return null; }   // freed Godot objects throw from getters
    }

    internal static object? GetPath(object? root, params string[] path)
    {
        var cur = root;
        foreach (var seg in path) { cur = Get(cur, seg); if (cur is null) return null; }
        return cur;
    }

    /// <summary>ModelId → the bare entry string ("STRIKE_IRONCLAD"), matching Id.Entry.</summary>
    internal static string? EntryOf(object? modelId)
    {
        if (modelId is null) return null;
        if (Get(modelId, "Entry") is string e) return e;
        var s = modelId.ToString();
        if (string.IsNullOrEmpty(s)) return null;
        // Fall back to the last path segment of "Category/ENTRY" or "Category.ENTRY".
        var i = s!.LastIndexOfAny(new[] { '/', '.', ':' });
        return i >= 0 && i < s.Length - 1 ? s[(i + 1)..] : s;
    }

    // ── sts2.pileState ───────────────────────────────────────────────────────

    /// <summary>Mirrors Sts2Card in src/shared/types.ts.</summary>
    internal static Dictionary<string, object?> Card(CardModel c) => new()
    {
        ["id"] = EntryOf(Get(c, "Id")),
        ["upgradeLevel"] = c.CurrentUpgradeLevel,
        ["enchantment"] = EntryOf(GetPath(c, "Enchantment", "Id")),
        // The reader derives isPermanent from `_deckVersion != null` — a card that
        // belongs to the run deck rather than being generated mid-combat.
        ["isPermanent"] = Get(c, "DeckVersion") is not null,
        // hasBeenCycled is reader-side bookkeeping (cards seen leaving hand). We
        // reproduce it here from the same signal so the shape matches.
        ["hasBeenCycled"] = Cycled.Contains(RuntimeHelpers_GetId(c)),
        ["cost"] = SafeInt(() => c.EnergyCost?.GetResolved()),
        // These two are non-public on CardModel — reach them via the null-safe helper.
        ["defaultCost"] = Get(c, "CanonicalEnergyCost") as int?,
        ["costsX"] = Get(c, "HasEnergyCostX") as bool? ?? false
    };

    private static int? SafeInt(Func<int?> f) { try { return f(); } catch { return null; } }

    private static readonly HashSet<int> Cycled = new();
    private static int RuntimeHelpers_GetId(object o) =>
        System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(o);

    /// <summary>Track cards that have passed through draw/discard, like the reader does.</summary>
    private static void MarkCycled(IEnumerable<CardModel> cards)
    {
        foreach (var c in cards) Cycled.Add(RuntimeHelpers_GetId(c));
    }

    internal static void ResetCombatState() => Cycled.Clear();

    internal static Dictionary<string, object?> PileState(PlayerCombatState? pcs)
    {
        if (pcs is null)
            return new() { ["draw"] = Array.Empty<object>(), ["hand"] = Array.Empty<object>(), ["discard"] = Array.Empty<object>() };

        var draw = pcs.DrawPile?.Cards?.ToList() ?? new List<CardModel>();
        var discard = pcs.DiscardPile?.Cards?.ToList() ?? new List<CardModel>();
        var hand = pcs.Hand?.Cards?.ToList() ?? new List<CardModel>();
        var exhaust = pcs.ExhaustPile?.Cards?.ToList() ?? new List<CardModel>();

        MarkCycled(draw);
        MarkCycled(discard);

        return new()
        {
            ["draw"] = draw.Select(Card).ToList(),
            ["hand"] = hand.Select(Card).ToList(),
            ["discard"] = discard.Select(Card).ToList(),
            // Extra vs. the legacy reader — the exhaust pile it never read. Harmless
            // additive field; the comparer ignores keys the primary doesn't emit.
            ["exhaust"] = exhaust.Select(Card).ToList()
        };
    }

    // ── sts2.enemiesState ────────────────────────────────────────────────────

    internal static Dictionary<string, object?> EnemiesState(CombatState? cs)
    {
        if (cs is null)
            return new() { ["enemies"] = Array.Empty<object>(), ["isCombatInProgress"] = false, ["currentSide"] = 1 };

        var enemies = new List<object>();
        foreach (var e in cs.Enemies ?? (IReadOnlyList<MegaCrit.Sts2.Core.Entities.Creatures.Creature>)Array.Empty<MegaCrit.Sts2.Core.Entities.Creatures.Creature>())
        {
            if (e is null) continue;
            if (Get(e, "CurrentHp") is int hp && hp <= 0) continue;   // reader skips dead
            enemies.Add(new Dictionary<string, object?>
            {
                ["name"] = Get(e, "Name") as string,
                ["intents"] = Intents(e)
            });
        }

        return new()
        {
            ["enemies"] = enemies,
            ["isCombatInProgress"] = CombatManager.Instance?.IsInProgress ?? false,
            ["currentSide"] = (int)Convert.ToInt32(Get(cs, "CurrentSide") ?? 1)
        };
    }

    /// <summary>
    /// Mirrors Sts2Intent { type, valueLabel }. The reader read the intent node's
    /// class name + its rendered label; here we read the model directly:
    /// creature's current move → Intents → IntentType + GetIntentLabel().
    /// </summary>
    private static List<object> Intents(object creature)
    {
        var result = new List<object>();
        // The current move lives on the creature's move state machine. Probe the
        // known member names so a rename degrades to "no intents" rather than throwing.
        object? move = Get(creature, "NextMove") ?? Get(creature, "CurrentMove")
                       ?? GetPath(creature, "MoveStateMachine", "CurrentState")
                       ?? GetPath(creature, "StateMachine", "CurrentState");
        if (Get(move, "Intents") is not System.Collections.IEnumerable intents) return result;

        foreach (var intent in intents)
        {
            if (intent is null) continue;
            string type = Get(intent, "IntentType")?.ToString() ?? intent.GetType().Name;
            string label = "";
            try
            {
                var m = intent.GetType().GetMethod("GetIntentLabel");
                if (m is not null)
                {
                    var targets = Get(creature, "CombatState") is { } st ? Get(st, "PlayerCreatures") : null;
                    var loc = m.Invoke(intent, new[] { targets, creature });
                    label = Get(loc, "Text") as string
                            ?? loc?.GetType().GetMethod("GetFormattedText")?.Invoke(loc, null) as string
                            ?? loc?.ToString() ?? "";
                }
            }
            catch { /* label is best-effort */ }

            result.Add(new Dictionary<string, object?>
            {
                // The reader emitted the fully-qualified node class name and matched
                // with endsWith(); keep the suffix convention so its parser works.
                ["type"] = type.EndsWith("Intent") ? type : type + "Intent",
                ["valueLabel"] = label
            });
        }
        return result;
    }

    // ── sts2.nGameState ──────────────────────────────────────────────────────

    /// <summary>Room class name → the reader's lowercase room-type vocabulary.</summary>
    private static string? RoomType(AbstractRoom? room) => room?.GetType().Name switch
    {
        null => null,
        "CombatRoom" => "combat",
        "MerchantRoom" => "merchant",
        "EventRoom" => "event",
        "RestSiteRoom" or "RestRoom" => "rest",
        "TreasureRoom" => "treasure",
        var n => n.Replace("Room", "").ToLowerInvariant()
    };

    internal static Dictionary<string, object?> NGameState(RunState? run)
    {
        var room = run?.CurrentRoom;
        var player = run?.Players is { Count: > 0 } ps ? ps[0] : null;
        return new()
        {
            ["room"] = RoomType(room) is { } rt ? new Dictionary<string, object?> { ["type"] = rt } : null,
            ["isPeekButtonVisible"] = false,
            ["isPeeking"] = false,
            ["capstoneScreen"] = false,
            ["isSubMenuOpen"] = false,
            ["isMapOpen"] = false,
            ["isTraveling"] = false,
            ["isPreviewContainerOpen"] = false,
            ["isInspectCardScreenOpen"] = false,
            ["isInspectRelicScreenOpen"] = false,
            ["isGameOver"] = run?.IsGameOver ?? false,
            ["currentActIndex"] = run?.CurrentActIndex ?? 0,
            ["localPlayer"] = CharacterId(player) is { } cid
                ? new Dictionary<string, object?> { ["characterId"] = cid }
                : null
        };
    }

    private static string? CharacterId(Player? p) =>
        EntryOf(GetPath(p, "Character", "Id")) ?? EntryOf(GetPath(p, "CharacterModel", "Id"));
}
