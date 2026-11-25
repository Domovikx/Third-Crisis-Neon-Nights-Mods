using System;
using System.Collections.Generic;

namespace NeonTranslatorDX
{
    // Strings of the MOD's own UI (language panel, font page). The game's
    // strings come from po/<lang>.po; these do not exist there, so they live
    // here. The panel title reuses the game's own translation of "Language"
    // (available in all 10 po files) via TranslatorPlugin.Translate.
    internal static class NeonUiStrings
    {
        // lang -> { hint (F9 ...), apply, close }
        private static readonly Dictionary<string, string[]> Table =
            new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase)
        {
            { "en", new[] { "F9 — close  ·  click to switch", "Apply", "Close" } },
            { "ru", new[] { "F9 — закрыть  ·  нажмите, чтобы переключить", "Применить", "Закрыть" } },
            { "zh", new[] { "F9 — 关闭  ·  点击切换", "应用", "关闭" } },
            { "ja", new[] { "F9 — 閉じる  ·  クリックで切替", "適用", "閉じる" } },
            { "ko", new[] { "F9 — 닫기  ·  클릭하여 전환", "적용", "닫기" } },
            { "de", new[] { "F9 — schließen  ·  klicken zum Wechseln", "Anwenden", "Schließen" } },
            { "es", new[] { "F9 — cerrar  ·  clic para cambiar", "Aplicar", "Cerrar" } },
            { "fr", new[] { "F9 — fermer  ·  cliquer pour changer", "Appliquer", "Fermer" } },
            { "it", new[] { "F9 — chiudi  ·  clic per cambiare", "Applica", "Chiudi" } },
            { "pl", new[] { "F9 — zamknij  ·  kliknij, aby zmienić", "Zastosuj", "Zamknij" } },
            { "pt", new[] { "F9 — fechar  ·  clique para trocar", "Aplicar", "Fechar" } },
        };

        private static string[] Row(string lang)
        {
            string[] row;
            if (lang != null && Table.TryGetValue(lang, out row)) return row;
            return Table["en"];
        }

        internal static string Hint(string lang) { return Row(lang)[0]; }
        internal static string Apply(string lang) { return Row(lang)[1]; }
        internal static string Close(string lang) { return Row(lang)[2]; }

        /// Panel title: the game's own word for "Language" (all po files have
        /// it), upper-cased for the neon header; falls back to "LANGUAGE".
        internal static string Title(string lang)
        {
            string s = TranslatorPlugin.Translate("Language");
            if (string.IsNullOrEmpty(s)) s = "LANGUAGE";
            return s.ToUpperInvariant();
        }
    }
}
