using System;
using System.Collections.Generic;
using System.IO;
using TMPro;
using UnityEngine;
using UnityEngine.UI;

namespace NeonTranslatorDX
{
    // Hidden debug page (Ctrl+F12, or `fontdebug.txt` next to the DLL):
    //   tab 1 "Specimen" — every script of the corpus drawn with the SAME face
    //   the mod actually assigns, with per-script glyph/tofu counters;
    //   tab 2 "Compare" — candidate fonts side by side on identical samples,
    //   with an Apply button that swaps the latin face for this session only.
    //
    // Nothing here is persisted and nothing is shown in normal play.
    internal static class NeonFontDebug
    {
        private const int CanvasOrder = 32766;
        private const float PageW = 1840f;
        private const float PageH = 1000f;

        private static GameObject _root;
        private static RectTransform _page;
        private static GameObject _specimenPage;
        private static GameObject _comparePage;
        private static TMP_Text _title;
        private static TMP_Text _summary;
        private static TMP_Text _hint;
        private static bool _built;
        private static int _tab; // 0 specimen, 1 compare
        private static Font _uiFont;

        private static readonly List<Block> Blocks = new List<Block>();
        private static readonly List<Demo> Demos = new List<Demo>();
        private static readonly Dictionary<string, Section> Sections = new Dictionary<string, Section>();

        private sealed class Section
        {
            public string Script;
            public string Lang;
            public string Text;
            public string FaceName;
            public int Total;
            public int Ok;
        }

        private sealed class Block
        {
            public RectTransform Rt;
            public TMP_Text Head;
            public TMP_Text Body;
        }

        private sealed class Demo
        {
            public string File;
            public string Name;
            public long Size;
            public TMP_FontAsset Asset;
            public TMP_Text Sample;
            public Text Meta;
            public bool Failed;
        }

        private static readonly string[] CandidateFiles =
        {
            "RobotoCondensed-Regular.ttf",
            "Roboto-Regular.ttf",
            "Inter.ttf",
            "NotoSans-Regular.ttf",
            "IBMPlexSans-Regular.ttf",
            "SourceSans3-Regular.ttf",
        };

        // ------------------------------------------------------------- open/close

        internal static bool IsOpen { get { return _root != null && _root.activeSelf; } }

        internal static void HandleInput()
        {
            bool ctrl = Input.GetKey(KeyCode.LeftControl) || Input.GetKey(KeyCode.RightControl);
            if (ctrl && Input.GetKeyDown(KeyCode.F12)) { Toggle(); return; }
            if (!IsOpen) return;
            if (Input.GetKeyDown(KeyCode.Escape)) { Close(); return; }
            if (Input.GetKeyDown(KeyCode.Tab)) { _tab = _tab == 0 ? 1 : 0; ShowTab(); }
        }

        internal static void Toggle()
        {
            if (IsOpen) { Close(); return; }
            Open();
        }

        internal static void Open()
        {
            try
            {
                if (!_built) Build();
                if (_root == null) return;
                _root.SetActive(true);
                Refresh();
                TranslatorPlugin.Log("specimen: page opened (tab " + (_tab == 0 ? "specimen" : "compare") + ")");
            }
            catch (Exception ex) { TranslatorPlugin.Log("specimen: open error - " + ex); }
        }

        internal static void Close()
        {
            if (_root != null) _root.SetActive(false);
            TranslatorPlugin.Log("specimen: page closed");
        }

        /// `fontdebug.txt` next to the DLL opens the page at startup.
        internal static void OpenIfConfigured(string dllDir)
        {
            try
            {
                string flag = Path.Combine(dllDir, "fontdebug.txt");
                if (!File.Exists(flag)) return;
                try
                {
                    string want = File.ReadAllText(flag).Trim().ToLowerInvariant();
                    if (want == "compare" || want == "candidates") _tab = 1;
                }
                catch { }
                Open();
            }
            catch { }
        }

        internal static bool Owns(Component c)
        {
            try { return c != null && _root != null && c.transform.IsChildOf(_root.transform); }
            catch { return false; }
        }

        // ---------------------------------------------------------------- content

