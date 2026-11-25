namespace NeonTranslatorDX
{
    // Dependency-free core of the runtime font logic: pure functions only, so
    // `tests/neoncore.test.mts` can compile this single file with csc.exe and
    // exercise it without Unity, without the game, and without mocks.
    internal static class NeonFontCore
    {
        /// Never shrink a label below 60% of its authored size (legibility),
        /// and keep 3% of the box as breathing room.
        internal const float MinRatio = 0.6f;
        internal const float SafeWidth = 0.95f;

        /// Pick a point size that fits `preferredWidth` into `availableWidth`.
        /// Never grows, never goes below `minSize`, never returns < 1.
        internal static int FitSize(float preferredWidth, float availableWidth, int currentSize, int minSize)
        {
            if (currentSize <= 0) return 1;
            if (availableWidth <= 0f || preferredWidth <= 0f) return currentSize;

            float room = availableWidth * SafeWidth;
            if (preferredWidth <= room) return currentSize;

            int floor = minSize > 0 ? minSize : 1;
            int fit = (int)System.Math.Floor(currentSize * (room / preferredWidth));
            if (fit > currentSize) fit = currentSize;
            if (fit < floor) fit = floor;
            return fit;
        }

        /// Fit a translated label to the GAME's own (English) label width, the
        /// true rhythm reference: never grow, never below `minSize`.
        internal static int FitToReference(float translatedWidth, float referenceWidth, int currentSize, int minSize)
        {
            if (currentSize <= 0) return 1;
            if (translatedWidth <= 0f || referenceWidth <= 0f) return currentSize;
            if (translatedWidth <= referenceWidth) return currentSize;
            int floor = minSize > 0 ? minSize : 1;
            int fit = (int)System.Math.Floor(currentSize * (referenceWidth / translatedWidth));
            if (fit > currentSize) fit = currentSize;
            if (fit < floor) fit = floor;
            return fit;
        }

        /// Smallest allowed size for a label authored at `originalSize`.
        internal static int MinSize(int originalSize)
        {
            if (originalSize <= 0) return 1;
            int min = (int)System.Math.Floor(originalSize * MinRatio);
            return min < 1 ? 1 : min;
        }

        /// Which bundled face serves a UI language.
        internal static string FaceKeyForLang(string lang)
        {
            if (lang == "marks") return "marks";
            if (lang == "zh") return "zh";
            if (lang == "ja") return "ja";
            if (lang == "ko") return "ko";
            return "lat";
        }

        /// Fallback search order: the language's own face first, then the rest
        /// of the chain. SC sits in every chain (fullwidth brackets and stray
        /// ideographs show up in European translations too), `marks` always last
        /// (combining glitch strokes, U+0334..U+0338).
        internal static string[] FallbackOrder(string lang)
        {
            string first = FaceKeyForLang(lang);
            var rest = new string[] { "lat", "zh", "ja", "ko", "marks" };
            var order = new string[rest.Length];
            int n = 0;
            order[n++] = first;
            foreach (string key in rest)
                if (key != first) order[n++] = key;
            var trimmed = new string[n];
            System.Array.Copy(order, trimmed, n);
            return trimmed;
        }

        /// CJK typography: ideographs are denser than Latin glyphs at the same
        /// point size, so the UI raises the size a little and opens the line
        /// spacing. Same numbers as the TSSR site; see docs/fonts.md and
        /// fonts/typography.json (the runtime reads the JSON, these are the
        /// fallback if the file is missing).
        internal static float ScaleFor(string lang)
        {
            if (lang == "zh") return 1.08f;
            if (lang == "ja") return 1.07f;
            if (lang == "ko") return 1.04f;
            return 1f;
        }

        internal static float LineHeightFor(string lang)
        {
            if (lang == "zh") return 1.6f;
            if (lang == "ja") return 1.5f;
            if (lang == "ko") return 1.5f;
            return 1f;
        }

        /// Main-menu plates: the game draws its 36 px labels in Orbitron, whose
        /// cap height is 46.35 px at 36 px size; our Cyrillic face gives 43.39.
        /// 46.35 / 43.39 = 1.068 — the global factor that restores the height
        /// rhythm (docs/ui-kit.md). Applied ONLY to the main menu.
        internal const float MenuSizeScale = 1.068f;

        /// TMP character spacing (1 unit = 0.324 px per char at 36 px, measured
        /// in game). -8 pulls the 7% taller label back to the English width:
        /// "Продолжить" 204 -> ~177 px vs the game's "Continue" 180 px.
        internal const float MenuCharacterSpacing = -8f;

        /// Size for a label: authored size × language scale (rounded, ≥ 1).
        internal static int ScaledSize(int originalSize, float scale)
        {
            if (originalSize <= 0) return 1;
            if (scale <= 0f) return originalSize;
            int size = (int)System.Math.Round(originalSize * (double)scale);
            return size < 1 ? 1 : size;
        }
    }
}
