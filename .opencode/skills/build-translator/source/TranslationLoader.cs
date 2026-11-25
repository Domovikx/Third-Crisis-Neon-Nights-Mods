using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace NeonTranslatorDX
{
    internal static class TranslationLoader
    {
        private static Dictionary<string, string> _translations;
        private static HashSet<string> _allKeys;
        private static object _lock = new object();
        public static string LoadedSource = "";
        private static string _managedDir = "";
        private static string _gameDir = "";

        public static Dictionary<string, string> Load(string managedDir, string gameDir, string lang)
        {
            lock (_lock)
            {
                if (_translations != null)
                    return _translations;

                _managedDir = managedDir;
                _gameDir = gameDir;
                return LoadInternal(lang);
            }
        }

        public static Dictionary<string, string> Reload(string lang)
        {
            lock (_lock)
            {
                _translations = null;
                _allKeys = null;
                return LoadInternal(lang);
            }
        }

        private static Dictionary<string, string> LoadInternal(string lang)
        {
            lock (_lock)
            {
                if (_translations != null)
                    return _translations;

                _translations = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                _allKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

                // English is the game's native language: no patch, empty dictionary.
                if (lang == "en")
                {
                    LoadedSource = "(en: native, no patch)";
                    return _translations;
                }

                // Primary: single compiled dictionary (built by po2dat.py from PO files).
                string dat = Path.Combine(_managedDir, "patch_" + lang + ".dat");
                if (!File.Exists(dat) && lang != "ru")
                    dat = Path.Combine(_managedDir, "patch_ru.dat");
                if (File.Exists(dat))
                {
                    ParseDatFile(dat);
                    LoadedSource = dat;
                    return _translations;
                }

                // Last resort: legacy YAML tree (to be removed once .dat is proven).
                string legacyDir = Path.Combine(_gameDir, "translations");
                if (Directory.Exists(legacyDir))
                {
                    string[] files = Directory.GetFiles(legacyDir, "*.yaml", SearchOption.AllDirectories);
                    Array.Sort(files);
                    foreach (string filePath in files)
                    {
                        try
                        {
                            ParseYamlFile(filePath);
                        }
                        catch
                        {
                            // skip corrupt files
                        }
                    }
                    LoadedSource = legacyDir;
                }

                return _translations;
            }
        }

        private static void ParseDatFile(string filePath)
        {
            // One JSON object per line: {"t":"...","x":"...","r":"...","rt":"..."}.
            // Values carry \" and \\ escapes only (json.dumps, ensure_ascii=False).
            foreach (string rawLine in File.ReadLines(filePath))
            {
                if (string.IsNullOrEmpty(rawLine))
                    continue;
                try
                {
                    ProcessEntry(ParseDatLine(rawLine));
                }
                catch
                {
                    // skip corrupt lines
                }
            }
        }

        private static string MapKey(string shortKey)
        {
            if (shortKey == "t") return "text";
            if (shortKey == "x") return "translation";
            if (shortKey == "r") return "rich_text";
            if (shortKey == "rt") return "rich_translation";
            return null;
        }

        private static int FindStringEnd(string s, int from)
        {
            int i = from;
            while (i < s.Length)
            {
                if (s[i] == '\\')
                {
                    i += 2;
                    continue;
                }
                if (s[i] == '"')
                    return i;
                i++;
            }
            return -1;
        }

        private static string UnescapeDat(string s)
        {
            return s.Replace("\\\"", "\"").Replace("\\\\", "\\");
        }

        private static Dictionary<string, string> ParseDatLine(string line)
        {
            var fields = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            int i = 0;
            while (i < line.Length)
            {
                int k0 = line.IndexOf('"', i);
                if (k0 < 0) break;
                int k1 = FindStringEnd(line, k0 + 1);
                if (k1 < 0) break;
                string mapped = MapKey(line.Substring(k0 + 1, k1 - k0 - 1));
                int colon = line.IndexOf(':', k1 + 1);
                if (colon < 0) break;
                int v0 = line.IndexOf('"', colon + 1);
                if (v0 < 0) break;
                int v1 = FindStringEnd(line, v0 + 1);
                if (v1 < 0) break;
                if (mapped != null)
                    fields[mapped] = UnescapeDat(line.Substring(v0 + 1, v1 - v0 - 1));
                i = v1 + 1;
            }
            return fields;
        }

        private static void ParseYamlFile(string filePath)
        {
            string[] lines = File.ReadAllLines(filePath);
            var fields = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            bool inEntry = false;

            foreach (string rawLine in lines)
            {
                string trimmed = rawLine.Trim();

                // Skip comments and blank lines
                if (trimmed.Length == 0 || trimmed[0] == '#')
                {
                    if (inEntry)
                    {
                        ProcessEntry(fields);
                        fields.Clear();
                        inEntry = false;
                    }
                    continue;
                }

                // Detect entry start: "- key: value"
                if (trimmed.StartsWith("- "))
                {
                    if (inEntry)
                    {
                        ProcessEntry(fields);
                        fields.Clear();
                    }
                    inEntry = true;

                    // Parse key:value after "- "
                    string rest = trimmed.Substring(2).Trim();
                    ParseField(rest, fields);
                    continue;
                }

                // Continuation line (indented with 2+ spaces)
                if (inEntry && rawLine.StartsWith("  "))
                {
                    ParseField(trimmed, fields);
                }
            }

            // Last entry
            if (inEntry)
            {
                ProcessEntry(fields);
            }
        }

        private static void ParseField(string text, Dictionary<string, string> fields)
        {
            // Format: key: "value"  or  key: 'value'
            int colon = text.IndexOf(':');
            if (colon < 0) return;

            string key = text.Substring(0, colon).Trim();
            if (string.IsNullOrEmpty(key)) return;

            string rest = text.Substring(colon + 1).Trim();
            if (rest.Length < 2) return;

            char quote = rest[0];
            if (quote != '"' && quote != '\'') return;

            // Find closing quote respecting escaping
            int i = 1;
            while (i < rest.Length)
            {
                if (rest[i] == '\\')
                {
                    i += 2;
                    continue;
                }
                if (rest[i] == quote)
                {
                    string val = rest.Substring(1, i - 1);
                    val = val.Replace("\\\"", "\"").Replace("\\\\", "\\");
                    fields[key] = val;
                    return;
                }
                i++;
            }
        }

        private static readonly Regex _richTagRx = new Regex("<[^>]+>", RegexOptions.Compiled);

        private static void ProcessEntry(Dictionary<string, string> fields)
        {
            string text = GetField(fields, "text");
            if (string.IsNullOrEmpty(text))
                return;

            // Skip if already processed (defense-in-depth against duplicate keys)
            if (_allKeys.Contains(text))
                return;

            string translation = GetField(fields, "translation");
            string richText = GetField(fields, "rich_text");
            string richTranslation = GetField(fields, "rich_translation");

            // Auto-generate rich_translation from rich_text + translation when missing
            if (string.IsNullOrEmpty(richTranslation) && !string.IsNullOrEmpty(richText)
                && !string.IsNullOrEmpty(translation))
            {
                string plainFromRich = _richTagRx.Replace(richText, "");
                if (!string.IsNullOrEmpty(plainFromRich) && richText.Contains(plainFromRich))
                {
                    richTranslation = richText.Replace(plainFromRich, translation);
                }
            }

            // Best available: rich_translation > translation > rich_text > text
            string best = Coalesce(richTranslation, translation, richText, text);

            _allKeys.Add(text);
            if (!string.IsNullOrEmpty(best) && best != text)
            {
                _translations[text] = best;
            }
        }

        private static string GetField(Dictionary<string, string> fields, string key)
        {
            string val;
            if (fields.TryGetValue(key, out val))
                return val ?? "";
            return "";
        }

        private static string Coalesce(params string[] values)
        {
            foreach (string v in values)
            {
                if (!string.IsNullOrEmpty(v))
                    return v;
            }
            return "";
        }

        public static bool IsKnownKey(string key)
        {
            return _allKeys != null && _allKeys.Contains(key);
        }
    }
}
