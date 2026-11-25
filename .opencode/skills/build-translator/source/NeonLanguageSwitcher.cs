using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.SceneManagement;
using UnityEngine.UI;

namespace NeonTranslatorDX
{
    // In-game language switcher (F9 / the mini-button in the corner).
    //
    // Layout (2026-11-25 redesign): a rounded neon card docked to the BOTTOM
    // RIGHT corner, two columns of language rows, native names only, current
    // language highlighted in the game's pink accent. It is sized and anchored
    // so it never covers the main-menu buttons, at 1920x1080 and 1600x900.
    // Language order comes from config/language-priority.json (guarded by
    // .opencode/skills/build-translator/tests/menu.test.mts).
    // Own texts are excluded from scan-and-replace via SetSwitcherRoot.
    public class NeonLanguageSwitcher : MonoBehaviour
    {
        // code, native name, English name — in language-priority order.
        private static readonly string[][] Langs = new string[][]
        {
            new string[] { "en", "English", "English" },
            new string[] { "zh", "\u4e2d\u6587", "Chinese" },
            new string[] { "ru", "\u0420\u0443\u0441\u0441\u043a\u0438\u0439", "Russian" },
            new string[] { "es", "Espa\u00f1ol", "Spanish" },
            new string[] { "pt", "Portugu\u00eas", "Portuguese" },
            new string[] { "de", "Deutsch", "German" },
            new string[] { "ja", "\u65e5\u672c\u8a9e", "Japanese" },
            new string[] { "fr", "Fran\u00e7ais", "French" },
            new string[] { "pl", "Polski", "Polish" },
            new string[] { "ko", "\ud55c\uad6d\uc5b4", "Korean" },
            new string[] { "it", "Italiano", "Italian" },
        };

        // Game metrics (docs/ui-kit.md): buttons 420x72, gap 9, sharp corners,
        // black shadow, white plate + black Orbitron text. Our panel uses the
        // same rhythm on an 8 px grid: row 48, gap 8, padding 16/24.
        private const float PanelW = 360f;
        private const float PanelH = 436f;
        private const float Margin = 24f;
        private const float MiniH = 40f;
        private const float RowH = 48f;
        private const float RowGap = 8f;

        private readonly KeyCode _toggleKey = KeyCode.F9;
        private readonly List<string> _available = new List<string>();
        private readonly Dictionary<string, Button> _buttons = new Dictionary<string, Button>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, Image> _rowImgs = new Dictionary<string, Image>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, Text> _rowLabels = new Dictionary<string, Text>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, Image> _rowAccents = new Dictionary<string, Image>(StringComparer.OrdinalIgnoreCase);

        private Canvas _canvas;
        private GameObject _panel;
        private Text _miniLabel;
        private Image _miniDot;
        private Text _title;
        private Text _hint;
        private Font _font;
        private Font _fontBold;

        private static string[] FindLang(string code)
        {
            foreach (string[] row in Langs)
                if (string.Equals(row[0], code, StringComparison.OrdinalIgnoreCase))
                    return row;
            return null;
        }

        private void Start()
        {
            try
            {
                DiscoverLanguages();
                BuildUi();
                TranslatorPlugin.SetSwitcherRoot(_canvas.transform);
                EnsureEventSystem();
                SceneManager.sceneLoaded += OnSceneLoaded;
                RefreshHighlight();
                TranslatorPlugin.Log("Switcher: ready (" + string.Join(",", _available.ToArray()) + ")");
                // Debug/screenshot flag: `langpanel.txt` next to the DLL opens
                // the panel at start (normal play keeps it closed until F9).
                try
                {
                    string dllDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
                    if (File.Exists(Path.Combine(dllDir, "langpanel.txt"))) TogglePanel();
                }
                catch { }
            }
            catch (Exception ex)
            {
                TranslatorPlugin.Log("Switcher error: " + ex.Message);
            }
        }

        private void Update()
        {
            try
            {
                if (Input.GetKeyDown(KeyCode.Escape) && _panel != null && _panel.activeSelf)
                {
                    _panel.SetActive(false);
                    return;
                }
                if (Input.GetKeyDown(_toggleKey)) TogglePanel();
            }
            catch { }
        }

        private void OnSceneLoaded(Scene scene, LoadSceneMode mode)
        {
            try
            {
                EnsureEventSystem();
                RefreshHighlight();
            }
            catch { }
        }