        private static void Build()
        {
            _built = true;
            _uiFont = Font.CreateDynamicFontFromOSFont("Roboto Condensed", 18);
            if (_uiFont == null) _uiFont = Resources.GetBuiltinResource<Font>("Arial.ttf");

            var canvasGo = new GameObject("NeonTranslator_FontDebug");
            canvasGo.transform.SetParent(null, false);
            UnityEngine.Object.DontDestroyOnLoad(canvasGo);
            var canvas = canvasGo.AddComponent<Canvas>();
            canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            canvas.sortingOrder = CanvasOrder;
            var scaler = canvasGo.AddComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(1920f, 1080f);
            scaler.screenMatchMode = CanvasScaler.ScreenMatchMode.MatchWidthOrHeight;
            scaler.matchWidthOrHeight = 0.5f;
            canvasGo.AddComponent<GraphicRaycaster>();
            _root = canvasGo;

            var backdrop = NeonUiKit.MakeCard("Backdrop", canvasGo.transform, new Color(0f, 0f, 0f, 0.94f), 0);
            NeonUiKit.Fill(backdrop.rectTransform);
            backdrop.raycastTarget = true;

            var page = NeonUiKit.MakeCard("Page", canvasGo.transform, NeonUiKit.PanelBg, 4);
            _page = page.rectTransform;
            _page.anchorMin = new Vector2(0.5f, 0.5f);
            _page.anchorMax = new Vector2(0.5f, 0.5f);
            _page.pivot = new Vector2(0.5f, 0.5f);
            _page.sizeDelta = new Vector2(PageW, PageH);
            _page.anchoredPosition = Vector2.zero;

            _title = Tmp("Title", _page, "FONT SPECIMEN", 26, NeonUiKit.TextColor, FontStyles.Bold, true);
            NeonUiKit.Place(_title.rectTransform, 0f, 1f, 24f, -36f, 900f, 34f);
            _summary = Tmp("Summary", _page, "", 16, NeonUiKit.Cyan, FontStyles.Normal, true);
            NeonUiKit.Place(_summary.rectTransform, 0f, 1f, 24f, -66f, 1700f, 24f);
            _hint = Tmp("Hint", _page, "Tab — compare · Ctrl+F12 / Esc — close · nothing is saved", 14,
                NeonUiKit.MutedColor, FontStyles.Normal, true);
            NeonUiKit.Place(_hint.rectTransform, 0f, 1f, 24f, -92f, 1700f, 22f);

            TabButton("TabSpecimen", "Specimen", -250f, delegate { _tab = 0; Refresh(); TranslatorPlugin.Log("specimen: tab=specimen (click)"); });
            TabButton("TabCompare", "Compare", -130f, delegate { _tab = 1; Refresh(); TranslatorPlugin.Log("specimen: tab=compare (click)"); });

            _specimenPage = new GameObject("Specimen");
            _specimenPage.transform.SetParent(_page, false);
            Fill(_specimenPage.AddComponent<RectTransform>(), 24f, 118f, 24f, 24f);

            BuildSections();
            BuildSpecimenLayout();

            _comparePage = new GameObject("Compare");
            _comparePage.transform.SetParent(_page, false);
            Fill(_comparePage.AddComponent<RectTransform>(), 24f, 118f, 24f, 24f);
            _comparePage.SetActive(false);

            _root.SetActive(false);
        }

        private static void TabButton(string name, string label, float x, UnityEngine.Events.UnityAction onClick)
        {
            RectTransform rt = NeonUiKit.Node(name, _page);
            NeonUiKit.Place(rt, 1f, 1f, x, -24f, 112f, 30f);
            var bg = rt.gameObject.AddComponent<Image>();
            bg.sprite = NeonUiKit.Rounded(2, 64);
            bg.type = Image.Type.Sliced;
            bg.color = NeonUiKit.CardBg;
            var btn = rt.gameObject.AddComponent<Button>();
            var cb = btn.colors;
            cb.normalColor = Color.white;
            cb.highlightedColor = new Color(1.3f, 1.4f, 1.5f, 1f);
            cb.pressedColor = new Color(0.8f, 0.85f, 0.95f, 1f);
            cb.selectedColor = Color.white;
            cb.fadeDuration = 0.08f;
            btn.colors = cb;
            btn.targetGraphic = bg;
            btn.onClick.AddListener(onClick);
            var t = NeonUiKit.Label("Label", rt, label, 15, NeonUiKit.TextColor, TextAnchor.MiddleCenter, _uiFont, false);
            NeonUiKit.Fill(t.rectTransform);
        }

        private static void BuildSpecimenLayout()
        {
            string[] left = { "cyrillic", "latin", "marks", "lorem" };
            string[] right = { "zh", "ja", "ko" };
            BuildColumn(left, 0f, (PageW - 72f) / 2f);
            BuildColumn(right, (PageW - 72f) / 2f + 24f, (PageW - 72f) / 2f);
        }

