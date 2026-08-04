using Godot;

namespace SpectraBridge;

/// <summary>
/// Raw on-screen item discovery — the mod-side equivalent of readVisibleItems()
/// in the proprietary reader (src/main/scry/readers.ts).
///
/// We deliberately emit the RAW contract (source + items with screen-fraction
/// anchors) and NOT the enriched panels: the Electron provider owns Codex
/// enrichment, so keeping that split preserves the existing advice pipeline.
///
/// MUST be called on the Godot main thread — it touches the scene tree.
/// </summary>
public static class Layout
{
    /// <summary>Matches RawVisibleItems { source, items[] }.</summary>
    public static Dictionary<string, object?> VisibleItems()
    {
        var none = new Dictionary<string, object?>
        {
            ["source"] = "none",
            ["items"] = new List<object>()
        };

        if (Engine.GetMainLoop() is not SceneTree tree) return none;
        Node? root = tree.Root;
        if (root is null || !GodotObject.IsInstanceValid(root)) return none;

        Vector2 screen = tree.Root.Size;
        if (screen.X <= 0 || screen.Y <= 0) return none;

        // 1) Card-selection overlays. Distinguishing these is what the legacy
        //    reader got WRONG (everything was labelled 'cardReward'); keep the
        //    corrected taxonomy — only reward/chooseACard are deck-additive.
        foreach (var (typeName, source) in new[]
                 {
                     ("NCardRewardSelectionScreen", "cardReward"),
                     ("NChooseACardSelectionScreen", "chooseACard"),
                     ("NCardGridSelectionScreen", "grid"),
                 })
        {
            var screenNode = FindByTypeName(root, typeName);
            if (screenNode is null) continue;
            var items = CardHolders(screenNode, screen, isGrid: source == "grid");
            if (items.Count > 0)
                return new Dictionary<string, object?> { ["source"] = source, ["items"] = items };
        }

        // 2) Merchant stock.
        var merchant = FindByTypeName(root, "NMerchantRoom");
        if (merchant is not null)
        {
            var items = MerchantItems(merchant, screen);
            return new Dictionary<string, object?> { ["source"] = "merchant", ["items"] = items };
        }

        return none;
    }

    // ── discovery helpers ────────────────────────────────────────────────────

    /// <summary>Depth-first search for the first visible node whose type name matches.</summary>
    private static Node? FindByTypeName(Node node, string typeName)
    {
        if (!GodotObject.IsInstanceValid(node)) return null;
        if (node.GetType().Name == typeName)
        {
            if (node is not CanvasItem ci || ci.Visible) return node;
        }
        foreach (var child in node.GetChildren())
        {
            var hit = FindByTypeName(child, typeName);
            if (hit is not null) return hit;
        }
        return null;
    }

    private static void CollectByTypeName(Node node, string typeName, List<Node> outList)
    {
        if (!GodotObject.IsInstanceValid(node)) return;
        if (node.GetType().Name == typeName) outList.Add(node);
        foreach (var child in node.GetChildren()) CollectByTypeName(child, typeName, outList);
    }

    /// <summary>
    /// Scene-tree child order is NOT visual order (focus reorders siblings), so
    /// sort by on-screen position — top-to-bottom, then left-to-right.
    /// </summary>
    private static List<Node> SortedByPosition(List<Node> nodes) =>
        nodes.OrderBy(n => n is Control c ? Math.Round(c.GlobalPosition.Y / 40) : 0)
             .ThenBy(n => n is Control c2 ? c2.GlobalPosition.X : 0)
             .ToList();

    // ── item builders ────────────────────────────────────────────────────────

    private static List<object> CardHolders(Node screenNode, Vector2 screen, bool isGrid)
    {
        var holders = new List<Node>();
        CollectByTypeName(screenNode, "NGridCardHolder", holders);
        CollectByTypeName(screenNode, "NCardHolder", holders);

        var items = new List<object>();
        foreach (var h in SortedByPosition(holders))
        {
            if (h is not Control ctl || !GodotObject.IsInstanceValid(ctl) || !ctl.Visible) continue;
            // Grid screens carry not-yet-laid-out holders at local [0,0]; skip them
            // so their tips don't stack in the corner (matches the reader's fix).
            if (isGrid && ctl.Position is { X: 0, Y: 0 }) continue;

            var card = Snapshot.Get(h, "_baseCard") ?? Snapshot.Get(h, "CardModel");
            items.Add(Item("card", Snapshot.EntryOf(Snapshot.Get(card, "Id")),
                           null, Hovered(h), ctl, screen));
        }
        return items;
    }

    private static List<object> MerchantItems(Node merchant, Vector2 screen)
    {
        var items = new List<object>();
        foreach (var (typeName, kind) in new[]
                 {
                     ("NMerchantCard", "card"),
                     ("NMerchantRelic", "relic"),
                     ("NMerchantPotion", "potion"),
                 })
        {
            var slots = new List<Node>();
            CollectByTypeName(merchant, typeName, slots);
            foreach (var s in SortedByPosition(slots))
            {
                if (s is not Control ctl || !GodotObject.IsInstanceValid(ctl) || !ctl.Visible) continue;
                object? model = Snapshot.Get(s, "CardModel") ?? Snapshot.Get(s, "Model")
                                ?? Snapshot.Get(s, "RelicModel") ?? Snapshot.Get(s, "PotionModel");
                int? cost = Snapshot.Get(s, "Cost") as int?;
                items.Add(Item(kind, Snapshot.EntryOf(Snapshot.Get(model, "Id")),
                               cost, Hovered(s), ctl, screen));
            }
        }
        return items;
    }

    private static bool Hovered(Node n) =>
        Snapshot.Get(n, "_isHovered") as bool? ?? Snapshot.Get(n, "IsHovered") as bool? ?? false;

    /// <summary>
    /// Matches RawItem. cx/cy are the item's CENTRE and w/h its size, both as
    /// fractions of the game window — exactly what the overlay anchors tips to.
    /// </summary>
    private static Dictionary<string, object?> Item(
        string kind, string? id, int? cost, bool hovered, Control ctl, Vector2 screen)
    {
        Vector2 pos = ctl.GlobalPosition;
        Vector2 size = ctl.Size;
        var d = new Dictionary<string, object?>
        {
            ["kind"] = kind,
            ["id"] = id,
            ["isHovered"] = hovered,
            ["cx"] = pos.X / screen.X,
            ["cy"] = pos.Y / screen.Y,
            ["w"] = size.X / screen.X,
            ["h"] = size.Y / screen.Y
        };
        if (cost.HasValue) d["cost"] = cost.Value;
        return d;
    }
}