        public static string DisplayName(string code)
        {
            string[] row = FindLang(code);
            return row != null ? row[1] : code.ToUpperInvariant();
        }

        /// Languages that actually have a dictionary next to the DLL (+ English).
        private void DiscoverLanguages()
        {
            _available.Clear();
            var have = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            have.Add("en");
            try
            {
                string dllDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
                foreach (string f in Directory.GetFiles(dllDir, "patch_*.dat"))
                {
                    string name = Path.GetFileNameWithoutExtension(f);
                    if (name != null && name.Length > 6)
                    {
                        string code = name.Substring(6).Trim().ToLowerInvariant();
                        if (code.Length == 2) have.Add(code);
                    }
                }
            }
            catch (Exception ex)
            {
                TranslatorPlugin.Log("Switcher discover error: " + ex.Message);
            }
            foreach (string[] row in Langs)
                if (have.Contains(row[0])) _available.Add(row[0]);
            if (!_available.Contains("en")) _available.Insert(0, "en");
        }

        private void EnsureEventSystem()
        {
            try
            {
                UnityEngine.Object found = FindObjectOfType(typeof(EventSystem));
                if (found != null) return;
                var go = new GameObject("NeonTranslator_EventSystem",
                    typeof(EventSystem), typeof(StandaloneInputModule));
                DontDestroyOnLoad(go);
            }
            catch (Exception ex)
            {
                TranslatorPlugin.Log("Switcher eventsystem error: " + ex.Message);
            }
        }

        // ---------------------------------------------------------------- fonts

        private static Font FindLegacyFont(string name)
        {
            try
            {
                foreach (Font f in Resources.FindObjectsOfTypeAll<Font>())
                    if (f != null && f.name == name) return f;
            }
            catch { }
            return null;
        }

        private static Font RowFont(string code, Font fallback)
        {
            // Each row renders in its own script: the row itself proves the
            // font is available (tofu would be visible immediately).
            try
            {
                if (code == "zh")
                {
                    Font f = Font.CreateDynamicFontFromOSFont("Noto Sans SC", 18);
                    if (f != null) return f;
                }
                else if (code == "ja")
                {
                    Font f = Font.CreateDynamicFontFromOSFont("Noto Sans JP", 18);
                    if (f != null) return f;
                }
                else if (code == "ko")
                {
                    Font f = Font.CreateDynamicFontFromOSFont("Noto Sans KR", 18);
                    if (f != null) return f;
                    f = Font.CreateDynamicFontFromOSFont("Malgun Gothic", 18);
                    if (f != null) return f;
                }
            }
            catch { }
            return fallback;
        }

        // ------------------------------------------------------------------- ui

        private void BuildUi()
        {
            // Roboto Condensed is the game's dialogue face (bundled with the mod
            // and GDI-registered at init): latin + cyrillic here, Noto per row
            // for CJK.
            _fontBold = Font.CreateDynamicFontFromOSFont("Roboto Condensed", 20);
            _font = _fontBold;
            if (_font == null) _font = FindLegacyFont("Roboto-Condensed");
            if (_font == null) _font = Font.CreateDynamicFontFromOSFont("Arial", 18);
            if (_font == null) _font = Resources.GetBuiltinResource<Font>("Arial.ttf");
            if (_font != null) TranslatorPlugin.Log("Switcher: UI font = " + _font.name);

            var canvasGo = new GameObject("NeonTranslator_LangUI");
            canvasGo.transform.SetParent(transform, false);
            _canvas = canvasGo.AddComponent<Canvas>();
            _canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            _canvas.sortingOrder = 32767;
            var scaler = canvasGo.AddComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(1920f, 1080f);
            scaler.screenMatchMode = CanvasScaler.ScreenMatchMode.MatchWidthOrHeight;
            scaler.matchWidthOrHeight = 0.5f;
            canvasGo.AddComponent<GraphicRaycaster>();

            BuildMiniButton(canvasGo);
            BuildPanel(canvasGo);
        }

