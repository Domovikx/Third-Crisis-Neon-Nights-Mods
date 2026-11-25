using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using TMPro;
using UnityEngine;
using UnityEngine.TextCore;
using UnityEngine.TextCore.LowLevel;

namespace NeonTranslatorDX
{
    // Runtime TMP font pipeline (2026-11-25).
    //
    // Why this exists: the game ships STATIC/small-dynamic TMP atlases
    // (Roboto-Condensed_*, Orbitron-*, Sentinel-*, 1024x1024, ASCII only).
    // TMP's own dynamic path cannot grow them here: it calls
    // `FontEngine.LoadFontFace(Font, size)`, and FontEngine answers
    // `Invalid_File` for the fonts the game hands over. Proven in-game:
    // `preload Roboto-Condensed_DialogueUI (83) = False chars 236->236`.
    //
    // What we do instead: bake our own dynamic TMP font assets straight from the
    // shipped TTF bytes (`FontEngine.LoadFontFace(byte[], size)` succeeds),
    // rasterising SDF glyphs into 2048x2048 atlases with FontEngine's internal
    // `TryAddGlyphToTexture` (the exact call TMP uses). The assets are attached
    // as fallbacks to every game font asset, so the game keeps rendering ASCII
    // with its own material and our glyphs fill the gaps:
    //
    //   game font -> lat (Roboto Condensed) -> SC -> JP -> KR -> marks
    //
    // Policy (chain order, atlas budget, preload criterion) — docs/fonts.md.
    internal static class NeonFonts
    {
        internal sealed class Face
        {
            public string Key;          // "lat", "zh", "ja", "ko", "marks"
            public string File;         // TTF on disk
            public string Family;       // UGUI fallback family name (null: none)
            public byte[] Bytes;
            public int PointSize;
            public int Padding;
            public int AtlasSize = 2048;
            public TMP_FontAsset Asset;
            public string Failure;
        }

        // SDF sampling 48 keeps menu/dialogue text (20–40 px) sharp while a
        // 2048 atlas holds ~1 200 glyphs: zh = 2 atlases (~8 MB), not 8.
        private const int DefaultPointSize = 48;
        private const int DefaultPadding = 5;
        private const int AtlasSize = 2048;

        private static readonly Dictionary<string, Face> Faces = new Dictionary<string, Face>(StringComparer.OrdinalIgnoreCase);
        private static readonly Dictionary<string, TMP_FontAsset> FacesByLang = new Dictionary<string, TMP_FontAsset>(StringComparer.OrdinalIgnoreCase);
        private static readonly Dictionary<int, Face> FaceByAssetId = new Dictionary<int, Face>();
        private static readonly HashSet<int> FallbacksReported = new HashSet<int>();
        private static readonly HashSet<TMP_FontAsset> Primaries = new HashSet<TMP_FontAsset>();
        private static readonly Dictionary<int, TMP_FontAsset> Clones = new Dictionary<int, TMP_FontAsset>();
        private static readonly HashSet<int> AssignedReported = new HashSet<int>();
        private static TMP_FontAsset _latinOverride;
        private static string _lastLang = "en";
        private static readonly HashSet<string> EnsuredTexts = new HashSet<string>();
        private static MethodInfo _tryAddGlyph;
        private static Material _templateMaterial;
        private static bool _internalsResolved;
        private static string _fontsDir;

        // ---------------------------------------------------------------- setup

        internal static void Configure(string dllDir)
        {
            _fontsDir = Path.Combine(dllDir, "fonts");
            ResolveInternals();
            // Hypothesis-2 guard: after the mods/ layout move the fonts folder
            // must be exactly next to the DLL. Log what is actually there.
            string[] shipped = { "RobotoCondensed-Regular.ttf", "NotoSansSC.ttf", "NotoSansJP.ttf",
                "NotoSansKR.ttf", "NotoSansMarks.ttf", "typography.json" };
            foreach (string name in shipped)
            {
                string path = Path.Combine(_fontsDir, name);
                Log("Font face: " + path + " exists=" + File.Exists(path));
            }
        }

