using System.Collections.Concurrent;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Godot;
using HarmonyLib;
using MegaCrit.Sts2.Core.Combat;
using MegaCrit.Sts2.Core.Logging;
using MegaCrit.Sts2.Core.Modding;
using MegaCrit.Sts2.Core.Entities.Players;
using MegaCrit.Sts2.Core.Rooms;
using MegaCrit.Sts2.Core.Runs;

namespace SpectraBridge;

[ModInitializer(nameof(Initialize))]
public static class ModEntry
{
    private const int Port = 15600;

    private static readonly ConcurrentQueue<Action> MainThreadQueue = new();
    private static readonly List<WebSocket> Sockets = new();
    private static HttpListener? _listener;

    public static void Initialize()
    {
        Log.Info("[SpectraBridge] initializing");

        // 1. Pump for marshalling work back onto Godot's main thread.
        var tree = (SceneTree)Engine.GetMainLoop();
        tree.Connect(SceneTree.SignalName.ProcessFrame, Callable.From(Pump));

        // 2. Harmony patches (optional - see HookPatches below).
        new Harmony("spectra.overlay.bridge").PatchAll(typeof(ModEntry).Assembly);

        // 3. Local HTTP + WebSocket server on a background thread.
        _listener = new HttpListener();
        _listener.Prefixes.Add($"http://127.0.0.1:{Port}/");
        _listener.Start();
        new Thread(ServerLoop) { IsBackground = true, Name = "SpectraBridge" }.Start();

        Log.Info($"[SpectraBridge] listening on http://127.0.0.1:{Port}/");
    }

    private static void Pump()
    {
        var n = 0;
        while (n++ < 32 && MainThreadQueue.TryDequeue(out var a))
        {
            try { a(); }
            catch (Exception e) { Log.Error($"[SpectraBridge] {e}"); }
        }
    }

    private static Task<T> OnMainThread<T>(Func<T> f)
    {
        var tcs = new TaskCompletionSource<T>();
        MainThreadQueue.Enqueue(() =>
        {
            try { tcs.SetResult(f()); }
            catch (Exception e) { tcs.SetException(e); }
        });
        return tcs.Task;
    }

    private static void ServerLoop()
    {
        while (_listener is { IsListening: true })
        {
            HttpListenerContext ctx;
            try { ctx = _listener.GetContext(); }
            catch { return; }

            if (ctx.Request.IsWebSocketRequest)
            {
                _ = HandleSocket(ctx);
                continue;
            }

            var json = OnMainThread(BuildState).GetAwaiter().GetResult();
            var bytes = Encoding.UTF8.GetBytes(json);
            ctx.Response.ContentType = "application/json";
            ctx.Response.OutputStream.Write(bytes, 0, bytes.Length);
            ctx.Response.Close();
        }
    }

    private static async Task HandleSocket(HttpListenerContext ctx)
    {
        var ws = (await ctx.AcceptWebSocketAsync(null)).WebSocket;
        lock (Sockets) Sockets.Add(ws);
        var buf = new byte[1024];
        try
        {
            while (ws.State == WebSocketState.Open)
                await ws.ReceiveAsync(new ArraySegment<byte>(buf), CancellationToken.None);
        }
        catch { /* client went away */ }
        finally { lock (Sockets) Sockets.Remove(ws); }
    }

    /// <summary>Push a state snapshot to every connected Electron client.</summary>
    internal static void Broadcast()
    {
        string json;
        try { json = BuildState(); }
        catch (Exception e) { Log.Error($"[SpectraBridge] {e}"); return; }

        var seg = new ArraySegment<byte>(Encoding.UTF8.GetBytes(json));
        lock (Sockets)
            foreach (var ws in Sockets.Where(s => s.State == WebSocketState.Open))
                _ = ws.SendAsync(seg, WebSocketMessageType.Text, true, CancellationToken.None);
    }

    /// <summary>
    /// Emits the SAME keyed snapshot shape the Electron app already consumes
    /// (src/shared/types.ts), so this mod is a drop-in replacement for the
    /// proprietary untapped-scry reader — no translation layer needed.
    ///
    /// MUST be called on the Godot main thread.
    /// </summary>
    private static string BuildState()
    {
        var o = new Dictionary<string, object?>();

        var inRun = RunManager.Instance?.IsInProgress ?? false;
        RunState? run = inRun ? RunManager.Instance!.DebugOnlyGetState() : null;
        Player? me = run?.Players is { Count: > 0 } ps ? ps[0] : null;

        var inCombat = run?.CurrentRoom is CombatRoom && (CombatManager.Instance?.IsInProgress ?? false);
        CombatState? cs = inCombat ? CombatManager.Instance!.DebugOnlyGetState() : null;
        if (!inCombat) Snapshot.ResetCombatState();

        o["sts2.nGameState"] = Snapshot.NGameState(run);
        o["sts2.pileState"] = Snapshot.PileState(inCombat ? me?.PlayerCombatState : null);
        o["sts2.enemiesState"] = Snapshot.EnemiesState(cs);
        // sts2.layoutState needs on-screen positions from the scene tree; tracked
        // separately (see SPIKE.md) — omitted rather than emitted wrong.

        o["_meta"] = new Dictionary<string, object?>
        {
            ["source"] = "SpectraBridge",
            ["inRun"] = inRun,
            ["inCombat"] = inCombat
        };
        return JsonSerializer.Serialize(o);
    }
}

/// <summary>Harmony hooks that fire a push whenever the run changes shape.</summary>
[HarmonyPatch]
public static class HookPatches
{
    [HarmonyPostfix]
    [HarmonyPatch(typeof(RunManager), nameof(RunManager.EnterRoom))]
    public static void AfterEnterRoom() => ModEntry.Broadcast();
}