        private void BuildMiniButton(GameObject canvasGo)
        {
            RectTransform rt = NeonUiKit.Node("MiniButton", canvasGo.transform);
            NeonUiKit.Place(rt, 1f, 0f, -Margin, Margin, 104f, MiniH);
            var bg = rt.gameObject.AddComponent<Image>();
            bg.sprite = NeonUiKit.Rounded(2, 64);
            bg.type = Image.Type.Sliced;
            bg.color = Color.white;
            var btn = rt.gameObject.AddComponent<Button>();
            var cb = btn.colors;
            cb.normalColor = Color.white;
            cb.highlightedColor = new Color(1.35f, 1.35f, 1.4f, 1f);
            cb.pressedColor = new Color(0.8f, 0.8f, 0.85f, 1f);
            cb.selectedColor = Color.white;
            cb.fadeDuration = 0.08f;
            btn.colors = cb;
            btn.targetGraphic = bg;
            btn.onClick.AddListener(TogglePanel);

            // Cyan hairline border, like the panel.
            RectTransform borderRt = NeonUiKit.Node("MiniButton Border", canvasGo.transform);
            NeonUiKit.Place(borderRt, 1f, 0f, -Margin - 1.5f, Margin - 1.5f, 107f, MiniH + 3f);
            var border = borderRt.gameObject.AddComponent<Image>();
            border.sprite = NeonUiKit.Rounded(3, 64);
            border.type = Image.Type.Sliced;
            border.color = new Color(0f, 0f, 0f, 0.9f);
            border.raycastTarget = false;
            borderRt.SetSiblingIndex(rt.GetSiblingIndex());

            RectTransform dotRt = NeonUiKit.Node("MiniDot", rt);
            NeonUiKit.Place(dotRt, 0f, 0.5f, 12f, -4f, 8f, 8f);
            _miniDot = dotRt.gameObject.AddComponent<Image>();
            _miniDot.sprite = NeonUiKit.Rounded(2, 32);
            _miniDot.type = Image.Type.Sliced;
            _miniDot.color = NeonUiKit.Pink;
            _miniDot.raycastTarget = false;

            _miniLabel = NeonUiKit.Label("MiniLabel", rt, "RU", 20, Color.black,
                TextAnchor.MiddleCenter, _fontBold, true);
            NeonUiKit.Fill(_miniLabel.rectTransform).offsetMin = new Vector2(20f, 0f);
        }

        private void BuildPanel(GameObject canvasGo)
        {
            _panel = new GameObject("Panel");
            _panel.transform.SetParent(canvasGo.transform, false);
            var panelRt = _panel.AddComponent<RectTransform>();
            // Docked bottom-right. Height 392 keeps the top edge below the
            // menu buttons' right margin: the panel is right of x=0.79*W,
            // the buttons end at ~0.76*W at every tested aspect.
            NeonUiKit.Place(panelRt, 1f, 0f, -Margin, Margin + MiniH + 20f, PanelW, PanelH);

            // Soft shadow behind the card.
            RectTransform shRt = NeonUiKit.Node("Panel Shadow", _panel.transform);
            var sh = shRt.gameObject.AddComponent<Image>();
            sh.sprite = NeonUiKit.Shadow(14, 96, 10);
            sh.type = Image.Type.Sliced;
            sh.color = new Color(0f, 0f, 0f, 0.55f);
            sh.raycastTarget = false;
            NeonUiKit.Fill(shRt).offsetMin = new Vector2(-10f, -16f);
            shRt.offsetMax = new Vector2(10f, 6f);

            // Card + neon hairline.
            var body = NeonUiKit.MakeCard("Panel Body", _panel.transform, NeonUiKit.PanelBg, 2);
            NeonUiKit.Fill(body.rectTransform);
            // The game outlines plates with a BLACK hairline; no cyan glow.
            NeonUiKit.Border(body.rectTransform, new Color(0f, 0f, 0f, 0.9f), 1.5f);

            // Accent stripe at the top of the card (pink -> cyan gradient is
            // faked with two solid segments, no shaders).
            RectTransform accent = NeonUiKit.Node("Accent", _panel.transform);
            NeonUiKit.Place(accent, 0f, 1f, 0f, 0f, 108f, 3f);
            var accentImg = accent.gameObject.AddComponent<Image>();
            accentImg.color = NeonUiKit.Pink;
            accentImg.raycastTarget = false;

            _title = NeonUiKit.Label("Title", _panel.transform, NeonUiStrings.Title(TranslatorPlugin.CurrentLanguage),
                22, NeonUiKit.TextColor, TextAnchor.MiddleLeft, _fontBold, true);
            NeonUiKit.Place(_title.rectTransform, 0f, 1f, 20f, -30f, 240f, 30f);

            var sub = NeonUiKit.Label("Sub", _panel.transform, "F9", 13,
                new Color(NeonUiKit.Cyan.r, NeonUiKit.Cyan.g, NeonUiKit.Cyan.b, 0.9f),
                TextAnchor.MiddleLeft, _font, false);
            NeonUiKit.Place(sub.rectTransform, 0f, 1f, 128f, -32f, 120f, 24f);

            BuildCloseButton();

            // Two columns, six rows (11 languages max today).
            float top = -68f;
            float cellW = (PanelW - 2f * 16f - 8f) / 2f;
            float cellH = RowH;
            float gapY = RowGap;
            for (int i = 0; i < Langs.Length; i++)
            {
                string code = Langs[i][0];
                int col = i % 2;
                int row = i / 2;
                float x = 16f + col * (cellW + 8f);
                float y = top - row * (cellH + gapY);
                BuildRow(code, x, y, cellW, cellH);
            }

            var hint = NeonUiKit.Label("Hint", _panel.transform,
                "F9 \u2014 close  \u00b7  click to switch", 12, NeonUiKit.MutedColor,
                TextAnchor.MiddleCenter, _font, false);
            NeonUiKit.Place(_hint.rectTransform, 0f, 0f, 0f, 14f, PanelW, 18f);

            _panel.SetActive(false);
        }

