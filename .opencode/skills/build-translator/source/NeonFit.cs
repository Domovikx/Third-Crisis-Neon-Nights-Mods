using System;
using System.Collections.Generic;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace NeonTranslatorDX
{
    // Label typography + fitting (2026-11-25).
    //
    // Two rules, applied in this order:
    //   1. typography: CJK text gets a slightly larger size and wider line
    //      (fonts/typography.json; ideographs look smaller than Latin at the
    //      same point size);
    //   2. fitting: translated labels are longer than English ones ("Загрузить
    //      файл сохранения" vs "Load Save File", Chinese is ~1.0 em per glyph),
    //      so if the scaled text still overflows the fixed-width plate we shrink
    //      it step by step — never below 60% of the AUTHORED size, never by
    //      cutting the text.
    internal static class NeonFit
    {
        internal const float MinRatio = NeonFontCore.MinRatio;
        internal const float SafeWidth = NeonFontCore.SafeWidth;

        private sealed class Original
        {
            public int Size;
            public float LineSpacing;
            public float CharacterSpacing;
        }

        private static readonly Dictionary<int, Original> Originals = new Dictionary<int, Original>();

        private static Original Remember(int id, int size, float lineSpacing, float characterSpacing)
        {
            Original o;
            if (Originals.TryGetValue(id, out o) && o.Size > 0) return o;
            o = new Original
            {
                Size = size > 0 ? size : 1,
                LineSpacing = lineSpacing,
                CharacterSpacing = characterSpacing,
            };
            Originals[id] = o;
            return o;
        }

        /// Typography for a TMP label: CJK size/line always, the fit rule only
        /// for fixed-width plates (`allowFit`) — dialogue and centred labels
        /// wrap freely and must keep their authored size.
        internal static void ApplyTmp(TMP_Text text, string lang, bool allowFit, string englishOriginal)
        {
            if (text == null) return;
            try
            {
                int id = text.GetInstanceID();
                Original o = Remember(id, Mathf.RoundToInt(text.fontSize), text.lineSpacing, text.characterSpacing);
                RectTransform rt = text.rectTransform;
                if (rt == null) return;

                float scale = NeonTypography.ScaleFor(lang);
                float lineHeight = NeonTypography.LineHeightFor(lang);
                // Main-menu plates carry the game's height rhythm: scale × 1.068
                // and a global spacing that keeps the width at the English level.
                // CJK uses the configured scale ONLY (no extra menu factor), so
                // "final = EN size × scale" stays verifiable in the log.
                bool cjk = lang == "zh" || lang == "ja" || lang == "ko";
                float sizeScale = allowFit ? (cjk ? scale : scale * NeonFontCore.MenuSizeScale) : scale;
                int baseSize = NeonFontCore.ScaledSize(o.Size, sizeScale);
                text.fontSize = baseSize;
                text.lineSpacing = lineHeight > 1f ? (lineHeight - 1f) * 100f : o.LineSpacing;
                text.characterSpacing = allowFit ? NeonFontCore.MenuCharacterSpacing : o.CharacterSpacing;
                if (baseSize != o.Size) NeonTypography.LogSize(lang, o.Size, baseSize);

                if (!allowFit) return;
                float available = rt.rect.width;
                if (available <= 0f) return;
                Vector2 preferred = text.GetPreferredValues(text.text, 0f, 0f);

                // Reference = the GAME's own English label at the authored size
                // (measured with the component's original font before we touch
                // it). Never grow: a shorter translation simply fills less.
                // Fit rule: the PLATE is the limit (like the game's own
                // autofit). The English label is a reference for width parity,
                // not a target to squeeze towards: short RU words are wider
                // than short EN ones, and forcing equal width would shrink the
                // label below the game's size and break the rhythm.
                int target = NeonFontCore.FitSize(preferred.x, available, baseSize, NeonFontCore.MinSize(o.Size));
                if (target > baseSize) target = baseSize;

                string fitState = target < baseSize ? "shrunk" : "ok";
                string enRef = "";
                if (!string.IsNullOrEmpty(englishOriginal) && englishOriginal != text.text)
                {
                    Vector2 en = text.GetPreferredValues(englishOriginal, 0f, 0f);
                    if (en.x > 0f)
                        enRef = " enW=" + Mathf.RoundToInt(en.x) + " ruW=" + Mathf.RoundToInt(preferred.x)
                            + " d=" + Mathf.RoundToInt((preferred.x / en.x - 1f) * 100f) + "%";
                }
                TranslatorPlugin.Log("size en=" + o.Size + " " + lang + "=" + baseSize
                    + " (x" + NeonTypography.ScaleFor(lang).ToString("0.00") + ") fit=" + fitState
                    + (target < o.Size ? " fit shrunk below baseline" : "")
                    + enRef + " [" + Trim(text.text) + "]");
                if (target != baseSize)
                {
                    text.fontSize = target;
                    TranslatorPlugin.Log("Fit: ['" + Trim(text.text) + "'] " + baseSize + "->" + target
                        + " (" + Mathf.RoundToInt(preferred.x) + ">" + Mathf.RoundToInt(available) + ")");
                }
            }
            catch (Exception ex) { TranslatorPlugin.Log("Fit: tmp error - " + ex.Message); }
        }

        /// Same rules for legacy UGUI Text (language panel rows).
        internal static void ApplyLegacy(Text text, string lang)
        {
            if (text == null) return;
            try
            {
                int id = text.GetInstanceID();
                Original o = Remember(id, text.fontSize, 1f, 0f);
                RectTransform rt = text.rectTransform;
                if (rt == null) return;

                int baseSize = NeonFontCore.ScaledSize(o.Size, NeonTypography.ScaleFor(lang));
                text.fontSize = baseSize;
                if (baseSize != o.Size) NeonTypography.LogSize(lang, o.Size, baseSize);

                float available = rt.rect.width;
                if (available <= 0f) return;
                int target = NeonFontCore.FitSize(text.preferredWidth, available, baseSize, NeonFontCore.MinSize(o.Size));
                if (target != baseSize) text.fontSize = target;
            }
            catch { }
        }

        private static string Trim(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            s = s.Replace("\n", " ");
            return s.Length <= 40 ? s : s.Substring(0, 40) + "...";
        }
    }
}
