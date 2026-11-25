using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace NeonTranslatorDX
{
    // CJK overlay (ja/zh/ko only, everything else untouched). Covers the main
    // menu AND the dialogue box: both use TMP fonts without CJK glyphs
    // (Orbitron / Roboto-Condensed_DialogueUI), and TMP_FontAsset.CreateFontAsset
    // returns null at runtime, so the TMP component keeps a space and a plain
    // UGUI Text CHILD shows the translation in a dynamic Noto font.
    // Why overlay instead of a TMP fallback: TMP_FontAsset.CreateFontAsset
    // returns null at runtime (TMP's SDF baker cannot see GDI
    // memory-registered fonts), while UGUI dynamic fonts ARE GDI-backed —
    // the switcher panel already renders CJK rows. So the TMP component keeps
    // a space and a plain UGUI Text CHILD shows the translation in Noto.
    // The overlay is a child of the TMP object itself (layout groups only
    // arrange direct children, so the menu layout is untouched).
    // Managed from PopulateAllText (TryOverlay on replace, owned skip) and
    // SetLanguage (ClearAll). Sweep only drops dead owners and non-CJK
    // leftovers — it never judges by text content (that flicker bug is gone).
    internal static class NeonCjkOverlay
    {
        private class Rec
        {
            public Component owner;
            public GameObject go;
            public Text label;
            public string orig;
            public string shown;
            public string lang;
        }

        private static readonly Dictionary<Component, Rec> _recs = new Dictionary<Component, Rec>();
        private static readonly Dictionary<string, Font> _fonts =
            new Dictionary<string, Font>(StringComparer.OrdinalIgnoreCase);

        internal static bool IsCjkLang(string lang)
        {
            // CJK = Chinese + Japanese + Korean.
            return lang == "zh" || lang == "ja" || lang == "ko";
        }

        internal static bool IsOwned(Component c)
        {
            if (c == null) return false;
            Rec r;
            if (!_recs.TryGetValue(c, out r)) return false;
            try { return r != null && r.go != null; }
            catch { return false; }
        }

        private static Font LangFont(string lang)
        {
            Font f;
            if (_fonts.TryGetValue(lang, out f) && f != null) return f;
            // ko ships no TTF: Noto Sans KR if the player has it, otherwise
            // stock Windows Malgun Gothic (full Hangul, no deploy needed).
            string[] families = lang == "ja" ? new string[] { "Noto Sans JP" }
                : lang == "zh" ? new string[] { "Noto Sans SC" }
                : new string[] { "Noto Sans KR", "Malgun Gothic" };
            string used = null;
            foreach (string fam in families)
            {
                try
                {
                    f = Font.CreateDynamicFontFromOSFont(fam, 32);
                    if (f != null) { used = fam; break; }
                }
                catch (Exception ex)
                {
                    TranslatorPlugin.Log("CJK: dyn font fail (" + fam + ") - " + ex.Message);
                }
            }
            _fonts[lang] = f;
            TranslatorPlugin.Log("CJK: overlay font " + lang + " = "
                + (f != null ? used + " / " + f.name : "null"));
            return f;
        }

        private static TextAnchor MapAlign(string s)
        {
            if (s == null) return TextAnchor.MiddleCenter;
            bool left = s.Contains("Left"), right = s.Contains("Right");
            bool top = s.Contains("Top"), bottom = s.Contains("Bottom") || s.Contains("Baseline");
            if (top && left) return TextAnchor.UpperLeft;
            if (top && right) return TextAnchor.UpperRight;
            if (top) return TextAnchor.UpperCenter;
            if (bottom && left) return TextAnchor.LowerLeft;
            if (bottom && right) return TextAnchor.LowerRight;
            if (bottom) return TextAnchor.LowerCenter;
            if (left) return TextAnchor.MiddleLeft;
            if (right) return TextAnchor.MiddleRight;
            return TextAnchor.MiddleCenter;
        }

        // Returns true when this component is taken over (caller must NOT
        // write translated itself; a space is written instead).
        internal static bool TryOverlay(Component c, string path, string lookupEnglish, string translated)
        {
            try
            {
                string lang = TranslatorPlugin.CurrentLanguage;
                if (!IsCjkLang(lang)) return false;
                if (c == null || path == null) return false;
                bool isMenu = path.IndexOf("TCNN Main Menu") >= 0;
                bool isDlg = path.IndexOf("DialogueCanvas") >= 0;
                if (!isMenu && !isDlg) return false;
                var tmp = c as TMP_Text;
                if (tmp == null) return false;
                Font f = LangFont(lang);
                if (f == null) return false;
                string labelText = OverlayLabel(translated);

                Rec r;
                if (_recs.TryGetValue(c, out r) && r != null && r.go != null)
                {
                    if (r.lang != lang)
                    {
                        Restore(c, r);
                        _recs.Remove(c);
                    }
                    else
                    {
                        if (r.shown != translated)
                        {
                            r.label.text = labelText;
                            r.shown = translated;
                            TranslatorPlugin.Log("CJK: overlay update [" + path + "] '" + labelText + "'");
                        }
                        if (!r.go.activeSelf) r.go.SetActive(true);
                        TranslatorPlugin.SetTextFieldDirect(c, " ");
                        return true;
                    }
                }
                else if (r != null)
                {
                    _recs.Remove(c);
                }

                var go = new GameObject("NeonCJKOverlay", typeof(RectTransform));
                go.transform.SetParent(c.transform, false);
                var dst = go.GetComponent<RectTransform>();
                if (dst != null)
                {
                    dst.anchorMin = Vector2.zero;
                    dst.anchorMax = Vector2.one;
                    dst.offsetMin = Vector2.zero;
                    dst.offsetMax = Vector2.zero;
                    dst.pivot = new Vector2(0.5f, 0.5f);
                }
                var t = go.AddComponent<Text>();
                t.font = f;
                t.raycastTarget = false;
                t.horizontalOverflow = HorizontalWrapMode.Overflow;
                t.verticalOverflow = VerticalWrapMode.Overflow;
                string cur = TranslatorPlugin.GetText(c);
                r = new Rec { owner = c, go = go, label = t, orig = cur, shown = null, lang = lang };
                _recs[c] = r;
                try
                {
                    t.fontSize = Math.Max(1, (int)tmp.fontSize);
                    t.alignment = MapAlign(tmp.alignment.ToString());
                    t.color = tmp.color;
                    if ((tmp.fontStyle & FontStyles.Bold) != 0)
                        t.fontStyle = FontStyle.Bold;
                }
                catch { }
                t.text = labelText;
                r.shown = translated;
                TranslatorPlugin.SetTextFieldDirect(c, " ");
                TranslatorPlugin.Log("CJK: overlay created [" + path + "] '"
                    + lookupEnglish + "' -> '" + labelText + "' font=" + f.name
                    + " size=" + t.fontSize);
                return true;
            }
            catch (Exception ex)
            {
                TranslatorPlugin.Log("CJK: overlay fail - " + ex.Message);
                return false;
            }
        }

        // UGUI Text understands <color>/<b>/<i>/<size> but NOT TMP-only tags
        // (<font>, <material>...): strip those, keep the rest (dialogue color
        // survives, glow does not — readable beats beautiful here).
        private static readonly Regex _tmpOnlyTagRx = new Regex(
            "<\\/?(font|material)[^>]*>", RegexOptions.Compiled | RegexOptions.IgnoreCase);

        internal static string OverlayLabel(string translated)
        {
            if (string.IsNullOrEmpty(translated)) return translated;
            try { return _tmpOnlyTagRx.Replace(translated, ""); }
            catch { return translated; }
        }

        // Called from SetLanguage: restore English TMP texts, destroy labels.
        internal static void ClearAll()
        {
            try
            {
                int n = 0;
                foreach (var kv in _recs)
                {
                    try { Restore(kv.Key, kv.Value); n++; }
                    catch { }
                }
                _recs.Clear();
                if (n > 0) TranslatorPlugin.Log("CJK: cleared " + n + " overlays");
            }
            catch { }
        }

        // Every Populate run: drop dead owners, remove leftovers when the
        // active language is not CJK. Content of TMP text is NEVER a reason
        // to restore (owned components legitimately hold a space).
        internal static void Sweep()
        {
            try
            {
                bool cjk = IsCjkLang(TranslatorPlugin.CurrentLanguage);
                var dead = new List<Component>();
                foreach (var kv in _recs)
                {
                    Component c = kv.Key;
                    Rec r = kv.Value;
                    bool gone = false;
                    try { gone = (c == null || r == null || r.go == null); }
                    catch { gone = true; }
                    if (gone) { dead.Add(c); continue; }
                    if (!cjk || r.lang != TranslatorPlugin.CurrentLanguage)
                    {
                        Restore(c, r);
                        dead.Add(c);
                    }
                }
                foreach (var c in dead) _recs.Remove(c);
            }
            catch { }
        }

        private static void Restore(Component c, Rec r)
        {
            try
            {
                if (r != null && r.go != null)
                {
                    try { r.go.SetActive(false); } catch { }
                    try { UnityEngine.Object.Destroy(r.go); } catch { }
                }
                if (c != null && r != null && r.orig != null)
                    TranslatorPlugin.SetTextFieldDirect(c, r.orig);
            }
            catch { }
        }
    }
}