        private void BuildCloseButton()
        {
            RectTransform rt = NeonUiKit.Node("Close", _panel.transform);
            NeonUiKit.Place(rt, 1f, 1f, -20f, -20f, 30f, 30f);
            var bg = rt.gameObject.AddComponent<Image>();
            bg.sprite = NeonUiKit.Rounded(8, 64);
            bg.type = Image.Type.Sliced;
            bg.color = new Color(NeonUiKit.CardBg.r, NeonUiKit.CardBg.g, NeonUiKit.CardBg.b, 0.9f);
            var btn = rt.gameObject.AddComponent<Button>();
            var cb = btn.colors;
            cb.normalColor = Color.white;
            cb.highlightedColor = new Color(1.6f, 0.75f, 0.95f, 1f);
            cb.pressedColor = new Color(0.7f, 0.5f, 0.6f, 1f);
            cb.selectedColor = Color.white;
            cb.fadeDuration = 0.08f;
            btn.colors = cb;
            btn.targetGraphic = bg;
            btn.onClick.AddListener(delegate { if (_panel != null) _panel.SetActive(false); });

            var x = NeonUiKit.Label("CloseLabel", rt, "\u00d7", 20, NeonUiKit.MutedColor,
                TextAnchor.MiddleCenter, _font, false);
            NeonUiKit.Fill(x.rectTransform).offsetMin = new Vector2(0f, 2f);
        }

        private void BuildRow(string code, float x, float y, float w, float h)
        {
            bool available = _available.Contains(code);

            RectTransform rt = NeonUiKit.Node("Lang " + code, _panel.transform);
            NeonUiKit.Place(rt, 0f, 1f, x, y, w, h);
            var bg = rt.gameObject.AddComponent<Image>();
            bg.sprite = NeonUiKit.Rounded(2, 64);
            bg.type = Image.Type.Sliced;
            bg.color = available ? Color.white : new Color(1f, 1f, 1f, 0.35f);
            var hair = rt.gameObject.AddComponent<Outline>();
            hair.effectColor = new Color(0f, 0f, 0f, 0.85f);
            hair.effectDistance = new Vector2(1.5f, -1.5f);

            // Selected-state accent bar on the left (pink).
            RectTransform accentRt = NeonUiKit.Node("Accent", rt);
            accentRt.anchorMin = new Vector2(0f, 0f);
            accentRt.anchorMax = new Vector2(0f, 1f);
            accentRt.pivot = new Vector2(0f, 0.5f);
            accentRt.offsetMin = new Vector2(0f, 7f);
            accentRt.offsetMax = new Vector2(3f, -7f);
            var accent = accentRt.gameObject.AddComponent<Image>();
            accent.sprite = NeonUiKit.Rounded(2, 32);
            accent.type = Image.Type.Sliced;
            accent.color = new Color(NeonUiKit.Pink.r, NeonUiKit.Pink.g, NeonUiKit.Pink.b, 0f);
            accent.raycastTarget = false;

            string[] row = FindLang(code);
            // Game menu text = 36 px on a 72 px plate; our row is 48 -> 24 px
            // (CJK scale is applied on top by NeonFit).
            var label = NeonUiKit.Label("Label", rt, row != null ? row[1] : code.ToUpperInvariant(),
                Mathf.RoundToInt(RowH / 2f),
                available ? Color.black : new Color(0f, 0f, 0f, 0.4f),
                TextAnchor.MiddleLeft, RowFont(code, _font), false);
            NeonUiKit.Fill(label.rectTransform).offsetMin = new Vector2(14f, 0f);
            label.rectTransform.offsetMax = new Vector2(-34f, 0f);

            var badge = NeonUiKit.Label("Code", rt, code.ToUpperInvariant(), 12, new Color(0f, 0f, 0f, 0.45f),
                TextAnchor.MiddleRight, _font, false);
            NeonUiKit.Fill(badge.rectTransform).offsetMax = new Vector2(-10f, 0f);
            badge.rectTransform.offsetMin = new Vector2(0f, 0f);

            if (available)
            {
                var btn = rt.gameObject.AddComponent<Button>();
                var cb = btn.colors;
                cb.normalColor = Color.white;
                cb.highlightedColor = new Color(1.25f, 1.35f, 1.5f, 1f);
                cb.pressedColor = new Color(0.75f, 0.8f, 0.9f, 1f);
                cb.selectedColor = Color.white;
                cb.fadeDuration = 0.08f;
                btn.colors = cb;
                btn.targetGraphic = bg;
                string captured = code;
                btn.onClick.AddListener(delegate { OnLangClicked(captured); });
                _buttons[code] = btn;
            }

            _rowImgs[code] = bg;
            _rowLabels[code] = label;
            _rowAccents[code] = accent;
        }

