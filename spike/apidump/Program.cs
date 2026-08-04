using System.Reflection;

class Program {
  const BindingFlags F = BindingFlags.Public|BindingFlags.NonPublic|BindingFlags.Instance|BindingFlags.Static|BindingFlags.DeclaredOnly;
  static string Sig(Type t){
    if(!t.IsGenericType) return t.Name;
    return t.Name.Split('`')[0]+"<"+string.Join(",",t.GetGenericArguments().Select(Sig))+">";
  }
  static int Main(string[] args){
    string dir = @"C:\Program Files (x86)\Steam\steamapps\common\Slay the Spire 2\data_sts2_windows_x86_64";
    var res = new PathAssemblyResolver(Directory.GetFiles(dir,"*.dll"));
    using var mlc = new MetadataLoadContext(res, "System.Private.CoreLib");
    var asm = mlc.LoadFromAssemblyPath(Path.Combine(dir,"sts2.dll"));
    var types = asm.GetTypes();
    foreach (var q in args){
      foreach (var t in types.Where(t => t.FullName!=null && (t.FullName.EndsWith("."+q) || t.FullName==q))){
        Console.WriteLine($"### {t.FullName}   base={t.BaseType?.Name}  ifaces={string.Join(",",t.GetInterfaces().Select(i=>i.Name))}");
        foreach (var p in t.GetProperties(F)) Console.WriteLine($"  P {Sig(p.PropertyType)} {p.Name}");
        foreach (var f in t.GetFields(F))     Console.WriteLine($"  F {Sig(f.FieldType)} {f.Name}");
        foreach (var m in t.GetMethods(F).Where(m=>!m.IsSpecialName))
          Console.WriteLine($"  M {Sig(m.ReturnType)} {m.Name}({string.Join(", ", m.GetParameters().Select(x=>Sig(x.ParameterType)+" "+x.Name))})");
        Console.WriteLine();
      }
    }
    return 0;
  }
}