        private static void BuildColumn(string[] scripts, float x, float width)
        {
            float y = 0f;
            foreach (string script in scripts)
            {
                Section s = Sections[script];
                var block = new GameObject("Block " + script);
                block.transform.SetParent(_specimenPage.transform, false);
                var rt = block.AddComponent<RectTransform>();
                rt.anchorMin = new Vector2(0f, 1f);
                rt.anchorMax = new Vector2(0f, 1f);
                rt.pivot = new Vector2(0f, 1f);
                rt.anchoredPosition = new Vector2(x, -y);
                rt.sizeDelta = new Vector2(width, 40f);

                var head = Tmp("Head", rt, "", 17, NeonUiKit.Cyan, FontStyles.Bold, false);
                NeonUiKit.Place(head.rectTransform, 0f, 1f, 0f, 0f, width, 22f);
                var body = Tmp("Body", rt, "", 18, NeonUiKit.TextColor, FontStyles.Normal, false);
                NeonUiKit.Place(body.rectTransform, 0f, 1f, 0f, -24f, width, 40f);
                body.enableWordWrapping = true;
                body.overflowMode = TextOverflowModes.Overflow;

                Blocks.Add(new Block { Rt = rt, Head = head, Body = body });
                y += 40f;
            }
        }

        private static TMP_Text Tmp(string name, Transform parent, string text, float size, Color color,
            FontStyles style, bool uiFont)
        {
            var go = new GameObject(name);
            go.transform.SetParent(parent, false);
            var t = go.AddComponent<TextMeshProUGUI>();
            t.text = text;
            t.fontSize = size;
            t.color = color;
            t.fontStyle = style;
            t.richText = true;
            t.raycastTarget = false;
            t.alignment = TextAlignmentOptions.TopLeft;
            t.overflowMode = TextOverflowModes.Overflow;
            if (uiFont)
            {
                TMP_FontAsset f = NeonFonts.FaceForScript("lat");
                if (f != null)
                {
                    t.font = f;
                    if (f.material != null) t.fontSharedMaterial = f.material;
                }
            }
            return t;
        }

        private static void Fill(RectTransform rt, float left, float top, float right, float bottom)
        {
            rt.anchorMin = Vector2.zero;
            rt.anchorMax = Vector2.one;
            rt.offsetMin = new Vector2(left, bottom);
            rt.offsetMax = new Vector2(-right, -top);
        }

        // ------------------------------------------------------------ specimen

        private static void BuildSections()
        {
            string dllDir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
            string cyr = "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ" + "\n"
                + "абвгдеёжзийклмнопрстуфхцчшщъыьэюя" + "\n" + "«»„“”…—–№";
            string lat = "ABCDEFGHIJKLMNOPQRSTUVWXYZ" + "\n" + "abcdefghijklmnopqrstuvwxyz" + "\n"
                + "0123456789 !?.,:;()[]{}%$#@&*+-=/\\_|~^'`" + "\n"
                + "äöüßąćęłńóśźżàçèéêîôùûœ";
            string zh = Corpus(Path.Combine(dllDir, "patch_zh.dat"), IsHan, 300) + "\n" + "，。！？；：“”（）《》";
            string ja = Kana() + "\n" + Corpus(Path.Combine(dllDir, "patch_ja.dat"), IsHan, 300) + "\n" + "、。「」『』！？";
            string ko = Corpus(Path.Combine(dllDir, "patch_ko.dat"), IsHangul, 300) + "\n" + "，。！？";
            string marks = "I\u0334 \u0335w\u0338o\u0334n\u0336'\u0336t\u0336 \u0334l\u0335e\u0338t\u0334 \u0335y\u0334o\u0338u\u0336.\u0336";
            string lorem = "Съешь же ещё этих мягких французских булок, да выпей чаю. "
                + "Широкая электрификация южных губерний даст мощный толчок подъёму сельского хозяйства." + "\n"
                + "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.";

            Add("cyrillic", "ru", cyr);
            Add("latin", "ru", lat);
            Add("marks", "ru", marks);
            Add("lorem", "ru", lorem);
            Add("zh", "zh", zh);
            Add("ja", "ja", ja);
            Add("ko", "ko", ko);
        }

        private static void Add(string script, string lang, string text)
        {
            Sections[script] = new Section { Script = script, Lang = lang, Text = text };
        }

