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
public static class Snapshot
{
    // ── null-safe reflection, for members whose exact shape varies by build ──
    private static readonly Dictionary<(Type, string), MemberInfo?> Cache = new();

    /// <summary>Field or property by name, walking the full inheritance chain.</summary>
    public static object? Get(object? src, string name)
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

    public static object? GetPath(object? root, params string[] path)
    {
        var cur = root;
        foreach (var seg in path) { cur = Get(cur, seg); if (cur is null) return null; }
        return cur;
    }

    /// <summary>ModelId → the bare entry string ("STRIKE_IRONCLAD"), matching Id.Entry.</summary>
    public static string? EntryOf(object? modelId)
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
    public static Dictionary<string, object?> Card(CardModel c) => new()
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

    public static void ResetCombatState() => Cycled.Clear();

    public static Dictionary<string, object?> PileState(PlayerCombatState? pcs)
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

    public static Dictionary<string, object?> EnemiesState(CombatState? cs)
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

    /// <summary>
    /// Room class → the reader's lowercase vocabulary. Matches readNGameState()
    /// exactly, INCLUDING its 'other' catch-all — anything that isn't combat /
    /// merchant / event is reported as 'other', not a derived name.
    /// </summary>
    private static string? RoomType(AbstractRoom? room)
    {
        if (room is null) return null;
        var n = room.GetType().Name;
        if (n.EndsWith("CombatRoom")) return "combat";
        if (n.EndsWith("MerchantRoom")) return "merchant";
        if (n.EndsWith("EventRoom")) return "event";
        return "other";
    }

    /// <summary>
    /// Mirrors readNGameState(). The screen flags come from the same places the
    /// reader read them — GlobalUi (map / submenu stack / capstone / overlays) and
    /// NGame's inspect screens — via the null-safe helper so a rename degrades to
    /// `false` instead of throwing inside the game's frame loop.
    /// </summary>
    public static Dictionary<string, object?> NGameState(RunState? run)
    {
        var room = run?.CurrentRoom;
        var player = run?.Players is { Count: > 0 } ps ? ps[0] : null;

        // NRun.Instance.GlobalUi — the reader's source for most screen flags.
        object? globalUi = GetPath(RunNode(), "GlobalUi");
        object? nGame = NGameNode();

        return new()
        {
            ["room"] = RoomType(room) is { } rt ? new Dictionary<string, object?> { ["type"] = rt } : null,
            ["isPeekButtonVisible"] = Flag(GetPath(globalUi, "PeekButton", "Visible")),
            ["isPeeking"] = Flag(GetPath(globalUi, "PeekButton", "IsPeeking")),
            ["capstoneScreen"] = GetPath(globalUi, "CapstoneContainer", "CurrentCapstoneScreen") is not null,
            ["isSubMenuOpen"] = SubMenuOpen(globalUi),
            ["isMapOpen"] = Flag(GetPath(globalUi, "MapScreen", "IsOpen")),
            ["isTraveling"] = Flag(GetPath(globalUi, "MapScreen", "IsTraveling")),
            ["isPreviewContainerOpen"] = Flag(GetPath(globalUi, "PreviewContainer", "Visible")),
            ["isInspectCardScreenOpen"] = Flag(GetPath(nGame, "InspectCardScreen", "Visible")),
            ["isInspectRelicScreenOpen"] = Flag(GetPath(nGame, "InspectRelicScreen", "Visible")),
            ["isGameOver"] = run?.IsGameOver ?? false,
            ["currentActIndex"] = run?.CurrentActIndex ?? 0,
            ["localPlayer"] = CharacterId(player) is { } cid
                ? new Dictionary<string, object?> { ["characterId"] = cid }
                : null
        };
    }

    private static bool Flag(object? v) => v as bool? ?? false;

    /// <summary>Reader equivalent: globalUi.SubmenuStack.Stack._submenus.count > 0.</summary>
    private static bool SubMenuOpen(object? globalUi)
    {
        var submenus = GetPath(globalUi, "SubmenuStack", "Stack", "_submenus");
        if (Get(submenus, "Count") is int c) return c > 0;
        if (submenus is System.Collections.ICollection col) return col.Count > 0;
        return false;
    }

    // Static singletons, resolved reflectively so this file needs no Godot import.
    private static object? RunNode() =>
        Type.GetType("MegaCrit.Sts2.Core.Nodes.NRun, sts2")
            ?.GetProperty("Instance")?.GetValue(null);

    private static object? NGameNode() =>
        Type.GetType("MegaCrit.Sts2.Core.Nodes.NGame, sts2")
            ?.GetProperty("Instance")?.GetValue(null);

    private static string? CharacterId(Player? p) =>
        EntryOf(GetPath(p, "Character", "Id")) ?? EntryOf(GetPath(p, "CharacterModel", "Id"));
}
