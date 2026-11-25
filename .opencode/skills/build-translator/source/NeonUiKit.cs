using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UI;

namespace NeonTranslatorDX
{
    // Small procedural UI kit for the mod panel (no shipped textures, no
    // "web-flat" look): rounded cards with a soft shadow and the neon palette
    // taken from the game's art (pink / cyan / yellow on deep blue-black).
    internal static class NeonUiKit
    {
        // Palette sampled from the game's key art and menu accents.
        internal static readonly Color InkBg = Hex("#0B0E16", 0.94f);
        internal static readonly Color PanelBg = Hex("#10141F", 0.93f);
        internal static readonly Color CardBg = Hex("#161C28", 0.92f);
        internal static readonly Color CardHoverBg = Hex("#1D2635", 0.95f);
        internal static readonly Color TextColor = Hex("#EAF2FF");
        internal static readonly Color MutedColor = Hex("#8A97AD");
        internal static readonly Color Pink = Hex("#FF2E88");
        internal static readonly Color Cyan = Hex("#22E1FF");
        internal static readonly Color Yellow = Hex("#FFD23F");

        private static readonly Dictionary<string, Sprite> Cache = new Dictionary<string, Sprite>();

        internal static Color Hex(string hex, float alpha = 1f)
        {
            if (string.IsNullOrEmpty(hex)) return Color.white;
            string s = hex[0] == '#' ? hex.Substring(1) : hex;
            int r = Convert.ToInt32(s.Substring(0, 2), 16);
            int g = Convert.ToInt32(s.Substring(2, 2), 16);
            int b = Convert.ToInt32(s.Substring(4, 2), 16);
            return new Color(r / 255f, g / 255f, b / 255f, alpha);
        }

        /// White rounded rectangle as a 9-sliced sprite: tint it per element.
        internal static Sprite Rounded(int radius = 12, int size = 64)
        {
            string key = "round:" + radius + ":" + size;
            Sprite cached;
            if (Cache.TryGetValue(key, out cached) && cached != null) return cached;

            var tex = new Texture2D(size, size, TextureFormat.RGBA32, false);
            tex.name = key;
            tex.wrapMode = TextureWrapMode.Clamp;
            tex.filterMode = FilterMode.Bilinear;
            var px = new Color32[size * size];
            float rr = radius;
            for (int y = 0; y < size; y++)
            {
                for (int x = 0; x < size; x++)
                {
                    float a = RoundedCoverage(x + 0.5f, y + 0.5f, size, size, rr);
                    px[y * size + x] = new Color32(255, 255, 255, (byte)Mathf.RoundToInt(a * 255f));
                }
            }
            tex.SetPixels32(px);
            tex.Apply(false, false);
            int border = radius + 1;
            var sprite = Sprite.Create(tex, new Rect(0, 0, size, size), new Vector2(0.5f, 0.5f),
                100f, 0, SpriteMeshType.FullRect, new Vector4(border, border, border, border));
            sprite.name = key;
            Cache[key] = sprite;
            return sprite;
        }

        /// Soft drop shadow: a rounded rect blurred by repeated box passes.
        internal static Sprite Shadow(int radius = 14, int size = 96, int blur = 9)
        {
            string key = "shadow:" + radius + ":" + size + ":" + blur;
            Sprite cached;
            if (Cache.TryGetValue(key, out cached) && cached != null) return cached;

            var tex = new Texture2D(size, size, TextureFormat.RGBA32, false);
            tex.name = key;
            tex.wrapMode = TextureWrapMode.Clamp;
            tex.filterMode = FilterMode.Bilinear;
            int pad = blur + 2;
            var mask = new float[size * size];
            for (int y = 0; y < size; y++)
            {
                for (int x = 0; x < size; x++)
                {
                    float a = RoundedCoverage(x + 0.5f - pad, y + 0.5f - pad,
                        size - 2 * pad, size - 2 * pad, radius);
                    mask[y * size + x] = a;
                }
            }
            for (int pass = 0; pass < 3; pass++) mask = Blur(mask, size, Math.Max(1, blur / 2));
            var px = new Color32[size * size];
            for (int i = 0; i < px.Length; i++)
                px[i] = new Color32(255, 255, 255, (byte)Mathf.RoundToInt(Mathf.Clamp01(mask[i]) * 255f));
            tex.SetPixels32(px);
            tex.Apply(false, false);
            int border = pad + radius;
            var sprite = Sprite.Create(tex, new Rect(0, 0, size, size), new Vector2(0.5f, 0.5f),
                100f, 0, SpriteMeshType.FullRect, new Vector4(border, border, border, border));
            sprite.name = key;
            Cache[key] = sprite;
            return sprite;
        }