        private static string Kana()
        {
            var sb = new System.Text.StringBuilder();
            for (char c = '\u3041'; c <= '\u3096'; c++) sb.Append(c);
            sb.Append('\n');
            for (char c = '\u30A1'; c <= '\u30FA'; c++) sb.Append(c);
            return sb.ToString();
        }

        private static bool IsHan(char c) { return c >= '\u4E00' && c <= '\u9FFF'; }
        private static bool IsHangul(char c) { return c >= '\uAC00' && c <= '\uD7A3'; }

        /// First `max` unique characters of a category from a deployed patch.
        private static string Corpus(string path, Func<char, bool> accept, int max)
        {
            var seen = new HashSet<char>();
            var list = new List<char>();
            try
            {
                if (!File.Exists(path)) return "";
                string text = File.ReadAllText(path, System.Text.Encoding.UTF8);
                foreach (char c in text)
                {
                    if (!accept(c) || !seen.Add(c)) continue;
                    list.Add(c);
                    if (list.Count >= max) break;
                }
            }
            catch (Exception ex) { TranslatorPlugin.Log("specimen: corpus error " + ex.Message); }
            return new string(list.ToArray());
        }

        private static void Refresh()
        {
            if (!_built) return;
            _title.text = _tab == 0 ? "FONT SPECIMEN" : "FONT CANDIDATES";
            _hint.text = _tab == 0
                ? "Tab — compare · Ctrl+F12 / Esc — close · red = tofu (no face in the chain has it)"
                : "Tab — specimen · Ctrl+F12 / Esc — close · " + NeonUiStrings.Apply(TranslatorPlugin.CurrentLanguage)
                  + " swaps the latin face for this session only";
            if (_tab == 0) RefreshSpecimen();
            else RefreshCompare();
            ShowTab();
        }

        private static void ShowTab()
        {
            if (_specimenPage != null) _specimenPage.SetActive(_tab == 0);
            if (_comparePage != null) _comparePage.SetActive(_tab == 1);
            if (_title != null) _title.text = _tab == 0 ? "FONT SPECIMEN" : "FONT CANDIDATES";
        }

        private static void RefreshSpecimen()
        {
            int totalAll = 0, okAll = 0, tofuAll = 0;
            string[] order = { "cyrillic", "latin", "marks", "lorem", "zh", "ja", "ko" };
            float[] yCursor = new float[2];
            float colW = (PageW - 72f) / 2f;

            for (int i = 0; i < order.Length; i++)
            {
                Section s = Sections[order[i]];
                int col = (i < 4) ? 0 : 1;
                float x = col == 0 ? 0f : colW + 24f;

                TMP_FontAsset face = NeonFonts.FaceForScript(s.Lang);
                s.FaceName = face != null ? face.name : "?";
                NeonFonts.EnsureChainChars(s.Lang, s.Text);

                int total = 0, ok = 0;
                var bodyText = new System.Text.StringBuilder();
                bool inRed = false;
                foreach (char c in s.Text)
                {
                    if (c == '\n')
                    {
                        if (inRed) { bodyText.Append("</color>"); inRed = false; }
                        bodyText.Append('\n');
                        continue;
                    }
                    if (c == ' ') { bodyText.Append(' '); continue; }
                    total++;
                    bool has = NeonFonts.ChainHas(s.Lang, c);
                    if (has) ok++;
                    if (!has && !inRed) { bodyText.Append("<color=#FF3B5C>"); inRed = true; }
                    if (has && inRed) { bodyText.Append("</color>"); inRed = false; }
                    bodyText.Append(c);
                }
                if (inRed) bodyText.Append("</color>");
                s.Total = total;
                s.Ok = ok;

                Block b = Blocks[i];
                b.Head.text = s.Script + "  ·  face=" + s.FaceName + "  ·  glyphs=" + ok + "/" + total
                    + "  ·  tofu=" + (total - ok) + "  ·  size=" + Mathf.RoundToInt(b.Body.fontSize);
                b.Head.color = (total - ok) > 0 ? new Color(1f, 0.35f, 0.42f) : NeonUiKit.Cyan;
                b.Body.text = bodyText.ToString();
                if (face != null)
                {
                    float lh = NeonTypography.LineHeightFor(s.Lang);
                b.Body.lineSpacing = lh > 1f ? (lh - 1f) * 100f : 0f;
                b.Body.font = face;
                    if (face.material != null) b.Body.fontSharedMaterial = face.material;
                }
                b.Body.ForceMeshUpdate();
                float bodyH = Mathf.Max(24f, b.Body.preferredHeight);
                b.Body.rectTransform.sizeDelta = new Vector2(colW, bodyH);
                b.Rt.sizeDelta = new Vector2(colW, 26f + bodyH + 10f);
                b.Rt.anchoredPosition = new Vector2(x, -yCursor[col]);
                yCursor[col] += 26f + bodyH + 14f;

                totalAll += total;
                okAll += ok;
                tofuAll += total - ok;
                var miss = new System.Text.StringBuilder();
                foreach (char c in s.Text)
                {
                    if (c == ' ' || c == (char)10) continue;
                    if (NeonFonts.ChainHas(s.Lang, c)) continue;
                    if (miss.Length > 0) miss.Append(',');
                    miss.Append("U+" + ((int)c).ToString("X4"));
                    if (miss.Length > 160) break;
                }
                TranslatorPlugin.Log("specimen: " + s.Script + " glyphs=" + ok + "/" + total
                    + " tofu=" + (total - ok) + " face=" + s.FaceName + " size=" + Mathf.RoundToInt(b.Body.fontSize)
                    + (miss.Length > 0 ? " missing=" + miss : ""));
            }

            _summary.text = "corpus glyphs " + okAll + "/" + totalAll + " · tofu " + tofuAll
                + " · active language " + TranslatorPlugin.CurrentLanguage
                + " · latin face " + (NeonFonts.FaceForScript("lat") != null ? NeonFonts.FaceForScript("lat").name : "?");
        }

