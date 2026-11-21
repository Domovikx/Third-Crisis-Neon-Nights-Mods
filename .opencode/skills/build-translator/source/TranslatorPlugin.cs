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

namespace NeonTranslator
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

        private static string _menuProbeLang = null;


        private static uint RegisterFontFile(string dllDir, string fileName)
        {
            // GDI registration only (no Unity objects): safe to call early.
            try
            {
                string path = Path.Combine(dllDir, fileName);
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
        }

        private static void PreloadTranslationCharset(TMP_FontAsset target)
        {
            // Exact glyph set for the active language, derived from the loaded
            // dictionary (PO/.dat are only read, never modified by font code).
            if (target == null || _translations == null) return;
            try
            {
                var seen = new HashSet<uint>();
                foreach (var kv in _translations)
                {
                    string s = kv.Value;
                    if (string.IsNullOrEmpty(s)) continue;
                    for (int i = 0; i < s.Length; i++)
                    {
                        char ch = s[i];
                        if (ch >= 0xD800 && ch <= 0xDBFF && i + 1 < s.Length) { i++; continue; } // surrogate half
                        if (ch < 128) continue; // ASCII already baked
                        seen.Add((uint)ch);
                        if (seen.Count >= 20000) break;
                    }
                    if (seen.Count >= 20000) break;
                }
                if (seen.Count == 0) return;
                uint[] arr = new uint[seen.Count];
                seen.CopyTo(arr);
                int before = 0, atlasW = 0, atlasH = 0;
                try
                {
                    before = target.characterTable != null ? target.characterTable.Count : -1;
                    var tex = target.atlasTexture;
                    if (tex != null) { atlasW = tex.width; atlasH = tex.height; }
                }
                catch { }
                bool ok = target.TryAddCharacters(arr);
                int after = before;
                try { after = target.characterTable != null ? target.characterTable.Count : -1; }
                catch { }
                Log("Font: preload " + target.name + " (" + arr.Length + ") = " + ok
                    + " chars " + before + "->" + after + " atlas " + atlasW + "x" + atlasH);
            }
            catch (Exception ex) { Log("Font: preload error - " + ex.Message); }
        }

        private static void TryInstallCyrillicFont()
        {
            if (_cyrillicFont != null) return;

            try
            {
                string dllDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
                string fontPath = Path.Combine(dllDir, "RobotoCondensed-Regular.ttf");

                // Register our TTF with Windows so Unity can use it
                Font unityFont = null;
                if (File.Exists(fontPath))
                {
                    byte[] fontData = File.ReadAllBytes(fontPath);
                    uint fontsAdded;
                    IntPtr fontHandle = NativeMethods.AddFontMemResourceEx(
                        fontData, (uint)fontData.Length, IntPtr.Zero, out fontsAdded);
                    if (fontHandle != IntPtr.Zero)
                        unityFont = Font.CreateDynamicFontFromOSFont("Roboto Condensed", 30);
                }

                if (unityFont == null)
                {
                    Log("Font: Roboto Condensed unavailable, using Arial");
                    unityFont = Font.CreateDynamicFontFromOSFont("Arial", 30);
                }
                if (unityFont == null) { Log("Font: no font available"); return; }

                // Find existing font asset to patch
                var allFonts = Resources.FindObjectsOfTypeAll<TMP_FontAsset>();
                TMP_FontAsset target = null;
                foreach (var f in allFonts)
                    if (f.name == "Roboto-Condensed_DialogueUI") { target = f; break; }

                if (target == null) { Log("Font: target not found"); _fontInitDelay = 10; return; }

                // One-shot introspection for the baked-atlas path (field names
                // for texture/table assignment differ across TMP versions).
                try
                {
                    var names = new List<string>();
                    foreach (var fld in typeof(TMP_FontAsset).GetFields(
                        BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
                        names.Add(fld.Name + ":" + fld.FieldType.Name);
                    Log("Font: TMP_FontAsset fields: " + string.Join(",", names.ToArray()));
                }
                catch (Exception ex) { Log("Font: introspect error - " + ex.Message); }

                // Single atlas: material presets (dialogue glow) stay bound to the
                // one texture. Multi-atlas would move new glyphs to extra textures
                // the presets cannot see (styles break on patched glyphs).
                // NOTE: atlas size is NOT resized here (read-only in this TMP);
                // shipped 1024 is tried as-is, result is logged for UI review.
                try { target.atlasPopulationMode = AtlasPopulationMode.Dynamic; } catch { }
                try { target.isMultiAtlasTexturesEnabled = false; } catch { }

                // Set source font file via reflection (setter may not be public)
                var sffField = typeof(TMP_FontAsset).GetField("sourceFontFile",
                    BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
                if (sffField != null && sffField.FieldType == typeof(Font))
                    sffField.SetValue(target, unityFont);
                Log("Font: set source font to " + unityFont.name);

                // Convert string to uint[] for TryAddCharacters.
                // Cyrillic (RU) + Latin-1 Supplement + Latin Extended-A (DE äöüß,
                // PL ąćęłńśźż, future FR/ES). Source TTF covers all of these.
                string cyrillicStr = "абвгдеёжзийклмнопрстуфхцчшщъыьэюяАБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ";
                uint[] unicodes = new uint[cyrillicStr.Length + 64 + 128];
                int n = 0;
                for (int i = 0; i < cyrillicStr.Length; i++)
                    unicodes[n++] = (uint)cyrillicStr[i];
                for (uint c = 0x00C0; c <= 0x00FF; c++)
                    unicodes[n++] = c;
                for (uint c = 0x0100; c <= 0x017F; c++)
                    unicodes[n++] = c;
                bool added = target.TryAddCharacters(unicodes);
                Log("Font: TryAddCharacters extended (" + n + ") = " + added);

                if (added)
                {
                    target.ReadFontAssetDefinition();
                    Log("Font: Cyrillic glyphs added to Roboto-Condensed_DialogueUI");
                }
                try { Log("Font: atlas " + target.atlasWidth + "x" + target.atlasHeight); }
                catch { }
                PreloadTranslationCharset(target);

                _cyrillicFont = target; // mark as done
                Log("Font: initialization complete");
            }
            catch (Exception ex)
            {
                Log("Font: error - " + ex.Message);
                _fontInitDelay = 10;
            }
        }

        private static string GetLogPath()
        {
            string dllPath = Assembly.GetExecutingAssembly().Location;
            string dllDir = Path.GetDirectoryName(dllPath);
            return Path.Combine(dllDir, "NeonTranslator.log");
        }

        // Log master switch (no rebuild needed): create `nolog.txt` next to
        // the DLL to silence NeonTranslator.log, delete it to resume.
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
            NeonCjkOverlay.Sweep();
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

        private static bool IsOverlayLabel(Component c)
        {
            try { return c != null && c.gameObject != null && c.gameObject.name == "NeonCJKOverlay"; }
            catch { return false; }
        }

        private static List<Component> FindAllTextComponents()
        {
            var result = new List<Component>();
            if (_tmpType != null)
            {
                var found = UnityEngine.Object.FindObjectsOfType(_tmpType);
                foreach (var obj in found)
                {
                    var c = (Component)obj;
                    if (IsOverlayLabel(c)) continue;
                    result.Add(c);
                }
            }
            if (_legacyType != null)
            {
                var found = UnityEngine.Object.FindObjectsOfType(_legacyType);
                foreach (var obj in found)
                {
                    var c = (Component)obj;
                    if (IsOverlayLabel(c)) continue;
                    result.Add(c);
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
                // Owned by the CJK overlay (holds a space) or an overlay
                // label itself: skip, the label already shows the translation.
                if (NeonCjkOverlay.IsOwned(c)) continue;
                if (c.gameObject != null && c.gameObject.name == "NeonCJKOverlay") continue;
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
                    // CJK menu + dialogue go through the overlay (their TMP
                    // fonts have no CJK glyphs); everything else is direct.
                    string popPath = GetTransformPath(c.transform);
                    if (!NeonCjkOverlay.TryOverlay(c, popPath, lookup, translated))
                        SetTextFieldDirect(c, translated);
                    ProbeMenuCjk(c, popPath, translated);
                    replaced++;
                }
            }
            if (replaced > 0)
                Log("Populate: replaced " + replaced + " texts");
            NeonCjkOverlay.Sweep();
        }

        private static void ProbeMenuCjk(Component c, string path, string translated)
        {
            // Once per language per area (menu button / dialogue line):
            // font + overlay state. Enough to tell "dictionary ok, label
            // shown" apart from "font missing".
            try
            {
                string area = null;
                if (path != null && path.IndexOf("Start Game Button") >= 0) area = "menu";
                else if (path != null && path.IndexOf("DialogueCanvas/Menu/TextBox/Text") >= 0
                    && path.IndexOf("ButtonPanel") < 0) area = "dlg";
                if (area == null) return;
                string key = _currentLang + "|" + area;
                if (_menuProbeLang == key) return;
                var tmp = c as TMP_Text;
                if (tmp == null) return;
                _menuProbeLang = key;
                string fontName = tmp.font != null ? tmp.font.name : "?";
                bool owned = NeonCjkOverlay.IsOwned(c);
                string labelInfo = "overlay=" + owned;
                try
                {
                    if (owned && c.gameObject != null)
                    {
                        var t = c.transform.Find("NeonCJKOverlay");
                        if (t == null && c.transform.childCount > 0)
                        {
                            for (int i = 0; i < c.transform.childCount; i++)
                            {
                                var ch = c.transform.GetChild(i);
                                if (ch != null && ch.name == "NeonCJKOverlay") { t = ch; break; }
                            }
                        }
                        if (t != null)
                        {
                            var lbl = t.GetComponent<UnityEngine.UI.Text>();
                            if (lbl != null)
                                labelInfo += " label='" + Truncate(lbl.text, 40) + "' font="
                                    + (lbl.font != null ? lbl.font.name : "?")
                                    + " active=" + t.gameObject.activeSelf;
                            else
                                labelInfo += " label=?";
                        }
                        else
                        {
                            labelInfo += " labelChild=?";
                        }
                    }
                }
                catch (Exception ex) { labelInfo += " err=" + ex.Message; }
                Log("MenuProbe: [" + path + "] lang=" + _currentLang
                    + " font=" + fontName + " " + labelInfo
                    + " (" + FontStatus(_currentLang) + ")");
            }
            catch { }
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

        internal static string FontStatus(string lang)
        {
            // Decisive availability probe: can Unity rasterize one char?
            // GetCharacterInfo returns false when the glyph is missing.
            try
            {
                string dllDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
                string file = lang == "ja" ? "NotoSansJP.ttf"
                    : lang == "zh" ? "NotoSansSC.ttf"
                    : lang == "ko" ? "NotoSansKR.ttf"
                    : "RobotoCondensed-Regular.ttf";
                bool exists = File.Exists(Path.Combine(dllDir, file));
                string[] families = lang == "ja" ? new string[] { "Noto Sans JP" }
                    : lang == "zh" ? new string[] { "Noto Sans SC" }
                    : lang == "ko" ? new string[] { "Noto Sans KR", "Malgun Gothic" }
                    : new string[] { "Roboto Condensed" };
                char probe = lang == "ja" ? 'あ' : lang == "zh" ? '新' : lang == "ko" ? '네' : 'Ж';
                foreach (string family in families)
                {
                    Font dyn = null;
                    try { dyn = Font.CreateDynamicFontFromOSFont(family, 32); } catch { }
                    if (dyn == null) continue;
                    CharacterInfo ci;
                    bool ok = false;
                    try { dyn.RequestCharactersInTexture(probe.ToString(), 32); } catch { }
                    try { ok = dyn.GetCharacterInfo(probe, out ci, 32); } catch { }
                    return lang + " file=" + exists + " dyn=" + family + " glyph=" + ok;
                }
                return lang + " file=" + exists + " dyn=False";
            }
            catch (Exception ex) { return lang + " ERR " + ex.Message; }
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
                Log("Lang switched: " + lang + ", source: " + TranslationLoader.LoadedSource);
                Log("Translations: " + (_translations != null ? _translations.Count.ToString() : "null"));
                if (_cyrillicFont != null) PreloadTranslationCharset(_cyrillicFont);

                RestoreOriginalTexts();
                NeonCjkOverlay.ClearAll();
                RefreshGuidTranslations();
                InvalidateCache();
                ScanAllUiLocs();
                PopulateAllText();
                NeonCjkOverlay.Sweep();
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
                    TryInstallCyrillicFont();
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