        private static float RoundedCoverage(float x, float y, float w, float h, float r)
        {
            float cx = Mathf.Clamp(x, r, w - r);
            float cy = Mathf.Clamp(y, r, h - r);
            float dx = x - cx;
            float dy = y - cy;
            float dist = Mathf.Sqrt(dx * dx + dy * dy);
            return Mathf.Clamp01(r - dist + 0.5f);
        }

        private static float[] Blur(float[] src, int size, int radius)
        {
            var tmp = new float[src.Length];
            var dst = new float[src.Length];
            for (int y = 0; y < size; y++)
            {
                for (int x = 0; x < size; x++)
                {
                    float sum = 0f;
                    int n = 0;
                    for (int k = -radius; k <= radius; k++)
                    {
                        int xx = Mathf.Clamp(x + k, 0, size - 1);
                        sum += src[y * size + xx];
                        n++;
                    }
                    tmp[y * size + x] = sum / n;
                }
            }
            for (int y = 0; y < size; y++)
            {
                for (int x = 0; x < size; x++)
                {
                    float sum = 0f;
                    int n = 0;
                    for (int k = -radius; k <= radius; k++)
                    {
                        int yy = Mathf.Clamp(y + k, 0, size - 1);
                        sum += tmp[yy * size + x];
                        n++;
                    }
                    dst[y * size + x] = sum / n;
                }
            }
            return dst;
        }

        // ------------------------------------------------------------- widgets

        internal static RectTransform Node(string name, Transform parent)
        {
            var go = new GameObject(name, typeof(RectTransform));
            go.transform.SetParent(parent, false);
            return go.GetComponent<RectTransform>();
        }

        internal static RectTransform Place(RectTransform rt, float ax, float ay, float x, float y, float w, float h)
        {
            rt.anchorMin = new Vector2(ax, ay);
            rt.anchorMax = new Vector2(ax, ay);
            rt.pivot = new Vector2(ax, ay);
            rt.anchoredPosition = new Vector2(x, y);
            rt.sizeDelta = new Vector2(w, h);
            return rt;
        }

        internal static RectTransform Fill(RectTransform rt)
        {
            rt.anchorMin = Vector2.zero;
            rt.anchorMax = Vector2.one;
            rt.offsetMin = Vector2.zero;
            rt.offsetMax = Vector2.zero;
            return rt;
        }

        internal static Image MakeCard(string name, Transform parent, Color color,
            int radius = 12, bool shadow = false)
        {
            RectTransform rt = Node(name, parent);
            if (shadow)
            {
                RectTransform sh = Node(name + " Shadow", parent);
                var shImg = sh.gameObject.AddComponent<Image>();
                shImg.sprite = Shadow(radius + 2, 96, 10);
                shImg.type = Image.Type.Sliced;
                shImg.color = new Color(0f, 0f, 0f, 0.55f);
                shImg.raycastTarget = false;
                Place(sh, 0f, 0f, 0f, 0f, 0f, 0f);
                sh.SetSiblingIndex(rt.GetSiblingIndex());
            }
            var img = rt.gameObject.AddComponent<Image>();
            img.sprite = Rounded(radius, 64);
            img.type = Image.Type.Sliced;
            img.color = color;
            return img;
        }

        /// Thin neon border: same rounded sprite, 1px larger, drawn behind.
        internal static Image Border(RectTransform card, Color color, float thickness = 1.5f)
        {
            RectTransform rt = Node(card.name + " Border", card.parent);
            var img = rt.gameObject.AddComponent<Image>();
            img.sprite = Rounded(13, 64);
            img.type = Image.Type.Sliced;
            img.color = color;
            rt.anchorMin = card.anchorMin;
            rt.anchorMax = card.anchorMax;
            rt.pivot = card.pivot;
            rt.anchoredPosition = card.anchoredPosition;
            rt.sizeDelta = card.sizeDelta + new Vector2(thickness * 2f, thickness * 2f);
            rt.SetSiblingIndex(card.GetSiblingIndex());
            return img;
        }

        internal static Text Label(string name, Transform parent, string value, int size,
            Color color, TextAnchor anchor, Font font, bool bold = false)
        {
            RectTransform rt = Node(name, parent);
            var t = rt.gameObject.AddComponent<Text>();
            t.font = font;
            t.fontSize = size;
            t.color = color;
            t.alignment = anchor;
            t.text = value;
            t.raycastTarget = false;
            t.horizontalOverflow = HorizontalWrapMode.Overflow;
            t.verticalOverflow = VerticalWrapMode.Overflow;
            if (bold) t.fontStyle = FontStyle.Bold;
            t.supportRichText = false;
            return t;
        }
    }
}
