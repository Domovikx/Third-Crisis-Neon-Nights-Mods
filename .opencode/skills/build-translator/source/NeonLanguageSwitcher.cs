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
    // In-game language switcher: F9 (or the mini-button) opens a panel with
    // one button per patch_*.dat found next to the runtime DLL (mod folder),
    // + native English.
    // Switching is live: dictionary reload + UI repopulate, no restart.
    // Own texts are excluded from scan-and-replace via SetSwitcherRoot.
    public class NeonLanguageSwitcher : MonoBehaviour
    {
        // One row per language: code + native name + English name (a player
        // who cannot read the script still finds their language).
        private static readonly string[][] Langs = new string[][]
        {
            new string[] { "en", "English", "English" },
            new string[] { "ru", "Русский", "Russian" },
            new string[] { "de", "Deutsch", "German" },
            new string[] { "pl", "Polski", "Polish" },
            new string[] { "fr", "Français", "French" },
            new string[] { "es", "Español", "Spanish" },
            new string[] { "pt", "Português", "Portuguese" },
            new string[] { "it", "Italiano", "Italian" },
            new string[] { "uk", "Українська", "Ukrainian" },
            new string[] { "ja", "日本語", "Japanese" },
            new string[] { "zh", "中文", "Chinese" },
            new string[] { "ko", "한국어", "Korean" },
        };

        private static string[] FindLang(string code)
        {
            foreach (string[] row in Langs)
                if (string.Equals(row[0], code, StringComparison.OrdinalIgnoreCase))
                    return row;
            return null;
        }

        private static readonly Color PanelColor = new Color(0.07f, 0.08f, 0.09f, 0.95f);
        private static readonly Color BorderColor = new Color(0f, 0f, 0f, 0.95f);
        private static readonly Color ButtonColor = new Color(0.16f, 0.17f, 0.19f, 1f);
        private static readonly Color ButtonHiColor = new Color(0.24f, 0.25f, 0.28f, 1f);
        private static readonly Color ButtonPressColor = new Color(0.1f, 0.11f, 0.12f, 1f);
        private static readonly Color ActiveButtonColor = new Color(0.13f, 0.45f, 0.24f, 1f);
        private static readonly Color MiniColor = new Color(0f, 0f, 0f, 0.6f);
        private static readonly Color HintColor = new Color(0.7f, 0.7f, 0.7f, 1f);

        private readonly KeyCode _toggleKey = KeyCode.F9;
        private List<string> _langs = new List<string>();
        private Canvas _canvas;
        private GameObject _panel;
        private Text _miniLabel;
        private readonly Dictionary<string, Button> _buttons = new Dictionary<string, Button>(StringComparer.OrdinalIgnoreCase);
        private Font _font;

        private static string RowLabel(string code)
        {
            string[] row = FindLang(code);
            if (row == null) return code.ToUpperInvariant();
            if (row[1] == row[2]) return row[1];
            return row[1] + " \u00b7 " + row[2];
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
                TranslatorPlugin.Log("Switcher: ready (" + string.Join(",", _langs.ToArray()) + ")");
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
                if (Input.GetKeyDown(_toggleKey) && _panel != null)
                    _panel.SetActive(!_panel.activeSelf);
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

        private void DiscoverLanguages()
        {
            _langs.Clear();
            _langs.Add("en");
            try
            {
                string dllDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
                string[] files = Directory.GetFiles(dllDir, "patch_*.dat");
                var codes = new List<string>();
                foreach (string f in files)
                {
                    string name = Path.GetFileNameWithoutExtension(f);
                    if (name != null && name.Length > 6)
                    {
                        string code = name.Substring(6).Trim().ToLowerInvariant();
                        if (code.Length == 2 && code != "en" && !codes.Contains(code))
                            codes.Add(code);
                    }
                }
                codes.Sort();
                _langs.AddRange(codes);
            }
            catch (Exception ex)
            {
                TranslatorPlugin.Log("Switcher discover error: " + ex.Message);
            }
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

        private Text MakeText(GameObject parent, string content, int size, TextAnchor align, bool bold, Font font)
        {
            var go = new GameObject("Text");
            go.transform.SetParent(parent.transform, false);
            var t = go.AddComponent<Text>();
            t.font = font != null ? font : _font;
            t.fontSize = size;
            t.color = Color.white;
            t.alignment = align;
            if (bold) t.fontStyle = FontStyle.Bold;
            t.text = content;
            return t;
        }

        private static void Place(RectTransform rt, float ax, float ay, float x, float y, float w, float h)
        {
            rt.anchorMin = new Vector2(ax, ay);
            rt.anchorMax = new Vector2(ax, ay);
            rt.anchoredPosition = new Vector2(x, y);
            rt.sizeDelta = new Vector2(w, h);
        }

        private static void Fill(RectTransform rt)
        {
            rt.anchorMin = Vector2.zero;
            rt.anchorMax = Vector2.one;
            rt.offsetMin = Vector2.zero;
            rt.offsetMax = Vector2.zero;
        }

        private Text MakeLabel(GameObject parent, string content, int size, TextAnchor align, bool bold, float padLeft, Font font)
        {
            Text t = MakeText(parent, content, size, align, bold, font);
            RectTransform rt = t.GetComponent<RectTransform>();
            Fill(rt);
            if (padLeft > 0f) rt.offsetMin = new Vector2(padLeft, 0f);
            return t;
        }

        private Button MakeButtonShell(GameObject parent, string name, Color bg, UnityEngine.Events.UnityAction onClick)
        {
            var go = new GameObject(name);
            go.transform.SetParent(parent.transform, false);
            var img = go.AddComponent<Image>();
            img.color = bg;
            var btn = go.AddComponent<Button>();
            var cb = btn.colors;
            cb.normalColor = bg;
            cb.highlightedColor = ButtonHiColor;
            cb.pressedColor = ButtonPressColor;
            cb.selectedColor = bg;
            cb.fadeDuration = 0f;
            btn.colors = cb;
            btn.onClick.AddListener(onClick);
            return btn;
        }

        private static Font RowFont(string code, Font fallback)
        {
            // Each row renders in its own script: the row itself proves
            // whether that language's font is available (tofu = missing).
            try
            {
                if (code == "zh")
                {
                    Font f = Font.CreateDynamicFontFromOSFont("Noto Sans SC", 18);
                    if (f != null) return f;
                }
                if (code == "ja")
                {
                    Font f = Font.CreateDynamicFontFromOSFont("Noto Sans JP", 18);
                    if (f != null) return f;
                }
                if (code == "ko")
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

        private Button MakeButton(GameObject parent, string label, float w, float h, UnityEngine.Events.UnityAction onClick, Font labelFont)
        {
            Button btn = MakeButtonShell(parent, "Button", ButtonColor, onClick);
            MakeLabel(btn.gameObject, label, 18, TextAnchor.MiddleLeft, false, 20f, labelFont);
            btn.GetComponent<RectTransform>().sizeDelta = new Vector2(w, h);
            return btn;
        }

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

        private void BuildUi()
        {
            // CJK-capable UI font first (menu shows 日本語/中文/한국어 labels):
            // shipped TTFs are GDI-registered at Initialize, before any Start.
            _font = Font.CreateDynamicFontFromOSFont("Noto Sans SC", 16);
            if (_font == null)
                _font = FindLegacyFont("NotoSansSC-Medium");
            if (_font == null)
                _font = Font.CreateDynamicFontFromOSFont("Arial", 16);
            if (_font == null)
                _font = Resources.GetBuiltinResource<Font>("Arial.ttf");
            if (_font != null) TranslatorPlugin.Log("Switcher: UI font = " + _font.name);

            var canvasGo = new GameObject("NeonTranslator_LangUI");
            canvasGo.transform.SetParent(transform, false);
            _canvas = canvasGo.AddComponent<Canvas>();
            _canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            _canvas.sortingOrder = 32767;
            canvasGo.AddComponent<GraphicRaycaster>();

            // Mini-button, bottom-right, always visible.
            var miniBtn = MakeButtonShell(canvasGo, "MiniButton", MiniColor,
                delegate { if (_panel != null) _panel.SetActive(!_panel.activeSelf); });
            _miniLabel = MakeLabel(miniBtn.gameObject, "RU", 16, TextAnchor.MiddleCenter, true, 0f, _font);
            Place(miniBtn.GetComponent<RectTransform>(), 1f, 0f, -48f, 28f, 72f, 36f);

            // Border INSIDE the panel (first child = drawn behind content,
            // hidden together with it: no hanging square).
            float panelW = 400f;
            float panelH = 150f + _langs.Count * 48f;

            // Panel, centered, hidden by default.
            _panel = new GameObject("Panel");
            _panel.transform.SetParent(canvasGo.transform, false);
            var panelImg = _panel.AddComponent<Image>();
            panelImg.color = PanelColor;
            var panelRt = _panel.GetComponent<RectTransform>();
            Place(panelRt, 0.5f, 0.5f, 0f, 0f, panelW, panelH);

            var borderGo = new GameObject("Border");
            borderGo.transform.SetParent(_panel.transform, false);
            var borderImg = borderGo.AddComponent<Image>();
            borderImg.color = BorderColor;
            var borderRt = borderGo.GetComponent<RectTransform>();
            borderRt.anchorMin = Vector2.zero;
            borderRt.anchorMax = Vector2.one;
            borderRt.offsetMin = new Vector2(-4f, -4f);
            borderRt.offsetMax = new Vector2(4f, 4f);
            borderGo.transform.SetAsFirstSibling();

            // Plain neutral title (no accent strips: nothing alien to the game).
            var title = MakeText(_panel, "Language", 20, TextAnchor.MiddleLeft, true, _font);
            var titleRt = title.GetComponent<RectTransform>();
            titleRt.anchorMin = new Vector2(0f, 1f);
            titleRt.anchorMax = new Vector2(1f, 1f);
            titleRt.offsetMin = new Vector2(24f, -54f);
            titleRt.offsetMax = new Vector2(-68f, -14f);

            var closeBtn = MakeButtonShell(_panel, "Close", ButtonColor,
                delegate { _panel.SetActive(false); });
            MakeLabel(closeBtn.gameObject, "X", 18, TextAnchor.MiddleCenter, true, 0f, _font);
            var closeRt = closeBtn.GetComponent<RectTransform>();
            closeRt.anchorMin = new Vector2(1f, 1f);
            closeRt.anchorMax = new Vector2(1f, 1f);
            closeRt.anchoredPosition = new Vector2(-34f, -34f);
            closeRt.sizeDelta = new Vector2(44f, 36f);

            // One row per language: native name + English name (a player who
            // cannot read the script still finds their language).
            float y = -80f;
            foreach (string lang in _langs)
            {
                string code = lang;
                Button btn = MakeButton(_panel, RowLabel(code),
                    panelW - 48f, 40f, delegate { OnLangClicked(code); }, RowFont(code, _font));
                Place(btn.GetComponent<RectTransform>(), 0.5f, 1f, 0f, y, panelW - 48f, 40f);
                _buttons[code] = btn;
                y -= 48f;
            }

            var hint = MakeText(_panel, "Choose a language \u2022 F9 to close", 14, TextAnchor.MiddleCenter, false, _font);
            hint.color = HintColor;
            Place(hint.GetComponent<RectTransform>(), 0.5f, 0f, 0f, 26f, panelW - 20f, 24f);

            _panel.SetActive(false);
        }

        private void OnLangClicked(string code)
        {
            try
            {
                TranslatorPlugin.SetLanguage(code);
                RefreshHighlight();
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
                string cur = TranslatorPlugin.CurrentLanguage;
                if (_miniLabel != null)
                    _miniLabel.text = cur != null ? cur.ToUpperInvariant() : "?";
                foreach (var kv in _buttons)
                {
                    var colors = kv.Value.colors;
                    colors.normalColor = string.Equals(kv.Key, cur, StringComparison.OrdinalIgnoreCase)
                        ? ActiveButtonColor : ButtonColor;
                    kv.Value.colors = colors;
                }
            }
            catch { }
        }
    }
}