        // ------------------------------------------------------------- compare

        private static void RefreshCompare()
        {
            if (Demos.Count == 0) BuildDemos();
            float y = 0f;
            foreach (Demo d in Demos)
            {
                if (d.Sample == null) BuildDemoRow(d);
                d.Sample.ForceMeshUpdate();
                y += 118f;
            }
            _summary.text = "candidates " + Demos.Count + " · samples identical · ru " + RuSample().Length
                + " chars · zh " + ZhSample().Length + " chars · applied latin face "
                + (NeonFonts.FaceForScript("lat") != null ? NeonFonts.FaceForScript("lat").name : "?");
        }

        private static string RuSample()
        {
            return "Продолжить · Новая игра · Загрузить файл сохранения · НАСТРОЙКИ";
        }

        private static string ZhSample()
        {
            return "继续 · 新游戏 · 载入存档 · 设置";
        }

        private static string DigitSample()
        {
            return "0123456789 — «ёлка» … !?";
        }

        private static void BuildDemos()
        {
            string dllDir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
            foreach (string file in CandidateFiles)
            {
                string path = Path.Combine(Path.Combine(dllDir, "fonts"), file);
                var d = new Demo { File = path, Name = Path.GetFileNameWithoutExtension(file) };
                try { d.Size = File.Exists(path) ? new FileInfo(path).Length : 0; } catch { }
                Demos.Add(d);
            }
        }

