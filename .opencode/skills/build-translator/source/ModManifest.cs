using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace NeonTranslatorDX
{
    /// <summary>
    /// install-manifest.json для установки, распакованной вручную (без exe и
    /// скриптов). Создаётся при первом запуске игры; если манифест уже есть и
    /// описывает текущую сборку DLL — не трогается (манифест менеджера с
    /// версией пакета имеет приоритет).
    ///
    /// Пересборка нужна после «обновления распаковкой»: DLL заменена, а старый
    /// манифест описывает прежние хэши. Признак — sha256 самой DLL в манифесте.
    ///
    /// Только BCL: файл компилируется и отдельным тестовым harness'ом (E2E).
    /// </summary>
    internal static class ModManifest
    {
        internal const string FileName = "install-manifest.json";
        private const string RuntimeDll = "NeonTranslatorDX.dll";

        /// <summary>Файлы рантайма, которых не должно быть в манифесте.</summary>
        private static readonly string[] Skipped =
        {
            FileName,
            "NeonTranslatorDX.log",
            "dump_GUIDictionary.json",
            "nolog.txt",
        };

        /// <summary>
        /// Создать/обновить манифест при необходимости.
        /// Возвращает строку для лога или null, если манифест уже актуален.
        /// </summary>
        internal static string Ensure(string modDir, string gameDir)
        {
            try
            {
                string dllPath = Path.Combine(modDir, RuntimeDll);
                if (!File.Exists(dllPath)) return null;

                string dllSha = Sha256(dllPath);
                string path = Path.Combine(modDir, FileName);
                if (File.Exists(path))
                {
                    string existing = File.ReadAllText(path);
                    if (ManifestDescribesDll(existing, dllSha))
                        return null;
                }

                Write(path, modDir, gameDir);
                return "Manifest: written " + path;
            }
            catch (Exception ex)
            {
                return "Manifest: error - " + ex.Message;
            }
        }

        /// <summary>
        /// Манифест уже описывает ЭТУ сборку DLL (значит, менеджер или прошлый
        /// запуск его актуализировали). Не парсим JSON целиком: нужен один хэш.
        /// </summary>
        private static bool ManifestDescribesDll(string json, string dllSha)
        {
            Match match = Regex.Match(
                json,
                "\"path\"\\s*:\\s*\"mods/NeonTranslatorDX/NeonTranslatorDX.dll\"[\\s\\S]*?\"sha256\"\\s*:\\s*\"([0-9a-fA-F]{64})\"",
                RegexOptions.None);
            return match.Success
                && string.Equals(match.Groups[1].Value, dllSha, StringComparison.OrdinalIgnoreCase);
        }

        private static void Write(string path, string modDir, string gameDir)
        {
            string lang = "en";
            try
            {
                string langFile = Path.Combine(modDir, "active_lang.txt");
                if (File.Exists(langFile))
                {
                    string value = File.ReadAllText(langFile).Trim().ToLowerInvariant();
                    if (value.Length == 2) lang = value;
                }
            }
            catch { }

            List<string> files = new List<string>();
            string loader = Path.Combine(gameDir, "dwmapi.dll");
            if (File.Exists(loader)) files.Add("dwmapi.dll");
            foreach (string file in Directory.GetFiles(modDir, "*", SearchOption.AllDirectories))
            {
                string name = Path.GetFileName(file);
                if (Array.IndexOf(Skipped, name) >= 0) continue;
                if (name.EndsWith(".part", StringComparison.OrdinalIgnoreCase)) continue;
                files.Add(RelativePath(gameDir, file));
            }
            files.Sort(StringComparer.OrdinalIgnoreCase);

            StringBuilder json = new StringBuilder();
            json.Append("{\n");
            json.Append("  \"version\": 1,\n");
            json.Append("  \"lang\": \"").Append(Escape(lang)).Append("\",\n");
            json.Append("  \"installedAt\": \"")
                .Append(DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture))
                .Append("\",\n");
            json.Append("  \"files\": [\n");
            for (int i = 0; i < files.Count; i++)
            {
                string rel = files[i];
                string abs = Path.Combine(gameDir, rel.Replace('/', Path.DirectorySeparatorChar));
                FileInfo info = new FileInfo(abs);
                json.Append("    {\"path\": \"").Append(Escape(rel)).Append("\", \"size\": ")
                    .Append(info.Length.ToString(CultureInfo.InvariantCulture))
                    .Append(", \"sha256\": \"").Append(Sha256(abs)).Append("\"}");
                json.Append(i + 1 < files.Count ? ",\n" : "\n");
            }
            json.Append("  ]\n}\n");

            string part = path + ".part";
            try
            {
                File.WriteAllText(part, json.ToString(), new UTF8Encoding(false));
                // Антивирус/сканер может кратко держать файл — 3 повтора.
                for (int attempt = 0; ; attempt++)
                {
                    try
                    {
                        if (File.Exists(path)) File.Replace(part, path, null, true);
                        else File.Move(part, path);
                        break;
                    }
                    catch (IOException)
                    {
                        if (attempt >= 3) throw;
                        Thread.Sleep(50);
                    }
                }
            }
            finally
            {
                try { if (File.Exists(part)) File.Delete(part); }
                catch { }
            }
        }

        private static string RelativePath(string root, string file)
        {
            string prefix = root.EndsWith(Path.DirectorySeparatorChar.ToString())
                ? root
                : root + Path.DirectorySeparatorChar;
            string rel = file.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
                ? file.Substring(prefix.Length)
                : file;
            return rel.Replace('\\', '/');
        }

        private static string Escape(string value)
        {
            return value.Replace("\\", "\\\\").Replace("\"", "\\\"");
        }

        private static string Sha256(string path)
        {
            using (FileStream stream = File.OpenRead(path))
            using (SHA256 sha = SHA256.Create())
            {
                byte[] hash = sha.ComputeHash(stream);
                StringBuilder hex = new StringBuilder(hash.Length * 2);
                foreach (byte b in hash) hex.Append(b.ToString("x2", CultureInfo.InvariantCulture));
                return hex.ToString();
            }
        }
    }
}
