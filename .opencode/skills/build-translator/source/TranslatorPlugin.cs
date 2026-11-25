using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using TMPro;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.TextCore;
using UnityEngine.UI;

namespace NeonTranslatorDX
{
    public static class TranslatorPlugin
    {
        private static Dictionary<string, string> _translations;
        private static bool _initialized;
        private static string _logPath;
        private static string _currentLang = "en";
        private static TMP_FontAsset _cyrillicFont;
        private static int _fontInitDelay = -1;

        private static List<Component> _cachedComponents;
        private static bool _cacheValid = false;
        private static Dictionary<Component, string> _componentOriginalText;
        private static Dictionary<Component, string> _originalTexts;
        private static HashSet<string> _injectedGuids;
        private static Dictionary<string, string> _guidEnglish;
        private static Transform _switcherRoot;
        private static Type _lmType;
        private static Type _lineType;
        private static Type _uiLocType;
        private static Type _tmpType;
        private static Type _legacyType;

        private static FieldInfo _dictField;
        private static FieldInfo _onLangChangedField;
        private static FieldInfo _guidField;
        private static FieldInfo _origTextField;
        private static FieldInfo _lineIdField;
        private static FieldInfo _origTextJsonField;
        private static FieldInfo _textJsonField;

        private static FieldInfo _textMTextField;
        private static FieldInfo _tmpMTextField;
        private static FieldInfo _tmpHavePropChangedField;

        private static MethodInfo _setTextMethod;
        private static IDictionary _guidDict;
        private static bool _reflectionReady = false;


        // All runtime assets live next to the DLL (one mod folder), fonts in
        // its `fonts/` subfolder. Nothing is looked up in Managed/ any more.
        private static string FontsDir(string dllDir)
        {
            return Path.Combine(dllDir, "fonts");
        }

        private static uint RegisterFontFile(string dllDir, string fileName)
        {
            // GDI registration only (no Unity objects): safe to call early.
            try
            {
                string path = Path.Combine(FontsDir(dllDir), fileName);
                if (!File.Exists(path)) return 0;
                byte[] data = File.ReadAllBytes(path);
                uint added;
                IntPtr h = NativeMethods.AddFontMemResourceEx(data, (uint)data.Length, IntPtr.Zero, out added);
                if (h != IntPtr.Zero) Log("Font: registered " + fileName + " (" + added + ")");
                return added;
            }
            catch (Exception ex) { Log("Font: register error (" + fileName + ") - " + ex.Message); return 0; }
        }

        private static void RegisterShippedFonts(string dllDir)
        {
            RegisterFontFile(dllDir, "RobotoCondensed-Regular.ttf");
            RegisterFontFile(dllDir, "NotoSansSC.ttf");
            RegisterFontFile(dllDir, "NotoSansJP.ttf");
            RegisterFontFile(dllDir, "NotoSansKR.ttf");
            RegisterFontFile(dllDir, "NotoSansMarks.ttf");
        }

        private static void PreloadTranslationCharset(TMP_FontAsset target)
        {
            // Dictionary charset warm-up for the active language. The glyphs go
            // into our own dynamic face (NeonFonts), not into the game's static
            // atlas: TMP cannot grow it (FontEngine cannot re-read an OS font).
            if (_translations == null) return;
            TMP_FontAsset primary = target;
            if (primary == null)
            {
                try
                {
                    var all = Resources.FindObjectsOfTypeAll<TMP_FontAsset>();
                    foreach (var f in all) if (f.name == "Roboto-Condensed_DialogueUI") { primary = f; break; }
                    if (primary == null && all.Length > 0) primary = all[0];
                }
                catch { }
            }
            NeonFonts.PreloadChain(_currentLang, primary, _translations);
        }

