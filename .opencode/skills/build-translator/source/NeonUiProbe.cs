using System;
using System.Collections.Generic;
using System.Reflection;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace NeonTranslatorDX
{
    // TEMPORARY: read the game's own button/panel metrics so the mod panel can
    // copy them instead of inventing a look. Removed after the numbers are in.
    internal static class NeonUiProbe
    {
        internal static void Run()
        {
            try
            {
                TranslatorPlugin.Log("UiProbe: === start ===");
                ProbeFontSources();
                ProbeMetrics();
                var texts = UnityEngine.Object.FindObjectsOfType<TMP_Text>();
                var seen = new HashSet<int>();
                foreach (var t in texts)
                {
                    try
                    {
                        if (t == null || t.transform == null) continue;
                        string path = TransformPath(t.transform);
                        if (path.IndexOf("NeonTranslator_LangUI") >= 0) continue;
                        if (seen.Count >= 12) break;
                        var rt = t.transform as RectTransform;
                        if (rt == null) continue;
                        Selectable sel = null;
                        foreach (var s in t.GetComponentsInParent<Selectable>(true)) { sel = s; break; }
                        if (sel == null) continue;
                        var brt = sel.transform as RectTransform;
                        if (brt == null || !seen.Add(sel.GetInstanceID())) continue;

                        TranslatorPlugin.Log("UiProbe: [" + path + "]");
                        TranslatorPlugin.Log("UiProbe:   button type=" + sel.GetType().FullName
                            + " size=" + F(brt.rect.width) + "x" + F(brt.rect.height)
                            + " anchored=" + brt.anchoredPosition + " anchorMin=" + brt.anchorMin
                            + " pivot=" + brt.pivot + " scale=" + brt.localScale);
                        DumpSelectable(sel);

                        // Images on the button and below it (plate, glow, shadow).
                        foreach (var img in sel.GetComponentsInChildren<Image>(true))
                        {
                            string ip = TransformPath(img.transform);
                            string sprite = img.sprite != null ? img.sprite.name : "null";
                            string border = "";
                            if (img.sprite != null)
                            {
                                Vector4 b = img.sprite.border;
                                border = " border=" + F(b.x) + "," + F(b.y) + "," + F(b.z) + "," + F(b.w)
                                    + " spriteRect=" + F(img.sprite.rect.width) + "x" + F(img.sprite.rect.height);
                            }
                            var irt = img.transform as RectTransform;
                            TranslatorPlugin.Log("UiProbe:   image [" + ip.Replace(path, "") + "] "
                                + sprite + " type=" + img.type + " color=" + C(img.color)
                                + " rect=" + F(irt.rect.width) + "x" + F(irt.rect.height) + border
                                + " raycast=" + img.raycastTarget);
                        }

                        TranslatorPlugin.Log("UiProbe:   text size=" + t.fontSize + " style=" + t.fontStyle
                            + " spacing=" + t.characterSpacing + " wordSpacing=" + t.wordSpacing
                            + " line=" + t.lineSpacing + " align=" + t.alignment
                            + " margin=" + t.margin + " color=" + C(t.color)
                            + " font=" + (t.font != null ? t.font.name : "?")
                            + " rect=" + F(rt.rect.width) + "x" + F(rt.rect.height)
                            + " autoSize=" + t.enableAutoSizing + " overflow=" + t.overflowMode
                            + " raycast=" + t.raycastTarget);
                        DumpMaterial(t.fontSharedMaterial);

                        // Layout group on the container (spacing between buttons).
                        foreach (var lg in sel.GetComponentsInParent<LayoutGroup>(true))
                        {
                            if (lg == null) continue;
                            var v = lg as VerticalLayoutGroup;
                            var h = lg as HorizontalLayoutGroup;
                            string info = "layout=" + lg.GetType().Name + " padding=" + lg.padding;
                            if (v != null) info += " spacing=" + v.spacing + " childControlH=" + v.childControlHeight
                                + " childForceExpandH=" + v.childForceExpandHeight;
                            if (h != null) info += " spacing=" + h.spacing + " childControlW=" + h.childControlWidth;
                            TranslatorPlugin.Log("UiProbe:   " + info + " on [" + TransformPath(lg.transform) + "]");
                            break;
                        }
                        break; // one button is enough for metrics; keep the log short
                    }
                    catch (Exception ex) { TranslatorPlugin.Log("UiProbe: item err " + ex.Message); }
                }

                // Every sliced/rounded sprite anywhere (panel styles).
                foreach (var img in UnityEngine.Object.FindObjectsOfType<Image>())
                {
                    try
                    {
                        if (img == null || img.sprite == null) continue;
                        if (img.transform != null && TransformPath(img.transform).IndexOf("NeonTranslator_LangUI") >= 0) continue;
                        Vector4 b = img.sprite.border;
                        bool sliced = img.type == Image.Type.Sliced;
                        if (!sliced && b == Vector4.zero) continue;
                        var rt = img.transform as RectTransform;
                        TranslatorPlugin.Log("UiProbe: sprite [" + TransformPath(img.transform) + "] "
                            + img.sprite.name + " type=" + img.type + " color=" + C(img.color)
                            + " rect=" + F(rt.rect.width) + "x" + F(rt.rect.height)
                            + " border=" + F(b.x) + "," + F(b.y) + "," + F(b.z) + "," + F(b.w));
                    }
                    catch { }
                }

                foreach (var cs in UnityEngine.Object.FindObjectsOfType<CanvasScaler>())
                {
                    try
                    {
                        if (cs == null) continue;
                        TranslatorPlugin.Log("UiProbe: scaler [" + TransformPath(cs.transform) + "] mode=" + cs.uiScaleMode
                            + " ref=" + cs.referenceResolution + " match=" + cs.matchWidthOrHeight
                            + " scaleFactor=" + cs.scaleFactor + " screen=" + Screen.width + "x" + Screen.height);
                    }
                    catch { }
                }

                foreach (var canvas in UnityEngine.Object.FindObjectsOfType<Canvas>())
                {
                    try
                    {
                        if (canvas == null || canvas.transform == null) continue;
                        TranslatorPlugin.Log("UiProbe: canvas [" + TransformPath(canvas.transform) + "] scale="
                            + canvas.scaleFactor + " order=" + canvas.sortingOrder);
                    }
                    catch { }
                }
                TranslatorPlugin.Log("UiProbe: === end ===");
            }
            catch (Exception ex) { TranslatorPlugin.Log("UiProbe: FATAL " + ex); }
        }

        // Can the GAME's own font assets be grown from their own source font?
        // (That is what the clone-based pipeline needs; FontEngine.LoadFontFace
        // returns Invalid_File for fonts it cannot re-open.)
        private static void ProbeFontSources()
        {
            var all = Resources.FindObjectsOfTypeAll<TMP_FontAsset>();
            foreach (var f in all)
            {
                try
                {
                    if (f == null) continue;
                    if (f.name != "Orbitron-Black SDF" && f.name != "Roboto-Condensed_DialogueUI"
                        && f.name != "Sentinel Type - BigNoodleToo SDF With Shadow"
                        && f.name != "Roboto-Regular SDF") continue;
                    string src = f.sourceFontFile != null ? f.sourceFontFile.name : "null";
                    string face = "";
                    try
                    {
                        var fi = f.faceInfo;
                        face = " point=" + fi.pointSize + " scale=" + fi.scale;
                    }
                    catch { }
                    string load = "n/a";
                    string glyphs = "";
                    if (f.sourceFontFile != null)
                    {
                        var err = UnityEngine.TextCore.LowLevel.FontEngine.LoadFontFace(
                            f.sourceFontFile, f.faceInfo.pointSize);
                        load = err.ToString();
                        if (err == UnityEngine.TextCore.LowLevel.FontEngineError.Success)
                        {
                            uint gi;
                            bool hasCyr = UnityEngine.TextCore.LowLevel.FontEngine.TryGetGlyphIndex('Ж', out gi);
                            glyphs = " Ж=" + (hasCyr ? gi.ToString() : "0") + " idx";
                        }
                    }
                    var missField = typeof(TMP_FontAsset).GetField("m_MissingUnicodesFromFontFile",
                        BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
                    var miss = missField != null ? missField.GetValue(f) as HashSet<uint> : null;
                    bool cached = miss != null && miss.Contains('Ж');
                    string add = "";
                    if (f.atlasPopulationMode == TMPro.AtlasPopulationMode.Dynamic)
                    {
                        if (miss != null) miss.Clear();
                        uint[] missing = null;
                        int before = f.characterTable != null ? f.characterTable.Count : -1;
                        bool ok = f.TryAddCharacters(new uint[] { 'Ж' }, out missing, false);
                        int after = f.characterTable != null ? f.characterTable.Count : -1;
                        add = " tryAdd=" + ok + " " + before + "->" + after + " miss=" + (missing != null ? missing.Length : -1);
                    }
                    TranslatorPlugin.Log("UiProbe: fontSource '" + f.name + "' src=" + src
                        + " mode=" + f.atlasPopulationMode + face
                        + " material=" + (f.material != null ? f.material.name : "?")
                        + " padding=" + f.atlasPadding + " render=" + f.atlasRenderMode
                        + " loadface=" + load + glyphs + " cachedMissing=" + cached + add);
                }
                catch (Exception ex) { TranslatorPlugin.Log("UiProbe: fontSource err " + ex.Message); }
            }
        }

        // Metric comparison: the game's English label vs our translated label
        // on the SAME TMP component (same plate, same size).
        private static void ProbeMetrics()
        {
            var texts = UnityEngine.Object.FindObjectsOfType<TMP_Text>();
            foreach (var t in texts)
            {
                try
                {
                    if (t == null || t.transform == null) continue;
                    string path = TransformPath(t.transform);
                    if (path.IndexOf("ButtonContainer") < 0) continue;
                    if (path.IndexOf("/Text (TMP)") < 0) continue;
                    string ru = t.text;
                    string en = path.IndexOf("Continue") >= 0 ? "Continue"
                        : path.IndexOf("New Game") >= 0 ? "New Game"
                        : path.IndexOf("Options") >= 0 ? "Options"
                        : path.IndexOf("Load Save") >= 0 ? "Load Save File"
                        : path.IndexOf("Exit") >= 0 ? "Exit" : null;
                    if (en == null) continue;
                    Vector2 wEn = t.GetPreferredValues(en, 0f, 0f);
                    Vector2 wRu = t.GetPreferredValues(ru, 0f, 0f);
                    float hEn = wEn.y, hRu = wRu.y;
                    if (path.IndexOf("Continue") >= 0)
                    {
                        float saved = t.characterSpacing;
                        string cal = "";
                        foreach (float sp in new float[] { 0f, -5f, -10f, -20f })
                        {
                            t.characterSpacing = sp;
                            Vector2 w = t.GetPreferredValues(ru, 0f, 0f);
                            cal += " sp" + sp + "=" + F(w.x) + "x" + F(w.y);
                        }
                        t.characterSpacing = saved;
                        TranslatorPlugin.Log("UiProbe: spacingCal '" + ru + "'" + cal);
                    }
                    TranslatorPlugin.Log("UiProbe: metrics ['" + en + "' -> '" + ru + "']"
                        + " size=" + t.fontSize + " style=" + t.fontStyle
                        + " spacing=" + t.characterSpacing + " line=" + t.lineSpacing
                        + " font=" + (t.font != null ? t.font.name : "?")
                        + " en=" + F(wEn.x) + "x" + F(hEn) + " ru=" + F(wRu.x) + "x" + F(hRu)
                        + " ratio=" + (wEn.x > 0f ? (wRu.x / wEn.x).ToString("0.000") : "?")
                        + " plate=" + F(((RectTransform)t.transform.parent.parent).rect.width));
                }
                catch (Exception ex) { TranslatorPlugin.Log("UiProbe: metrics err " + ex.Message); }
            }
            // our own panel rows: row height vs. text height
            foreach (var t in UnityEngine.Object.FindObjectsOfType<Text>())
            {
                try
                {
                    if (t == null || t.transform == null) continue;
                    string path = TransformPath(t.transform);
                    if (path.IndexOf("NeonTranslator_LangUI") < 0) continue;
                    if (path.IndexOf("MiniLabel") >= 0) continue;
                    var rt = t.transform as RectTransform;
                    TranslatorPlugin.Log("UiProbe: panelText ['" + t.text + "'] size=" + t.fontSize
                        + " rect=" + F(rt.rect.width) + "x" + F(rt.rect.height)
                        + " pref=" + F(t.preferredWidth) + "x" + F(t.preferredHeight)
                        + " font=" + (t.font != null ? t.font.name : "?"));
                }
                catch { }
            }
        }

        private static void DumpSelectable(Selectable sel)
        {
            try
            {
                var cb = sel.colors;
                TranslatorPlugin.Log("UiProbe:   selectable transition=" + sel.transition
                    + " normal=" + C(cb.normalColor) + " hi=" + C(cb.highlightedColor)
                    + " press=" + C(cb.pressedColor) + " sel=" + C(cb.selectedColor)
                    + " disabled=" + C(cb.disabledColor) + " mult=" + cb.colorMultiplier
                    + " fade=" + cb.fadeDuration);
                var ss = sel.spriteState;
                TranslatorPlugin.Log("UiProbe:   sprites hi=" + Name(ss.highlightedSprite)
                    + " press=" + Name(ss.pressedSprite) + " sel=" + Name(ss.selectedSprite)
                    + " disabled=" + Name(ss.disabledSprite));
                // ANButton-specific knobs (tween, extra colours, sounds).
                var t = sel.GetType();
                var flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
                var parts = new List<string>();
                foreach (var f in t.GetFields(flags))
                {
                    if (f.IsStatic) continue;
                    if (parts.Count >= 40) break;
                    object v;
                    try { v = f.GetValue(sel); } catch { continue; }
                    if (!Interesting(v)) continue;
                    parts.Add(f.Name + "=" + Val(v));
                }
                if (parts.Count > 0) TranslatorPlugin.Log("UiProbe:   AN fields: " + string.Join("; ", parts.ToArray()));
            }
            catch (Exception ex) { TranslatorPlugin.Log("UiProbe: selectable err " + ex.Message); }
        }

        private static void DumpMaterial(Material m)
        {
            try
            {
                if (m == null) { TranslatorPlugin.Log("UiProbe:   mat=none"); return; }
                string s = "mat=" + m.name + " shader=" + (m.shader != null ? m.shader.name : "?");
                string[] props = { "_FaceColor", "_OutlineColor", "_OutlineWidth", "_UnderlayColor",
                    "_UnderlayOffsetX", "_UnderlayOffsetY", "_UnderlaySoftness", "_UnderlayDilate",
                    "_GlowColor", "_GlowPower", "_GradientScale" };
                foreach (string p in props)
                {
                    if (!m.HasProperty(p)) continue;
                    if (p.EndsWith("Color")) s += " " + p + "=" + C(m.GetColor(p));
                    else s += " " + p + "=" + m.GetFloat(p).ToString("0.##");
                }
                TranslatorPlugin.Log("UiProbe:   " + s);
            }
            catch { }
        }

        private static bool Interesting(object v)
        {
            if (v == null) return false;
            if (v is string || v is bool || v is float || v is int || v is Color || v is ColorBlock || v is Sprite)
                return true;
            string n = v.GetType().Name;
            return n.IndexOf("Tween", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static string Val(object v)
        {
            if (v is Color) return C((Color)v);
            if (v is Sprite) return ((Sprite)v).name;
            if (v is ColorBlock)
            {
                var cb = (ColorBlock)v;
                return "{" + C(cb.normalColor) + "," + C(cb.highlightedColor) + "," + C(cb.pressedColor) + "}";
            }
            return v.ToString();
        }

        private static string Name(Sprite s) { return s != null ? s.name : "-"; }
        private static string F(float v) { return v.ToString("0.##"); }

        private static string C(Color c)
        {
            return "#" + Mathf.RoundToInt(c.r * 255).ToString("X2")
                + Mathf.RoundToInt(c.g * 255).ToString("X2")
                + Mathf.RoundToInt(c.b * 255).ToString("X2") + "@" + c.a.ToString("0.00");
        }

        private static string TransformPath(Transform t)
        {
            string p = t.name;
            Transform q = t.parent;
            while (q != null) { p = q.name + "/" + p; q = q.parent; }
            return p;
        }
    }
}
