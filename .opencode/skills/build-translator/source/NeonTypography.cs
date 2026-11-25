using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text.RegularExpressions;

namespace NeonTranslatorDX
{
    // Typography policy read from the shipped `fonts/typography.json`
    // (source of truth: docs/fonts.md). CJK gets a slightly larger size and a
    // wider line; Latin/Cyrillic languages stay at 1.0.
    internal static class NeonTypography
    {
        internal struct Entry
        {
            public float Scale;
            public float LineHeight;
        }

        private static readonly Dictionary<string, Entry> Table =
            new Dictionary<string, Entry>(StringComparer.OrdinalIgnoreCase);
        private static readonly HashSet<string> LoggedSizes = new HashSet<string>();
        private static bool _loaded;
        private static string _source = "(built-in defaults)";

        private static readonly Regex EntryRx = new Regex(
            "\"([a-z]{2})\"\\s*:\\s*\\{\\s*\"scale\"\\s*:\\s*([0-9.]+)\\s*,\\s*\"lineHeight\"\\s*:\\s*([0-9.]+)",
            RegexOptions.Compiled);

        internal static void Configure(string dllDir)
        {
            if (_loaded) return;
            _loaded = true;
            try
            {
                string path = Path.Combine(dllDir, "fonts", "typography.json");
                if (!File.Exists(path))
                {
                    TranslatorPlugin.Log("typography: " + path + " missing, using built-in defaults");
                    return;
                }
                string text = File.ReadAllText(path);
                foreach (Match m in EntryRx.Matches(text))
                {
                    float scale;
                    float lineHeight;
                    if (!float.TryParse(m.Groups[2].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out scale)) continue;
                    if (!float.TryParse(m.Groups[3].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out lineHeight)) continue;
                    Table[m.Groups[1].Value] = new Entry { Scale = scale, LineHeight = lineHeight };
                }
                _source = Path.GetFileName(path);
                TranslatorPlugin.Log("typography: loaded " + Table.Count + " languages from " + _source);
            }
            catch (Exception ex)
            {
                TranslatorPlugin.Log("typography: read error - " + ex.Message);
            }
        }

        internal static float ScaleFor(string lang)
        {
            Entry e;
            if (lang != null && Table.TryGetValue(lang, out e) && e.Scale > 0f) return e.Scale;
            return NeonFontCore.ScaleFor(lang);
        }

        internal static float LineHeightFor(string lang)
        {
            Entry e;
            if (lang != null && Table.TryGetValue(lang, out e) && e.LineHeight > 0f) return e.LineHeight;
            return NeonFontCore.LineHeightFor(lang);
        }

        /// Summary line at font init: the chosen policy must be visible in E2E.
        internal static void LogPolicy(string lang)
        {
            Entry e;
            bool fromFile = lang != null && Table.TryGetValue(lang, out e);
            TranslatorPlugin.Log("typography: " + lang + " scale=" + F(ScaleFor(lang))
                + " lineHeight=" + F(LineHeightFor(lang))
                + " (" + (fromFile ? _source : "built-in") + ")");
        }

        /// One line per (language, authored size): base size -> CJK size.
        internal static void LogSize(string lang, int baseSize, int scaledSize)
        {
            string key = lang + "|" + baseSize;
            if (!LoggedSizes.Add(key)) return;
            if (scaledSize == baseSize) return;
            TranslatorPlugin.Log("typography: " + lang + " scale=" + F(ScaleFor(lang))
                + " size=" + baseSize + "->" + scaledSize);
        }

        private static string F(float v)
        {
            return v.ToString("0.00", CultureInfo.InvariantCulture);
        }
    }
}