        private static void TryInstallFonts()
        {
            if (_cyrillicFont != null) return;
            try
            {
                TMP_FontAsset primary = null;
                var all = Resources.FindObjectsOfTypeAll<TMP_FontAsset>();
                foreach (var f in all) if (f.name == "Roboto-Condensed_DialogueUI") { primary = f; break; }
                if (primary == null && all.Length > 0) primary = all[0];

                TMP_FontAsset face = NeonFonts.AssetForLang(_currentLang, primary);
                if (face == null) { _fontInitDelay = 10; return; }

                if (primary != null) NeonFonts.AttachFallbacks(primary, _currentLang);
                PreloadTranslationCharset(primary);

                _cyrillicFont = face;
                NeonTypography.LogPolicy(_currentLang);
                int baked = primary != null && primary.characterTable != null ? primary.characterTable.Count : 0;
                int dynamicChars = face.characterTable != null ? face.characterTable.Count : 0;
                Log("Font: chain '" + (primary != null ? primary.name : "?") + "' baked " + baked
                    + " -> dynamic " + face.name + " " + dynamicChars
                    + " (total " + (baked + dynamicChars) + " glyphs)");
                Log("Font: initialization complete (" + face.name + " chars " + dynamicChars + ")");
            }
            catch (Exception ex)
            {
                Log("Font: error - " + ex);
                _fontInitDelay = 10;
            }
        }

        private static string GetLogPath()
        {
            string dllPath = Assembly.GetExecutingAssembly().Location;
            string dllDir = Path.GetDirectoryName(dllPath);
            return Path.Combine(dllDir, "NeonTranslatorDX.log");
        }

        // Log master switch (no rebuild needed): create `nolog.txt` next to
        // the DLL to silence NeonTranslatorDX.log, delete it to resume.
        // The flag is re-checked at most once per 2 seconds.
        private static bool _logEnabled = true;
        private static int _logFlagNextCheck = 0;

        internal static void Log(string message)
        {
            try
            {
                int now = Environment.TickCount;
                if (now - _logFlagNextCheck >= 0)
                {
                    _logFlagNextCheck = now + 2000;
                    try
                    {
                        string dllDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
                        bool off = File.Exists(Path.Combine(dllDir, "nolog.txt"));
                        if (off == _logEnabled)
                        {
                            _logEnabled = !off;
                            if (_logEnabled)
                                File.AppendAllText(GetLogPath(), "Log: enabled\n");
                        }
                    }
                    catch { }
                }
                if (!_logEnabled) return;
                File.AppendAllText(GetLogPath(), message + "\n");
            }
            catch { }
        }

        public static string Translate(string original)
        {
            if (_translations != null && original != null)
            {
                string translated;
                if (_translations.TryGetValue(original, out translated))
                    return translated;
            }
            return null;
        }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void Initialize()
        {
            try
            {
                Log("Init at " + DateTime.Now);

                if (!_initialized)
                {
                    _initialized = true;
                    string dllDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
                    // <game>/mods/NeonTranslatorDX -> <game>
                    string gameDir = Path.GetDirectoryName(Path.GetDirectoryName(dllDir));
                    string lang = "en";
                    try
                    {
                        string langFile = Path.Combine(dllDir, "active_lang.txt");
                        if (File.Exists(langFile))
                        {
                            string cfg = File.ReadAllText(langFile).Trim().ToLowerInvariant();
                            if (cfg.Length == 2)
                                lang = cfg;
                        }
                    }
                    catch { }
                    _translations = TranslationLoader.Load(dllDir, gameDir, lang);
                    _currentLang = lang;
                    Log("Lang: " + lang + ", source: " + TranslationLoader.LoadedSource);
                    Log("Translations: " + (_translations != null ? _translations.Count.ToString() : "null"));
                    RegisterShippedFonts(dllDir);
                    NeonFonts.Configure(dllDir);
                    NeonTypography.Configure(dllDir);
                }

                InitReflection();
                SceneManager.sceneLoaded += OnSceneLoaded;
                Canvas.willRenderCanvases += OnPreRender;

                var go = new GameObject("NeonTranslator_Scanner");
                go.hideFlags = HideFlags.HideAndDontSave;
                GameObject.DontDestroyOnLoad(go);
                go.AddComponent<NeonLateUpdate>();
                go.AddComponent<NeonLanguageSwitcher>();

                Log("Init done");
                DumpAllTextComponents();

                InvalidateCache();
                ScanAllUiLocs();
                PopulateAllText();

                DumpTranslationsToFile();

                // Schedule deferred font init (SDF gen is heavy, delay a few frames)
                _fontInitDelay = 5;
            }
            catch (Exception ex)
            {
                Log("ERROR: " + ex.ToString());
            }
        }