        private static void BuildDemoRow(Demo d)
        {
            var row = new GameObject("Demo " + d.Name);
            row.transform.SetParent(_comparePage.transform, false);
            var rt = row.AddComponent<RectTransform>();
            rt.anchorMin = new Vector2(0f, 1f);
            rt.anchorMax = new Vector2(0f, 1f);
            rt.pivot = new Vector2(0f, 1f);
            rt.anchoredPosition = new Vector2(0f, -(Demos.IndexOf(d) * 118f));
            rt.sizeDelta = new Vector2(PageW - 48f, 110f);

            var card = row.AddComponent<Image>();
            card.sprite = NeonUiKit.Rounded(6, 64);
            card.type = Image.Type.Sliced;
            card.color = new Color(NeonUiKit.CardBg.r, NeonUiKit.CardBg.g, NeonUiKit.CardBg.b, 0.85f);

            var meta = NeonUiKit.Label("Meta", rt, "", 15, NeonUiKit.MutedColor, TextAnchor.UpperLeft, _uiFont, false);
            NeonUiKit.Place(meta.rectTransform, 0f, 1f, 14f, -10f, 560f, 22f);

            var sample = new GameObject("Sample");
            sample.transform.SetParent(rt, false);
            var st = sample.AddComponent<TextMeshProUGUI>();
            st.fontSize = 20;
            st.color = NeonUiKit.TextColor;
            st.richText = true;
            st.enableWordWrapping = false;
            st.overflowMode = TextOverflowModes.Overflow;
            st.raycastTarget = false;
            st.alignment = TextAlignmentOptions.TopLeft;
            NeonUiKit.Place(st.rectTransform, 0f, 1f, 14f, -36f, PageW - 220f, 68f);

            var btnRt = NeonUiKit.Node("Apply", rt);
            NeonUiKit.Place(btnRt, 1f, 0.5f, -14f, 0f, 132f, 34f);
            var bg = btnRt.gameObject.AddComponent<Image>();
            bg.sprite = NeonUiKit.Rounded(6, 64);
            bg.type = Image.Type.Sliced;
            bg.color = NeonUiKit.CardBg;
            var btn = btnRt.gameObject.AddComponent<Button>();
            var cb = btn.colors;
            cb.normalColor = Color.white;
            cb.highlightedColor = new Color(1.3f, 1.4f, 1.5f, 1f);
            cb.pressedColor = new Color(0.8f, 0.85f, 0.95f, 1f);
            cb.selectedColor = Color.white;
            cb.fadeDuration = 0.08f;
            btn.colors = cb;
            btn.targetGraphic = bg;
            var label = NeonUiKit.Label("ApplyLabel", btnRt, NeonUiStrings.Apply(TranslatorPlugin.CurrentLanguage), 15, NeonUiKit.TextColor,
                TextAnchor.MiddleCenter, _uiFont, false);
            NeonUiKit.Fill(label.rectTransform);

            string file = d.File;
            string name = d.Name;
            TMP_FontAsset asset = null;
            try
            {
                if (d.Size > 0)
                {
                    asset = NeonFonts.BuildStandalone(file, "Demo-" + name, 48, 1024);
                    if (asset != null)
                    {
                        NeonFonts.EnsureChars(asset, RuSample() + ZhSample() + DigitSample());
                    }
                }
            }
            catch (Exception ex) { TranslatorPlugin.Log("FontDemo: build error " + name + " - " + ex.Message); }
            d.Asset = asset;
            d.Sample = st;
            d.Meta = meta;

            if (asset != null)
            {
                st.font = asset;
                if (asset.material != null) st.fontSharedMaterial = asset.material;
                st.text = RuSample() + "\n" + ZhSample() + "\n" + DigitSample();
                int ru = Coverage(asset, RuSample());
                int zh = Coverage(asset, ZhSample());
                meta.text = name + " · " + (d.Size / 1024) + " KB · ru " + ru + "/" + Distinct(RuSample())
                    + (ru < Distinct(RuSample()) ? " (тофу " + (Distinct(RuSample()) - ru) + ")" : " ✓")
                    + " · zh " + zh + "/" + Distinct(ZhSample())
                    + (zh < Distinct(ZhSample()) ? " (тофу " + (Distinct(ZhSample()) - zh) + ")" : " ✓")
                    + " · face=" + asset.name;
                string captured = name;
                TMP_FontAsset capturedAsset = asset;
                btn.onClick.AddListener(delegate { ApplyDemo(captured, capturedAsset); });
                TranslatorPlugin.Log("specimen: font=" + name + " size=" + d.Size + " ru=" + ru + "/"
                    + Distinct(RuSample()) + " zh=" + zh + "/" + Distinct(ZhSample()));
            }
            else
            {
                st.text = "(файл не найден: " + Path.GetFileName(file) + ")";
                meta.text = name + " · missing";
                bg.color = new Color(0.3f, 0.1f, 0.12f, 0.8f);
            }
        }

        private static void ApplyDemo(string name, TMP_FontAsset asset)
        {
            try
            {
                NeonFonts.ApplyLatinOverride(asset);
                TranslatorPlugin.SetLanguage(TranslatorPlugin.CurrentLanguage);
                TranslatorPlugin.Log("FontDemo: applied '" + name + "' (session only, not persisted)");
                Refresh();
            }
            catch (Exception ex) { TranslatorPlugin.Log("FontDemo: apply error - " + ex.Message); }
        }

        private static int Coverage(TMP_FontAsset asset, string text)
        {
            int ok = 0;
            var seen = new HashSet<char>();
            foreach (char c in text)
            {
                if (c == ' ' || c == '\n' || !seen.Add(c)) continue;
                if (asset != null && asset.HasCharacter(c)) ok++;
            }
            return ok;
        }

        private static int Distinct(string text)
        {
            var seen = new HashSet<char>();
            foreach (char c in text) if (c != ' ' && c != '\n') seen.Add(c);
            return seen.Count;
        }
    }
}