        /// Open/close the panel. Row labels are fitted on open, when the layout
        /// already has a width (they carry the per-language CJK scale).
        private void TogglePanel()
        {
            if (_panel == null) return;
            _panel.SetActive(!_panel.activeSelf);
            if (_panel.activeSelf) FitRows();
        }

        // Row labels are fitted once the layout has a width (first open).
        private void FitRows()
        {
            foreach (var kv in _rowLabels)
                if (kv.Value != null) NeonFit.ApplyLegacy(kv.Value, kv.Key);
        }

        private void OnLangClicked(string code)
        {
            try
            {
                if (string.Equals(code, TranslatorPlugin.CurrentLanguage, StringComparison.OrdinalIgnoreCase))
                {
                    if (_panel != null) _panel.SetActive(false);
                    return;
                }
                TranslatorPlugin.SetLanguage(code);
                RefreshHighlight();
                FitRows();
            }
            catch (Exception ex)
            {
                TranslatorPlugin.Log("Switcher click error: " + ex.Message);
            }
        }

        private void RefreshHighlight()
        {
            try
            {
                string cur = TranslatorPlugin.CurrentLanguage ?? "en";
                if (_miniLabel != null) _miniLabel.text = cur.ToUpperInvariant();
                // Our own UI is localized too: the game gives the word for
                // "Language"; hint/apply live in NeonUiStrings.
                if (_title != null) _title.text = NeonUiStrings.Title(cur);
                if (_hint != null) _hint.text = NeonUiStrings.Hint(cur);
                if (_miniDot != null)
                    _miniDot.color = IsCjk(cur) ? NeonUiKit.Cyan : NeonUiKit.Pink;

                foreach (var kv in _rowImgs)
                {
                    bool selected = string.Equals(kv.Key, cur, StringComparison.OrdinalIgnoreCase);
                    bool available = _available.Contains(kv.Key);
                    var img = kv.Value;
                    if (img != null)
                    {
                        Color baseColor = available ? Color.white : new Color(1f, 1f, 1f, 0.35f);
                        img.color = selected ? new Color(1f, 0.94f, 0.97f, 1f) : baseColor;
                    }
                    Image accent;
                    if (_rowAccents.TryGetValue(kv.Key, out accent) && accent != null)
                        accent.color = new Color(NeonUiKit.Pink.r, NeonUiKit.Pink.g, NeonUiKit.Pink.b, selected ? 1f : 0f);

                    Text label;
                    if (_rowLabels.TryGetValue(kv.Key, out label) && label != null)
                    {
                        label.color = selected ? new Color(0.78f, 0.06f, 0.35f)
                            : available ? Color.black
                            : new Color(0f, 0f, 0f, 0.4f);
                        label.fontStyle = selected ? FontStyle.Bold : FontStyle.Normal;
                    }
                }
            }
            catch { }
        }

        private static bool IsCjk(string lang)
        {
            return lang == "zh" || lang == "ja" || lang == "ko";
        }
    }
}