        private static void ResolveInternals()
        {
            if (_internalsResolved) return;
            _internalsResolved = true;
            try
            {
                _tryAddGlyph = typeof(FontEngine).GetMethod("TryAddGlyphToTexture",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
                Log("Fonts: TryAddGlyphToTexture " + (_tryAddGlyph != null ? "ok" : "MISSING"));
            }
            catch (Exception ex) { Log("Fonts: internal resolve error - " + ex.Message); }
        }

        // --------------------------------------------------------- face factory

        private static Face CreateFace(string key)
        {
            var f = new Face { Key = key };
            switch (key)
            {
                case "lat":
                    f.File = Path.Combine(_fontsDir, "RobotoCondensed-Regular.ttf");
                    f.Family = "Roboto Condensed";
                    break;
                case "zh":
                    f.File = Path.Combine(_fontsDir, "NotoSansSC.ttf");
                    f.Family = "Noto Sans SC";
                    break;
                case "ja":
                    f.File = Path.Combine(_fontsDir, "NotoSansJP.ttf");
                    f.Family = "Noto Sans JP";
                    break;
                case "ko":
                    // Shipped with the mod (subset, wght=400): do not fall back
                    // to %WINDIR%\Fonts\malgun.ttf — another system, another
                    // drawing, and it is absent on many players' machines.
                    f.File = Path.Combine(_fontsDir, "NotoSansKR.ttf");
                    f.Family = "Noto Sans KR";
                    break;
                case "marks":
                    f.File = Path.Combine(_fontsDir, "NotoSansMarks.ttf");
                    f.Family = null;
                    break;
            }
            return f;
        }

        private static Face GetFace(string key)
        {
            Face f;
            if (Faces.TryGetValue(key, out f)) return f;
            f = CreateFace(key);
            Faces[key] = f;
            return f;
        }

        internal static string FaceKeyForLang(string lang)
        {
            return NeonFontCore.FaceKeyForLang(lang);
        }

        /// Face asset for the language, built on first use. `primary` is the
        /// game font whose metrics/material we mirror (may be null).
        internal static TMP_FontAsset AssetForLang(string lang, TMP_FontAsset primary)
        {
            _lastLang = lang ?? _lastLang;
            // A candidate picked in the font demo replaces the latin face of
            // the chain until the game is restarted (never persisted).
            if (_latinOverride != null && FaceKeyForLang(lang) == "lat") return _latinOverride;

            TMP_FontAsset cached;
            if (FacesByLang.TryGetValue(lang, out cached) && cached != null) return cached;

            TMP_FontAsset asset = BuildFace(GetFace(FaceKeyForLang(lang)), primary);
            if (asset == null && FaceKeyForLang(lang) != "lat")
            {
                // No CJK font on this machine: latin still covers ASCII and
                // Cyrillic, so mixed strings keep half the text readable.
                asset = BuildFace(GetFace("lat"), primary);
            }
            if (asset != null) FacesByLang[lang] = asset;
            return asset;
        }

        private static TMP_FontAsset BuildFace(Face f, TMP_FontAsset primary)
        {
            if (f.Asset != null) return f.Asset;
            if (f.Failure != null) return null;
            try
            {
                if (f.File == null || !File.Exists(f.File))
                {
                    f.Failure = "no ttf (" + f.File + ")";
                    Log("Fonts: " + f.Key + " unavailable - " + f.Failure);
                    return null;
                }
                int pointSize = DefaultPointSize;
                int padding = DefaultPadding;
                try
                {
                    // Mirror the game's metrics roughly, but keep the atlas
                    // budget: point 40..64, padding 5.
                    if (primary != null && primary.faceInfo.pointSize > 0)
                        pointSize = Mathf.Clamp(primary.faceInfo.pointSize, 40, 64);
                }
                catch { }

                byte[] bytes = File.ReadAllBytes(f.File);
                FontEngine.InitializeFontEngine();
                FontEngineError err = FontEngine.LoadFontFace(bytes, pointSize);
                if (err != FontEngineError.Success)
                {
                    f.Failure = "LoadFontFace=" + err;
                    Log("Fonts: " + f.Key + " unavailable - " + f.Failure);
                    return null;
                }
                FaceInfo face = FontEngine.GetFaceInfo();

                TMP_FontAsset a = ScriptableObject.CreateInstance<TMP_FontAsset>();
                a.name = "DX-" + f.Key;
                SetField(a, "m_Version", "1.1.0");
                a.faceInfo = face;
                a.atlasPopulationMode = AtlasPopulationMode.Dynamic;
                SetField(a, "m_AtlasWidth", f.AtlasSize);
                SetField(a, "m_AtlasHeight", f.AtlasSize);
                SetField(a, "m_AtlasPadding", padding);
                SetField(a, "m_AtlasRenderMode", GlyphRenderMode.SDFAA);
                Texture2D tex = NewAtlas("DX Atlas " + f.Key, f.AtlasSize);
                SetField(a, "m_AtlasTexture", tex);
                a.atlasTextures = new Texture2D[] { tex };
                SetField(a, "m_AtlasTextureIndex", 0);
                a.isMultiAtlasTexturesEnabled = true;
                SetField(a, "m_FreeGlyphRects", new List<GlyphRect> { new GlyphRect(0, 0, f.AtlasSize - 1, f.AtlasSize - 1) });
                SetField(a, "m_UsedGlyphRects", new List<GlyphRect>());
                a.material = MakeMaterial(primary, tex, padding, f.AtlasSize);
                a.ReadFontAssetDefinition();

                f.Bytes = bytes;
                f.PointSize = pointSize;
                f.Padding = padding;
                f.Asset = a;
                FaceByAssetId[a.GetInstanceID()] = f;
                Log("Fonts: built " + a.name + " from " + Path.GetFileName(f.File)
                    + " point=" + pointSize + " padding=" + padding + " atlas=" + f.AtlasSize + "x" + f.AtlasSize
                    + " family='" + face.familyName + "'");

                // Seed with whatever the primary already bakes (236 glyphs in
                // Roboto-Condensed_DialogueUI) so the fallback is a superset:
                // nothing the game could draw regresses.
                int seed = SeedFrom(primary, f);
                if (seed > 0) Log("Fonts: " + a.name + " seeded " + seed + " primary glyphs");
                return a;
            }
            catch (Exception ex)
            {
                f.Failure = ex.Message;
                Log("Fonts: build " + f.Key + " failed - " + ex);
                return null;
            }
        }

        private static int SeedFrom(TMP_FontAsset primary, Face f)
        {
            if (primary == null || primary.characterTable == null) return 0;
            var list = new List<uint>();
            foreach (var ch in primary.characterTable)
            {
                if (ch == null) continue;
                list.Add(ch.unicode);
                if (list.Count >= 1024) break;
            }
            if (list.Count == 0) return 0;
            return AddChars(f, list, false, null);
        }

        private static Texture2D NewAtlas(string name, int size)
        {
            Texture2D tex = new Texture2D(size, size, TextureFormat.Alpha8, false);
            tex.name = name;
            // Alpha8 keeps only alpha; clear it so the atlas starts transparent
            // (fresh textures have undefined contents).
            tex.SetPixels32(new Color32[size * size]);
            tex.Apply(false, false);
            return tex;
        }

        private static Material MakeMaterial(TMP_FontAsset primary, Texture2D atlas, int padding, int atlasSize)
        {
            if (_templateMaterial == null)
            {
                if (primary != null && primary.material != null && primary.material.shader != null)
                    _templateMaterial = primary.material;
                else
                {
                    Shader s = Shader.Find("TextMeshPro/Mobile/Distance Field");
                    if (s == null) s = Shader.Find("TextMeshPro/Distance Field");
                    if (s != null) _templateMaterial = new Material(s);
                }
            }
            Material mat = _templateMaterial != null ? new Material(_templateMaterial) : new Material(Shader.Find("UI/Default"));
            mat.name = "DX Atlas Material";
            mat.SetTexture("_MainTex", atlas);
            mat.SetFloat("_TextureWidth", atlasSize);
            mat.SetFloat("_TextureHeight", atlasSize);
            mat.SetFloat("_GradientScale", padding + 1f);
            return mat;
        }

        // ------------------------------------------------------- glyph addition

        /// Add every character of `text` that the chain does not cover yet.
        internal static void EnsureText(TMP_Text text, string lang, string value)
        {
            if (text == null || string.IsNullOrEmpty(value) || _tryAddGlyph == null) return;
            try
            {
                TMP_FontAsset primary = text.font;
                if (primary == null) return;

                string cacheKey = lang + "\u0001" + value;
                if (!EnsuredTexts.Contains(cacheKey))
                {
                    var needed = new List<uint>();
                    var seen = new HashSet<uint>();
                    for (int i = 0; i < value.Length; i++)
                    {
                        char ch = value[i];
                        if (ch == '\n' || ch == '\r' || ch == '\t') continue;
                        if (SafeHas(primary, ch) || !seen.Add(ch)) continue;
                        needed.Add(ch);
                    }
                    if (needed.Count > 0) CoverChain(lang, primary, needed);
                    EnsuredTexts.Add(cacheKey);
                    if (EnsuredTexts.Count > 4000) EnsuredTexts.Clear();
                }

                var table = primary.fallbackFontAssetTable;
                TMP_FontAsset face = AssetForLang(lang, primary);
                if (table == null || face == null || !table.Contains(face)) AttachFallbacks(primary, lang);
            }
            catch (Exception ex) { Log("Fonts: ensure text error - " + ex.Message); }
        }

        /// Add `unicodes` to every face of the chain that can render them.
        /// Returns the number of characters covered by the union of the chain.
        internal static int CoverChain(string lang, TMP_FontAsset primary, List<uint> unicodes)
        {
            var covered = new HashSet<uint>();
            foreach (string key in NeonFontCore.FallbackOrder(lang))
            {
                Face f = GetFace(key);
                TMP_FontAsset asset = BuildFace(f, primary);
                if (asset == null) continue;
                var subset = new List<uint>();
                foreach (uint u in unicodes)
                    if (!covered.Contains(u)) subset.Add(u);
                if (subset.Count == 0) break;
                var resolved = new HashSet<uint>();
                AddChars(f, subset, false, resolved);
                foreach (uint u in resolved) covered.Add(u);
            }
            return covered.Count;
        }

        /// Rasterise `unicodes` from the face's TTF into the face asset.
        /// Reloading the font face first is mandatory: FontEngine keeps ONE face
        /// globally, and building another face (e.g. Korean) switches it.
        internal static int AddChars(Face f, List<uint> unicodes, bool logPreload, HashSet<uint> resolved)
        {
            int added = 0;
            int failed = 0;
            int noGlyph = 0;
            try
            {
                TMP_FontAsset asset = f.Asset;
                if (asset == null || f.Bytes == null) return 0;
                if (FontEngine.LoadFontFace(f.Bytes, f.PointSize) != FontEngineError.Success)
                {
                    Log("Fonts: " + asset.name + " face reload failed");
                    return 0;
                }
                var glyphs = asset.glyphTable;
                var chars = asset.characterTable;
                var glyphLookup = asset.glyphLookupTable;
                var charLookup = asset.characterLookupTable;
                if (glyphLookup == null || charLookup == null)
                {
                    asset.ReadFontAssetDefinition();
                    glyphLookup = asset.glyphLookupTable;
                    charLookup = asset.characterLookupTable;
                }
                int atlasIndex = 0;
                try { atlasIndex = (int)GetField(asset, "m_AtlasTextureIndex"); } catch { }
                Texture2D tex = asset.atlasTextures[atlasIndex];
                List<GlyphRect> free = FreeRects(asset);
                List<GlyphRect> used = UsedRects(asset);
                int before = chars.Count;

                for (int i = 0; i < unicodes.Count; i++)
                {
                    uint unicode = unicodes[i];
                    if (charLookup.ContainsKey(unicode))
                    {
                        if (resolved != null) resolved.Add(unicode);
                        continue;
                    }
                    uint glyphIndex;
                    if (!FontEngine.TryGetGlyphIndex(unicode, out glyphIndex) || glyphIndex == 0)
                    {
                        // NBSP/SHY fallbacks, same as TMP does.
                        if (unicode == 0xA0) FontEngine.TryGetGlyphIndex(0x20, out glyphIndex);
                        else if (unicode == 0xAD || unicode == 0x2011) FontEngine.TryGetGlyphIndex(0x2D, out glyphIndex);
                        if (glyphIndex == 0) { noGlyph++; continue; }
                    }
                    Glyph glyph;
                    if (!glyphLookup.TryGetValue(glyphIndex, out glyph))
                    {
                        bool ok = TryAddGlyph(glyphIndex, asset.atlasPadding, free, used,
                            asset.atlasRenderMode, asset.atlasTextures[atlasIndex], out glyph);
                        if (!ok && asset.isMultiAtlasTexturesEnabled)
                        {
                            atlasIndex = NewAtlasTexture(asset, atlasIndex);
                            free = FreeRects(asset);
                            used = UsedRects(asset);
                            ok = TryAddGlyph(glyphIndex, asset.atlasPadding, free, used,
                                asset.atlasRenderMode, asset.atlasTextures[atlasIndex], out glyph);
                        }
                        if (!ok || glyph == null) { failed++; continue; }
                        glyph.atlasIndex = atlasIndex;
                        glyphs.Add(glyph);
                        glyphLookup.Add(glyphIndex, glyph);
                    }
                    TMP_Character character = new TMP_Character(unicode, asset, glyph);
                    chars.Add(character);
                    charLookup.Add(unicode, character);
                    if (resolved != null) resolved.Add(unicode);
                    added++;
                }
                tex = asset.atlasTextures[atlasIndex];
                if (tex != null) tex.Apply(false, false);
                if (logPreload)
                {
                    Log("Fonts: preload " + asset.name + " (" + unicodes.Count + ") = " + (failed == 0 && noGlyph == 0)
                        + " chars " + before + "->" + chars.Count + " atlas " + f.AtlasSize + "x" + f.AtlasSize
                        + " textures " + asset.atlasTextureCount
                        + (failed + noGlyph > 0 ? " (missing=" + (failed + noGlyph) + ")" : ""));
                }
            }
            catch (Exception ex) { Log("Fonts: add chars error - " + ex); }
            return added;
        }

        private static int NewAtlasTexture(TMP_FontAsset asset, int currentIndex)
        {
            try
            {
                Face owner;
                int size = FaceByAssetId.TryGetValue(asset.GetInstanceID(), out owner) ? owner.AtlasSize : AtlasSize;
                Texture2D tex = NewAtlas(asset.name + " atlas " + (currentIndex + 1), size);
                Texture2D[] arr = asset.atlasTextures;
                int index = currentIndex + 1;
                if (arr.Length <= index)
                {
                    var bigger = new Texture2D[Math.Max(index + 1, arr.Length * 2)];
                    Array.Copy(arr, bigger, arr.Length);
                    arr = bigger;
                }
                arr[index] = tex;
                asset.atlasTextures = arr;
                SetField(asset, "m_AtlasTextureIndex", index);
                var free = FreeRects(asset);
                var used = UsedRects(asset);
                free.Clear();
                free.Add(new GlyphRect(0, 0, size - 1, size - 1));
                used.Clear();
                Log("Fonts: " + asset.name + " new atlas #" + index);
                return index;
            }
            catch (Exception ex) { Log("Fonts: new atlas error - " + ex.Message); return currentIndex; }
        }

        private static List<GlyphRect> FreeRects(TMP_FontAsset asset)
        {
            var list = GetField(asset, "m_FreeGlyphRects") as List<GlyphRect>;
            return list ?? new List<GlyphRect>();
        }

        private static List<GlyphRect> UsedRects(TMP_FontAsset asset)
        {
            var list = GetField(asset, "m_UsedGlyphRects") as List<GlyphRect>;
            return list ?? new List<GlyphRect>();
        }

        private static bool TryAddGlyph(uint glyphIndex, int padding, List<GlyphRect> free,
            List<GlyphRect> used, GlyphRenderMode mode, Texture2D atlas, out Glyph glyph)
        {
            glyph = null;
            try
            {
                object[] args = new object[]
                {
                    glyphIndex, padding, GlyphPackingMode.BestShortSideFit,
                    free, used, mode, atlas, null,
                };
                bool ok = (bool)_tryAddGlyph.Invoke(null, args);
                glyph = args[7] as Glyph;
                return ok && glyph != null;
            }
            catch (Exception ex)
            {
                Exception inner = ex.InnerException ?? ex;
                Log("Fonts: TryAddGlyph call failed - " + inner.Message);
                return false;
            }
        }

        // ----------------------------------------------------- fallback wiring

        /// Attach the whole chain to a game font asset (order from the core:
        /// own face first, marks last).
        internal static void AttachFallbacks(TMP_FontAsset primary, string lang)
        {
            if (primary == null) return;
            _lastLang = lang ?? _lastLang;
            Primaries.Add(primary);
            try
            {
                var order = NeonFontCore.FallbackOrder(lang);
                List<TMP_FontAsset> table = primary.fallbackFontAssetTable;
                if (table == null) table = new List<TMP_FontAsset>();
                bool changed = false;
                foreach (string key in order)
                {
                    TMP_FontAsset a = AssetForLang(LangForFaceKey(key), primary);
                    if (a == null || a == primary) continue;
                    if (!table.Contains(a)) { table.Add(a); changed = true; }
                }
                if (changed)
                {
                    primary.fallbackFontAssetTable = table;
                    int id = primary.GetInstanceID();
                    if (FallbacksReported.Add(id))
                        Log("Fonts: fallbacks on '" + primary.name + "' -> " + Describe(table));
                }
            }
            catch (Exception ex) { Log("Fonts: attach fallback error - " + ex.Message); }
        }

        private static string LangForFaceKey(string key)
        {
            return key == "lat" ? "en" : key;
        }

        private static string Describe(List<TMP_FontAsset> table)
        {
            var parts = new List<string>();
            foreach (var a in table) if (a != null) parts.Add(a.name + ":" + (a.characterTable != null ? a.characterTable.Count : -1));
            return "[" + string.Join(",", parts.ToArray()) + "]";
        }

        /// Dictionary charset warm-up over the WHOLE chain. `preload = True`
        /// means every non-ASCII character of the language is renderable by at
        /// least one face of the chain — one face alone can never cover the
        /// corpus (fullwidth brackets, stray ideographs, glitch strokes).
        internal static bool PreloadChain(string lang, TMP_FontAsset primary, Dictionary<string, string> translations)
        {
            var needed = new HashSet<uint>();   // не-ASCII, которых нет в игровом атласе
            var corpus = new HashSet<uint>();   // все не-ASCII символов перевода
            if (translations != null)
            {
                foreach (var kv in translations)
                {
                    string s = kv.Value;
                    if (string.IsNullOrEmpty(s)) continue;
                    for (int i = 0; i < s.Length; i++)
                    {
                        char ch = s[i];
                        if (ch < 128) continue;
                        if (ch >= 0xD800 && ch <= 0xDBFF) { i++; continue; }
                        corpus.Add(ch);
                        if (SafeHas(primary, ch)) continue;
                        needed.Add(ch);
                    }
                }
            }
            if (needed.Count == 0)
            {
                Log("Font: preload chain " + lang + " = True (no non-ASCII characters)");
                return true;
            }
            var list = new List<uint>(needed);
            DateTime started = DateTime.UtcNow;
            int covered = CoverChain(lang, primary, list);
            double seconds = (DateTime.UtcNow - started).TotalSeconds;
            int gameChars = primary != null && primary.characterTable != null ? primary.characterTable.Count : 0;
            bool ok = covered >= list.Count;
            int total = gameChars + corpus.Count;
            Log("Font: preload chain " + lang + " = " + ok + ": needed " + list.Count
                + " (" + corpus.Count + " non-ASCII in corpus, " + (corpus.Count - list.Count) + " already baked), covered " + covered
                + ", unrenderable " + (list.Count - covered)
                + " | game " + gameChars + " + dynamic " + corpus.Count + " -> " + total + " glyphs"
                + " (" + seconds.ToString("0.00") + " s)");
            // Who actually paints the non-ASCII text: first chain face with the
            // most coverage (that is the asset name to quote in reports).
            string painter = "-";
            int best = 0;
            foreach (string key in NeonFontCore.FallbackOrder(lang))
            {
                TMP_FontAsset a = AssetForLang(LangForFaceKey(key), primary);
                if (a == null || a.characterTable == null) continue;
                int hits = 0;
                foreach (uint u in corpus) if (SafeHas(a, (char)u)) hits++;
                if (hits > best) { best = hits; painter = a.name; }
            }
            Log("Font: render " + lang + ": " + corpus.Count + " non-ASCII chars drawn by '" + painter
                + "' (" + best + "/" + corpus.Count + "), chain " + string.Join("->", NeonFontCore.FallbackOrder(lang))
                + ", primary '" + (primary != null ? primary.name : "?") + "' keeps " + gameChars + " baked glyphs");
            if (!ok)
            {
                var missing = new List<string>();
                foreach (uint u in list)
                {
                    bool hit = false;
                    foreach (string key in NeonFontCore.FallbackOrder(lang))
                    {
                        TMP_FontAsset a = AssetForLang(LangForFaceKey(key), primary);
                        if (a != null && SafeHas(a, (char)u)) { hit = true; break; }
                    }
                    if (!hit) missing.Add("U+" + u.ToString("X4"));
                    if (missing.Count >= 12) break;
                }
                Log("Font: preload chain " + lang + " unrenderable: " + string.Join(",", missing.ToArray()));
            }
            return ok;
        }

        /// Reset the lazy per-string marker cache (called on language switch).
        internal static void ResetEnsured()
        {
            EnsuredTexts.Clear();
        }

        private static bool SafeHas(TMP_FontAsset f, char ch)
        {
            try { return f != null && f.HasCharacter(ch); } catch { return false; }
        }

        // --------------------------------------------------- game-font cloning

        /// Instantiate the GAME's font asset and turn the copy into a dynamic
        /// one, keeping its own TTF (source font), material, padding and render
        /// mode. The original stays untouched for the game UI; the copy carries
        /// the exact same drawing, which is why the translation does not look
        /// like a foreign font.
        internal static TMP_FontAsset CloneGameFace(TMP_FontAsset game)
        {
            if (game == null) return null;
            int id = game.GetInstanceID();
            TMP_FontAsset clone;
            if (Clones.TryGetValue(id, out clone) && clone != null) return clone;
            try
            {
                if (game.sourceFontFile == null)
                {
                    Log("Fonts: clone '" + game.name + "' skipped - no source font file (baked atlas)");
                    return null;
                }
                FontEngine.InitializeFontEngine();
                if (FontEngine.LoadFontFace(game.sourceFontFile, game.faceInfo.pointSize) != FontEngineError.Success)
                {
                    Log("Fonts: clone '" + game.name + "' skipped - source font is not readable by FontEngine");
                    return null;
                }
                clone = UnityEngine.Object.Instantiate(game);
                clone.name = "DXclone-" + game.name;
                clone.atlasPopulationMode = AtlasPopulationMode.Dynamic;
                SetField(clone, "m_AtlasWidth", 2048);
                SetField(clone, "m_AtlasHeight", 2048);

                // Atlas 0: a private copy of the game's baked glyphs (so ASCII
                // keeps the game's exact pixels). Atlas 1: fresh, for new glyphs.
                Texture2D src = game.atlasTexture;
                Texture2D baked = null;
                if (src != null && src.isReadable)
                {
                    baked = new Texture2D(src.width, src.height, TextureFormat.Alpha8, false);
                    baked.name = clone.name + " baked";
                    baked.SetPixels32(src.GetPixels32());
                    baked.Apply(false, false);
                }
                Texture2D fresh = NewAtlas(clone.name + " new", 2048);
                SetField(clone, "m_AtlasTexture", baked);
                clone.atlasTextures = baked != null ? new Texture2D[] { baked, fresh } : new Texture2D[] { fresh };
                SetField(clone, "m_AtlasTextureIndex", 0);
                clone.isMultiAtlasTexturesEnabled = true;
                SetField(clone, "m_AtlasPadding", game.atlasPadding);
                SetField(clone, "m_AtlasRenderMode", game.atlasRenderMode);

                Material mat = game.material != null ? new Material(game.material) : null;
                if (mat != null)
                {
                    mat.name = (game.material.name ?? game.name) + " (DX clone)";
                    if (baked != null) mat.SetTexture("_MainTex", baked);
                    clone.material = mat;
                }
                if (baked != null)
                {
                    var free = FreeRects(clone);
                    var used = UsedRects(clone);
                    if (free == null) free = new List<GlyphRect>();
                    if (used == null) used = new List<GlyphRect>();
                    if (free.Count == 0)
                        free.Add(new GlyphRect(src.width, 0, 2048 - src.width, 2048 - 1));
                    SetField(clone, "m_FreeGlyphRects", free);
                    SetField(clone, "m_UsedGlyphRects", used);
                }
                clone.ReadFontAssetDefinition();
                Clones[id] = clone;
                Log("Fonts: cloned '" + game.name + "' -> '" + clone.name + "' source='"
                    + game.sourceFontFile.name + "' point=" + game.faceInfo.pointSize
                    + " padding=" + game.atlasPadding + " render=" + game.atlasRenderMode
                    + " material='" + (clone.material != null ? clone.material.name : "?") + "'"
                    + " bakedAtlas=" + (baked != null ? src.width + "x" + src.height : "none"));
                return clone;
            }
            catch (Exception ex)
            {
                Log("Fonts: clone '" + game.name + "' error - " + ex);
                return null;
            }
        }

        /// Give a translated label the best face: a clone of the game's own
        /// font when it can grow (Cyrillic), otherwise the game font plus the
        /// dynamic chain. Never touches the game's asset itself.
        internal static void AssignFace(TMP_Text text, string lang, string value, string path)
        {
            if (text == null || string.IsNullOrEmpty(value)) return;
            try
            {
                TMP_FontAsset primary = text.font;
                if (primary == null) return;
                if (primary.name != null && primary.name.StartsWith("DXclone-", StringComparison.Ordinal))
                {
                    AttachChainTo(primary, lang);
                    return;
                }
                var missing = new List<uint>();
                for (int i = 0; i < value.Length; i++)
                {
                    char ch = value[i];
                    if (ch < 128 || ch == (char)10) continue;
                    if (SafeHas(primary, ch)) continue;
                    uint u = ch;
                    if (!missing.Contains(u)) missing.Add(u);
                }
                if (missing.Count == 0)
                {
                    AttachChainTo(primary, lang);
                    return;
                }
                TMP_FontAsset clone = CloneGameFace(primary);
                if (clone != null)
                {
                    // TMP grows the CLONE itself: LoadFontFace(game.sourceFontFile)
                    // works, and the clone has a fresh 2048 atlas + multi-atlas.
                    int addedToClone = 0;
                    try
                    {
                        uint[] stillMissing = null;
                        clone.TryAddCharacters(missing.ToArray(), out stillMissing, false);
                        addedToClone = missing.Count - (stillMissing != null ? stillMissing.Length : 0);
                    }
                    catch (Exception ex) { Log("Fonts: clone add error - " + ex.Message); }
                    AttachChainTo(clone, lang);
                    if (addedToClone > 0)
                    {
                        text.font = clone;
                        if (clone.material != null) text.fontSharedMaterial = clone.material;
                        if (AssignedReported.Add(text.GetInstanceID()))
                        {
                            bool plain = CharsVisible(text);
                            bool tagWorks = false;
                            if (!plain)
                            {
                                string saved = text.text;
                                text.text = "<color=#FFFFFF>" + saved + "</color>";
                                tagWorks = CharsVisible(text);
                                if (!tagWorks) text.text = saved;
                            }
                            Log("Fonts: assign font='" + clone.name + "' source='" + primary.name
                                + "' glyphs=" + (clone.characterTable != null ? clone.characterTable.Count : -1)
                                + " material='" + (clone.material != null ? clone.material.name : "?")
                                + "' fallbacks=" + (clone.fallbackFontAssetTable != null ? clone.fallbackFontAssetTable.Count : 0)
                                + " added=" + addedToClone
                                + " colorTagWorks=" + (!plain && tagWorks) + " plainWorks=" + plain
                                + " on " + path);
                        }
                        return;
                    }
                }
                // The game font cannot grow (Orbitron has no Cyrillic): put a
                // CLONE of the game's own Roboto Condensed in front of the
                // dynamic chain, so Cyrillic keeps the game's drawing/material.
                TMP_FontAsset gameLatin = GameLatinFace(missing);
                AttachChainTo(primary, lang);
                if (gameLatin != null)
                {
                    var table = primary.fallbackFontAssetTable;
                    if (table == null) table = new List<TMP_FontAsset>();
                    if (table.Count == 0 || table[0] != gameLatin)
                    {
                        table.Remove(gameLatin);
                        table.Insert(0, gameLatin);
                        primary.fallbackFontAssetTable = table;
                        if (AssignedReported.Add(primary.GetInstanceID()))
                            Log("Fonts: fallbackFont='" + gameLatin.name + "' source='Roboto-Condensed_DialogueUI'"
                                + " glyphs=" + (gameLatin.characterTable != null ? gameLatin.characterTable.Count : -1)
                                + " material='" + (gameLatin.material != null ? gameLatin.material.name : "?")
                                + "' fallbacks=" + table.Count + " on '" + primary.name + "'");
                    }
                    if (AssignedReported.Add(text.GetInstanceID()))
                        Log("Fonts: fallback front font='" + gameLatin.name + "' (via fallback) source='" + primary.name
                            + "' colorTagWorks=False plainWorks=" + CharsVisible(text)
                            + " on " + path);
                }
            }
            catch (Exception ex) { Log("Fonts: assign face error - " + ex.Message); }
        }

        private static TMP_FontAsset _gameLatin;
        private static bool _gameLatinSearched;

        /// Clone of the game's own Roboto Condensed (the dialogue face), used
        /// for Cyrillic when the primary game font has no such glyphs.
        private static TMP_FontAsset GameLatinFace(List<uint> missing)
        {
            if (!_gameLatinSearched)
            {
                _gameLatinSearched = true;
                try
                {
                    foreach (var f in Resources.FindObjectsOfTypeAll<TMP_FontAsset>())
                    {
                        if (f == null || f.sourceFontFile == null) continue;
                        string src = f.sourceFontFile.name ?? "";
                        if (src.IndexOf("Roboto-Condensed", StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            _gameLatin = f;
                            break;
                        }
                    }
                }
                catch { }
            }
            if (_gameLatin == null) return null;
            TMP_FontAsset clone = CloneGameFace(_gameLatin);
            if (clone == null) return null;
            try
            {
                uint[] still = null;
                clone.TryAddCharacters(missing.ToArray(), out still, false);
            }
            catch { }
            AttachChainTo(clone, _lastLang);
            return clone;
        }

        private static bool CharsVisible(TMP_Text text)
        {
            try
            {
                text.ForceMeshUpdate();
                var ti = text.textInfo;
                if (ti == null) return false;
                for (int i = 0; i < ti.characterCount; i++)
                {
                    var ci = ti.characterInfo[i];
                    if (ci.character <= 127) continue;
                    // "drawn by an asset" is the honest signal; isVisible also
                    // depends on the canvas being on screen this frame.
                    return ci.fontAsset != null;
                }
            }
            catch { }
            return false;
        }

        private static int resolvedCount(TMP_FontAsset asset, List<uint> chars)
        {
            int n = 0;
            try { foreach (uint u in chars) if (asset.HasCharacter((char)u)) n++; } catch { }
            return n;
        }

        /// Attach the dynamic chain (SC -> JP -> KR -> marks, plus our latin
        /// face as the last resort) to a game asset or a clone.
        internal static void AttachChainTo(TMP_FontAsset primary, string lang)
        {
            if (primary == null) return;
            _lastLang = lang ?? _lastLang;
            Primaries.Add(primary);
            try
            {
                List<TMP_FontAsset> table = primary.fallbackFontAssetTable;
                if (table == null) table = new List<TMP_FontAsset>();
                bool changed = false;
                foreach (string key in NeonFontCore.FallbackOrder(lang))
                {
                    TMP_FontAsset a = AssetForLang(LangForFaceKey(key), primary);
                    if (a == null || a == primary) continue;
                    if (!table.Contains(a)) { table.Add(a); changed = true; }
                }
                if (changed)
                {
                    primary.fallbackFontAssetTable = table;
                    int id = primary.GetInstanceID();
                    if (FallbacksReported.Add(id))
                        Log("Fonts: fallbacks on '" + primary.name + "' -> " + Describe(table));
                }
            }
            catch (Exception ex) { Log("Fonts: attach chain error - " + ex.Message); }
        }

        // ------------------------------------------------ specimen / demo API

        /// Face that draws the script's own text (zh/ja/ko, otherwise latin).
        internal static TMP_FontAsset FaceForScript(string script)
        {
            string lang = (script == "zh" || script == "ja" || script == "ko") ? script : "en";
            return AssetForLang(lang, null);
        }

        /// True when ANY face of the chain can rasterise the character.
        internal static bool ChainHas(string lang, char ch)
        {
            foreach (string key in NeonFontCore.FallbackOrder(lang))
            {
                TMP_FontAsset a = AssetForLang(LangForFaceKey(key), null);
                if (a == null || a.characterTable == null) continue;
                if (a.HasCharacter(ch)) return true;
            }
            return false;
        }

        /// Add the characters of `text` to one specific face asset (used by the
        /// hidden font page, which draws with standalone candidate faces).
        internal static int EnsureChars(TMP_FontAsset asset, string text)
        {
            Face f;
            if (asset == null || string.IsNullOrEmpty(text) ||
                !FaceByAssetId.TryGetValue(asset.GetInstanceID(), out f)) return 0;
            var list = new List<uint>();
            var seen = new HashSet<uint>();
            for (int i = 0; i < text.Length; i++)
            {
                char ch = text[i];
                if (ch < 128 || ch == (char)10 || ch == (char)13) continue;
                if (seen.Add(ch)) list.Add(ch);
            }
            return list.Count == 0 ? 0 : AddChars(f, list, false, null);
        }

        /// Top up every chain face with the characters of `text`.
        internal static void EnsureChainChars(string lang, string text)
        {
            if (string.IsNullOrEmpty(text)) return;
            var list = new List<uint>();
            var seen = new HashSet<uint>();
            for (int i = 0; i < text.Length; i++)
            {
                char ch = text[i];
                if (ch < 128 || ch == (char)10 || ch == (char)13) continue;
                if (seen.Add(ch)) list.Add(ch);
            }
            if (list.Count > 0) CoverChain(lang, null, list);
        }

        /// Build a standalone face for the font-demo compare tab.
        internal static TMP_FontAsset BuildStandalone(string file, string name, int pointSize, int atlasSize)
        {
            var f = new Face
            {
                Key = name,
                File = file,
                Family = null,
                PointSize = pointSize,
                Padding = 5,
                AtlasSize = atlasSize,
            };
            return BuildFace(f, null);
        }

        /// Swap the latin face of the chain (session-only, never persisted).
        internal static void ApplyLatinOverride(TMP_FontAsset asset)
        {
            _latinOverride = asset;
            foreach (TMP_FontAsset primary in new List<TMP_FontAsset>(Primaries))
            {
                try
                {
                    List<TMP_FontAsset> list = primary.fallbackFontAssetTable;
                    if (list == null) continue;
                    list.RemoveAll(delegate (TMP_FontAsset a)
                    {
                        return a == null || a.name == null || a.name.StartsWith("DX-", StringComparison.Ordinal);
                    });
                    primary.fallbackFontAssetTable = list;
                    AttachFallbacks(primary, _lastLang);
                }
                catch { }
            }
            Log("FontDemo: latin face = '" + (asset != null ? asset.name : "?") + "' (session only, not saved)");
        }

        // ------------------------------------------------------------ helpers

        private static object GetField(object obj, string name)
        {
            FieldInfo f = obj.GetType().GetField(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            return f != null ? f.GetValue(obj) : null;
        }

        private static void SetField(object obj, string name, object value)
        {
            FieldInfo f = obj.GetType().GetField(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            if (f != null) f.SetValue(obj, value);
        }

        internal static void Log(string message)
        {
            TranslatorPlugin.Log(message);
        }
    }
}
