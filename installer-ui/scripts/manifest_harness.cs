// Тестовый harness E2E: запускает РЕАЛЬНЫЙ ModManifest.cs рантайма как
// консольную программу (файл не зависит от Unity). Компилируется csc вместе
// с .opencode/skills/build-translator/source/ModManifest.cs.
using System;
using System.IO;
using NeonTranslatorDX;

internal static class ManifestHarness
{
    private static int Main(string[] args)
    {
        if (args.Length < 2)
        {
            Console.Error.WriteLine("usage: ManifestHarness <modDir> <gameDir>");
            return 1;
        }
        string message = ModManifest.Ensure(args[0], args[1]);
        Console.WriteLine(message ?? "Manifest: up to date");
        string path = Path.Combine(args[0], ModManifest.FileName);
        if (!File.Exists(path))
        {
            Console.Error.WriteLine("manifest not created");
            return 1;
        }
        return 0;
    }
}