        private static void OnSceneLoaded(Scene scene, LoadSceneMode mode)
        {
            Log("Scene loaded: " + scene.name);
            if (_cyrillicFont == null && _fontInitDelay == -1)
                _fontInitDelay = 3;
            PurgeDeadOriginals();
            InvalidateCache();
            ScanAllUiLocs();
            PopulateAllText();
            DumpTranslationsToFile();
        }

        private static void InitReflection()
        {
            if (_reflectionReady) return;
            _lmType = GetType("ANToolkit.Localization.LanguageManager");
            _lineType = GetType("ANToolkit.Localization.TranslationJsonLine");
            _uiLocType = GetType("ANToolkit.Localization.UILocalization");
            _tmpType = GetType("TMPro.TMP_Text");
            _legacyType = GetType("UnityEngine.UI.Text");

            if (_lmType == null || _lineType == null || _uiLocType == null)
            { Log("Refl: types not found"); return; }

            _dictField = _lmType.GetField("_guidToTranslationDictionary",
                BindingFlags.Static | BindingFlags.NonPublic);
            _onLangChangedField = _lmType.GetField("OnLanguageChanged",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            _guidField = _uiLocType.GetField("guid",
                BindingFlags.Public | BindingFlags.Instance) ??
                _uiLocType.GetField("guid", BindingFlags.NonPublic | BindingFlags.Instance);
            _origTextField = _uiLocType.GetField("_originalText",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);

            _lineIdField = _lineType.GetField("lineId");
            _origTextJsonField = _lineType.GetField("originalText");
            _textJsonField = _lineType.GetField("text");

            _setTextMethod = _uiLocType.GetMethod("SetTextToTranslation",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);

            if (_dictField == null || _guidField == null)
            { Log("Refl: fields not found"); return; }

            if (_legacyType != null)
                _textMTextField = _legacyType.GetField("m_Text",
                    BindingFlags.Instance | BindingFlags.NonPublic);
            if (_tmpType != null)
                _tmpMTextField = _tmpType.GetField("m_text",
                    BindingFlags.Instance | BindingFlags.NonPublic) ??
                    _tmpType.GetField("m_Text",
                    BindingFlags.Instance | BindingFlags.NonPublic);
            if (_tmpType != null)
                _tmpHavePropChangedField = _tmpType.GetField("m_havePropertiesChanged",
                    BindingFlags.Instance | BindingFlags.NonPublic);

            _reflectionReady = true;
            Log("Refl: ready");
        }

        private static IDictionary GetOrCreateGuidDict()
        {
            if (_guidDict != null) return _guidDict;
            var val = _dictField.GetValue(null) as IDictionary;
            if (val == null)
            {
                val = (IDictionary)Activator.CreateInstance(typeof(Dictionary<string, IDictionary>));
                _dictField.SetValue(null, val);
            }
            _guidDict = val;
            return val;
        }

        private static IDictionary GetLangDict(string lang)
        {
            var outer = GetOrCreateGuidDict();
            if (outer.Contains(lang))
            {
                var inner = outer[lang] as IDictionary;
                if (inner != null) return inner;
            }
            var innerDictType = typeof(Dictionary<,>).MakeGenericType(typeof(string), _lineType);
            var innerDict = (IDictionary)Activator.CreateInstance(innerDictType);
            outer[lang] = innerDict;
            return innerDict;
        }

        private static void SetJsonField(FieldInfo field, object obj, object val)
        {
            if (field != null) field.SetValue(obj, val);
        }

        private static void AddTranslation(string guid, string english, string russian)
        {
            if (_injectedGuids == null) _injectedGuids = new HashSet<string>();
            if (_guidEnglish == null) _guidEnglish = new Dictionary<string, string>();
            _injectedGuids.Add(guid);
            _guidEnglish[guid] = english;

            var ruDict = GetLangDict("Russian");
            var enDict = GetLangDict("English");

            if (!ruDict.Contains(guid))
            {
                var ruLine = Activator.CreateInstance(_lineType);
                SetJsonField(_lineIdField, ruLine, guid);
                SetJsonField(_origTextJsonField, ruLine, english);
                SetJsonField(_textJsonField, ruLine, russian);
                ruDict[guid] = ruLine;
            }

            if (!enDict.Contains(guid))
            {
                var enLine = Activator.CreateInstance(_lineType);
                SetJsonField(_lineIdField, enLine, guid);
                SetJsonField(_origTextJsonField, enLine, english);
                SetJsonField(_textJsonField, enLine, russian);
                enDict[guid] = enLine;
            }
        }

        private static void TriggerLanguageChanged()
        {
            if (_onLangChangedField == null) return;
            var unityEvent = _onLangChangedField.GetValue(null);
            if (unityEvent == null) return;
            var invokeMethod = unityEvent.GetType().GetMethod("Invoke", Type.EmptyTypes);
            if (invokeMethod != null) invokeMethod.Invoke(unityEvent, null);
        }

        private static void ScanAllUiLocs()
        {
            if (!_reflectionReady) return;

            try
            {
                var uiLocs = UnityEngine.Object.FindObjectsOfType(_uiLocType, true);
                int added = 0;

                if (_componentOriginalText == null)
                    _componentOriginalText = new Dictionary<Component, string>();

                foreach (var uiLoc in uiLocs)
                {
                    string g = _guidField.GetValue(uiLoc) as string;
                    if (string.IsNullOrEmpty(g)) continue;

                    var go = ((Component)uiLoc).gameObject;
                    Component textComp = null;
                    if (_tmpType != null) textComp = go.GetComponent(_tmpType);
                    if (textComp == null && _legacyType != null) textComp = go.GetComponent(_legacyType);
                    if (textComp == null && _tmpType != null) textComp = go.GetComponentInChildren(_tmpType, true);
                    if (textComp == null && _legacyType != null) textComp = go.GetComponentInChildren(_legacyType, true);
                    if (textComp == null) continue;

                    // Use _originalText from UILocalization (always stores the English original)
                    string orig = _origTextField != null
                        ? (_origTextField.GetValue(uiLoc) as string ?? "")
                        : GetText(textComp);
                    if (string.IsNullOrEmpty(orig)) continue;
                    orig = orig.Trim();

                    // Cache original text for PopulateAllText fallback
                    _componentOriginalText[textComp] = orig;

                    if (_translations.ContainsKey(orig))
                    {
                        var outer = GetOrCreateGuidDict();
                        bool alreadyInRussian = false;
                        if (outer.Contains("Russian"))
                        {
                            var ruDict = outer["Russian"] as IDictionary;
                            if (ruDict != null && ruDict.Contains(g)) alreadyInRussian = true;
                        }

                        if (!alreadyInRussian)
                        {
                            AddTranslation(g, orig, _translations[orig]);
                            added++;
                        }
                    }
                }

                if (added > 0)
                {
                    Log("ScanAll: added " + added + " new GUID translations");
                    TriggerLanguageChanged();
                }
            }
            catch (Exception ex)
            {
                Log("ScanAll error: " + ex.Message);
            }
        }

        internal static string GetText(Component c)
        {
            if (c == null) return null;
            var prop = c.GetType().GetProperty("text");
            if (prop == null) return null;
            return prop.GetValue(c) as string;
        }

        internal static void SetTextFieldDirect(Component c, string value)
        {
            if (c == null) return;
            var prop = c.GetType().GetProperty("text");
            if (prop != null && prop.CanWrite)
            {
                prop.SetValue(c, value);
            }
        }

        private static List<Component> FindAllTextComponents()
        {
            var result = new List<Component>();
            if (_tmpType != null)
            {
                var found = UnityEngine.Object.FindObjectsOfType(_tmpType);
                foreach (var obj in found)
                {
                    result.Add((Component)obj);
                }
            }
            if (_legacyType != null)
            {
                var found = UnityEngine.Object.FindObjectsOfType(_legacyType);
                foreach (var obj in found)
                {
                    result.Add((Component)obj);
                }
            }
            return result;
        }

        private static Regex _richTagRx = new Regex("<[^>]+>", RegexOptions.Compiled);

        private static string StripRichTags(string s)
        {
            if (string.IsNullOrEmpty(s)) return s;
            return _richTagRx.Replace(s, "");
        }

        private static int _logDetailCount = 0;

        private static void PopulateAllText()
        {
            if (_translations == null) return;

            if (!_cacheValid)
            {
                _cachedComponents = FindAllTextComponents();
                _cacheValid = true;
            }

            int replaced = 0;
            if (_originalTexts == null) _originalTexts = new Dictionary<Component, string>();
            foreach (var c in _cachedComponents)
            {
                if (c == null) continue;
                if (IsSwitcherOwned(c)) continue;
                if (NeonFontDebug.Owns(c)) continue;
                string current = GetText(c);
                string lookup = StripRichTags(current).Trim();
                if (string.IsNullOrEmpty(lookup))
                {
                    string cachedOrig;
                    if (_componentOriginalText != null && _componentOriginalText.TryGetValue(c, out cachedOrig))
                    {
                        current = cachedOrig;
                        lookup = StripRichTags(current).Trim();
                        SetTextFieldDirect(c, current);
                    }
                    else
                    {
                        continue;
                    }
                }
                string translated;
                if (!_originalTexts.ContainsKey(c))
                    _originalTexts[c] = current;
                if (_translations.TryGetValue(lookup, out translated) && translated != lookup)
                {
                    if (_logDetailCount < 200)
                    {
                        _logDetailCount++;
                        Log("Populate: '" + Truncate(lookup, 60) + "' -> '" + Truncate(translated, 80) + "' on " + GetTransformPath(c.transform));
                    }
                    // Missing glyphs (cyrillic, CJK, accents) come from our
                    // runtime faces through TMP's fallback chain.
                    string popPath = GetTransformPath(c.transform);
                    var tmpComp = c as TMP_Text;
                    if (tmpComp != null)
                    {
                        NeonFonts.EnsureText(tmpComp, _currentLang, translated);
                        NeonFonts.AssignFace(tmpComp, _currentLang, translated, popPath);
                    }
                    SetTextFieldDirect(c, translated);
                    ApplyTypography(c, popPath, lookup);
                    replaced++;
                }
            }
            if (replaced > 0)
                Log("Populate: replaced " + replaced + " texts");
        }

        private static int _renderProofCount;

        /// Proof of WHICH font asset actually rasterises the translated glyphs:
        /// TMP resolves fallbacks during mesh generation, so `textInfo` is the
        /// only honest answer (the component's `font` stays the game's asset).
        private static void ProveRender(TMP_Text tmp, string path, string value)
        {
            if (tmp == null || value == null || _renderProofCount >= 12) return;
            bool nonAscii = false;
            for (int i = 0; i < value.Length; i++) if (value[i] > 127) { nonAscii = true; break; }
            if (!nonAscii) return;
            try
            {
                tmp.ForceMeshUpdate();
                var ti = tmp.textInfo;
                if (ti == null) return;
                for (int i = 0; i < ti.characterCount; i++)
                {
                    var ci = ti.characterInfo[i];
                    if (ci.character <= 127) continue;
                    _renderProofCount++;
                    Log("RenderProof: '" + ci.character + "' U+" + ((int)ci.character).ToString("X4")
                        + " asset='" + (ci.fontAsset != null ? ci.fontAsset.name : "?") + "'"
                        + " component.font='" + (tmp.font != null ? tmp.font.name : "?") + "'"
                        + " on " + path);
                    return;
                }
            }
            catch (Exception ex) { Log("RenderProof: error - " + ex.Message); }
        }

        private static void ApplyTypography(Component c, string path, string englishOriginal)
        {
            // Every replaced UI string goes through the typography policy (CJK
            // size/line) and then the fit rule. Dialogue wraps freely, so its
            // width is the box: the fit rule is a no-op there, the CJK size
            // bonus still applies.
            if (c == null) return;
            var tmp = c as TMP_Text;
            if (tmp != null)
            {
                // Fixed-width plates are the main-menu buttons; everything else
                // gets the CJK size/line bonus but keeps its authored size.
                bool plate = path != null && path.IndexOf("Main Menu") >= 0;
                NeonFit.ApplyTmp(tmp, _currentLang, plate, englishOriginal);
                ProveRender(tmp, path, tmp.text);
                return;
            }
            var legacy = c as UnityEngine.UI.Text;
            if (legacy != null) NeonFit.ApplyLegacy(legacy, _currentLang);
        }

        private static string Truncate(string s, int max)
        {
            if (s == null) return "null";
            if (s.Length <= max) return s;
            return s.Substring(0, max) + "...";
        }

        private static void InvalidateCache()
        {
            _cacheValid = false;
            _componentOriginalText = null;
        }

        public static void PopulateAllTextPublic()
        {
            PopulateAllText();
        }

        public static string CurrentLanguage
        {
            get { return _currentLang; }
        }

        internal static void SetSwitcherRoot(Transform root)
        {
            _switcherRoot = root;
        }

        private static bool IsSwitcherOwned(Component c)
        {
            if (_switcherRoot == null || c == null) return false;
            try { return c.transform.IsChildOf(_switcherRoot); }
            catch { return false; }
        }

        public static void SetLanguage(string lang)
        {
            try
            {
                if (string.IsNullOrEmpty(lang)) return;
                lang = lang.Trim().ToLowerInvariant();
                if (lang.Length != 2) return;

                string dllDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
                try { File.WriteAllText(Path.Combine(dllDir, "active_lang.txt"), lang); }
                catch (Exception ex) { Log("SetLanguage: cannot persist active_lang.txt - " + ex.Message); }

                _currentLang = lang;
                _logDetailCount = 0;
                _translations = TranslationLoader.Reload(lang);
                NeonFonts.ResetEnsured();
                Log("Lang switched: " + lang + ", source: " + TranslationLoader.LoadedSource);
                Log("Translations: " + (_translations != null ? _translations.Count.ToString() : "null"));
                if (_cyrillicFont != null) PreloadTranslationCharset(_cyrillicFont);

                RestoreOriginalTexts();
                RefreshGuidTranslations();
                InvalidateCache();
                ScanAllUiLocs();
                PopulateAllText();
                }
            catch (Exception ex)
            {
                Log("SetLanguage error: " + ex.Message);
            }
        }

        private static void RestoreOriginalTexts()
        {
            if (_originalTexts == null) return;
            try
            {
                var dead = new List<Component>();
                foreach (var kv in _originalTexts)
                {
                    if (kv.Key == null) { dead.Add(kv.Key); continue; }
                    if (IsSwitcherOwned(kv.Key)) continue;
                    SetTextFieldDirect(kv.Key, kv.Value);
                }
                foreach (var d in dead) _originalTexts.Remove(d);
            }
            catch (Exception ex)
            {
                Log("RestoreOriginalTexts error: " + ex.Message);
            }
        }

        private static void PurgeDeadOriginals()
        {
            if (_originalTexts == null) return;
            try
            {
                var dead = new List<Component>();
                foreach (var kv in _originalTexts)
                    if (kv.Key == null) dead.Add(kv.Key);
                foreach (var d in dead) _originalTexts.Remove(d);
            }
            catch { }
        }

        private static void RefreshGuidTranslations()
        {
            if (!_reflectionReady) return;
            try
            {
                var outer = GetOrCreateGuidDict();
                if (outer == null) return;
                IDictionary ruDict = outer.Contains("Russian") ? outer["Russian"] as IDictionary : null;
                IDictionary enDict = outer.Contains("English") ? outer["English"] as IDictionary : null;
                if (ruDict == null && enDict == null) return;
                if (_injectedGuids == null || _guidEnglish == null) return;

                foreach (string g in new List<string>(_injectedGuids))
                {
                    string eng;
                    if (!_guidEnglish.TryGetValue(g, out eng) || string.IsNullOrEmpty(eng))
                        continue;
                    string tr;
                    string best = (_translations != null && _translations.TryGetValue(eng, out tr))
                        ? tr : eng;
                    if (ruDict != null && ruDict.Contains(g))
                        SetJsonField(_textJsonField, ruDict[g], best);
                    if (enDict != null && enDict.Contains(g))
                        SetJsonField(_textJsonField, enDict[g], best);
                }
                TriggerLanguageChanged();
            }
            catch (Exception ex)
            {
                Log("RefreshGuidTranslations error: " + ex.Message);
            }
        }

        private static void OnPreRender()
        {
            if (_fontInitDelay > 0)
            {
                _fontInitDelay--;
                if (_fontInitDelay == 0)
                {
                    TryInstallFonts();
                    string modDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
                    // UI-metric dump (uiprobe.txt) and hidden font page
                    // (fontdebug.txt) are debug-only; normal play logs neither.
                    if (File.Exists(Path.Combine(modDir, "uiprobe.txt"))) NeonUiProbe.Run();
                    NeonFontDebug.OpenIfConfigured(modDir);
                }
            }
            InvalidateCache();
            ScanAllUiLocs();
            PopulateAllText();
        }

        private static void DumpAllTextComponents()
        {
            try
            {
                var all = FindAllTextComponents();
                Log("Dump: found " + all.Count + " text components");
                int dumped = 0;
                foreach (var c in all)
                {
                    if (dumped >= 20) { Log("Dump: ... (" + (all.Count - dumped) + " more)"); break; }
                    string txt = GetText(c);
                    if (!string.IsNullOrEmpty(txt))
                    {
                        Log("Dump: [" + GetTransformPath(c.transform) + "] = '" + txt + "'");
                        dumped++;
                    }
                }
                // Dialogue box typography probe (font/material/richText decide styling).
                try
                {
                    foreach (var c in all)
                    {
                        string path = GetTransformPath(c.transform);
                        if (path == null || path.IndexOf("DialogueCanvas") < 0) continue;
                        string type = c.GetType().FullName;
                        string detail = "";
                        try
                        {
                            var tmp = c as TMP_Text;
                            if (tmp != null)
                                detail = "richText=" + tmp.richText + " font=" +
                                    (tmp.font != null ? tmp.font.name : "?") + " mat=" +
                                    (tmp.fontSharedMaterial != null ? tmp.fontSharedMaterial.name : "?");
                        }
                        catch { }
                        Log("DialogueProbe: [" + path + "] " + type + " " + detail);
                    }
                }
                catch (Exception ex) { Log("DialogueProbe error: " + ex.Message); }
            }
            catch (Exception ex) { Log("Dump error: " + ex.Message); }
        }

        internal static void DumpTranslationsToFile()
        {
            try
            {
                if (!_reflectionReady)
                {
                    Log("DumpTranslations: reflection not ready");
                    return;
                }

                string dllDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
                string dumpPath = Path.Combine(dllDir, "dump_GUIDictionary.json");

                using (var sw = new StreamWriter(dumpPath, false))
                {
                    sw.WriteLine("{\"LanguageManager\": {");

                    var fields = _lmType.GetFields(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
                    bool first = true;
                    foreach (var f in fields)
                    {
                        if (!first) sw.WriteLine(",");
                        first = false;
                        object val = null;
                        try { val = f.GetValue(null); } catch { val = "<cannot read>"; }
                        string valStr = val != null ? val.ToString() : "null";
                        if (valStr.Length > 500) valStr = valStr.Substring(0, 500) + "...";
                        sw.Write("  \"" + EscapeJson(f.Name) + "\": \"" + EscapeJson(valStr) + "\"");
                    }

                    sw.WriteLine("},\"UILocalizations\": [");

                    try {
                        var uiLocs = UnityEngine.Object.FindObjectsOfType(_uiLocType, true);
                        bool firstLoc = true;
                        int dumped = 0;
                        foreach (var uiLoc in uiLocs)
                        {
                            if (dumped >= 100) { sw.WriteLine(",..."); break; }
                            dumped++;
                            if (!firstLoc) sw.WriteLine(",");
                            firstLoc = false;
                            string g = _guidField.GetValue(uiLoc) as string ?? "";
                            string orig = _origTextField != null ? _origTextField.GetValue(uiLoc) as string ?? "" : "";
                            Component c = (Component)uiLoc;
                            string path = GetTransformPath(c.transform);
                            sw.Write("    {\"guid\":\"" + EscapeJson(g) + "\",\"originalText\":\"" + EscapeJson(orig)
                                + "\",\"path\":\"" + EscapeJson(path) + "\"}");
                        }
                    } catch (Exception ex) { sw.Write("    \"" + EscapeJson(ex.Message) + "\""); }

                    sw.WriteLine("\n  ]\n}");
                }

                Log("DumpTranslations: wrote " + dumpPath);
            }
            catch (Exception ex)
            {
                Log("DumpTranslations error: " + ex.ToString());
            }
        }

        private static string EscapeJson(string s)
        {
            if (s == null) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"")
                    .Replace("\n", "\\n").Replace("\r", "\\r").Replace("\t", "\\t");
        }

        private static string GetTransformPath(Transform t)
        {
            if (t == null) return "null";
            string path = t.name;
            Transform p = t.parent;
            while (p != null)
            {
                path = p.name + "/" + path;
                p = p.parent;
            }
            return path;
        }

        private static Type GetType(string typeName)
        {
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                var t = asm.GetType(typeName);
                if (t != null) return t;
            }
            return null;
        }
    }
}
