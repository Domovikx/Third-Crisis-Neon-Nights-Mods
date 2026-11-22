//! noise.rs — порт фильтров `isAssetName` / `isGarbageFragment`
//! (`.opencode/skills/pipeline-common/scripts/text_filters.mts`).
//!
//! Порт нужен для калибровки: аудит обязан independently пересчитать известные
//! ~4 297 шумовых записей POT теми же правилами, что пайплайн. Любое отличие
//! от оригинала — либо другая версия данных, либо расхождение порта; оба
//! случая должны быть видны, а не спрятаны.

use rust_l10n_core::po::js_ws;

const ASSET_SUFFIXES: &[&str] = &[
    "Renderer",
    "System",
    "Manager",
    "Controller",
    "Handler",
    "Receiver",
    "Target",
    "Pickup",
    "Link",
    "Mask",
    "Interact",
    "Effect",
    "UI",
];

const ASSET_PREFIXES: &[&str] = &["NN", "AMS"];

/// Unity-компонент/скрипт? Точный порт TS: строка без пробелов длиной ≥4,
/// префикс NN/AMS, суффикс компонента или любая ASCII-цифра.
pub fn is_asset_name(s: &str) -> bool {
    if s.is_empty() || s.contains(' ') || s.chars().count() < 4 {
        return false;
    }
    if ASSET_PREFIXES.iter().any(|p| s.starts_with(p)) {
        return true;
    }
    if ASSET_SUFFIXES.iter().any(|p| s.ends_with(p)) {
        return true;
    }
    s.chars().any(|c| c.is_ascii_digit())
}

/// Легитимный процент: цифры + необязательный пробел + `%` в конце.
///
/// TS-регекс `[0-9]+\s?%$` не требует, чтобы цифры были в начале строки:
/// «Accessories - 10%» — легитимный процент, а не бинарный `%IR`.
fn has_legit_percent(s: &str) -> bool {
    let Some(rest) = s.strip_suffix('%') else {
        return false;
    };
    // `\s?` из TS: ровно один пробельный символ JS-набора.
    let rest = match rest.chars().last() {
        Some(c) if js_ws(c) => &rest[..rest.len() - c.len_utf8()],
        _ => rest,
    };
    rest.chars().last().is_some_and(|c| c.is_ascii_digit())
}

/// Бинарный мусор? Точный порт TS (обратный слэш, «дикий» процент,
/// `?` внутри слова до 12 символов).
pub fn is_garbage_fragment(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    if s.contains('\\') {
        return true;
    }
    if s.contains('%') && !has_legit_percent(s) {
        return true;
    }
    if s.contains('?') && !s.contains(' ') && !s.ends_with('?') && s.chars().count() <= 12 {
        let chars: Vec<char> = s.chars().collect();
        for (i, c) in chars.iter().enumerate() {
            if *c != '?' {
                continue;
            }
            if let Some(next) = chars.get(i + 1) {
                if !matches!(next, '!' | '?' | '.') {
                    return true;
                }
            }
        }
    }
    false
}

/// Строка — шум по любому из фильтров.
pub fn is_noise(s: &str) -> bool {
    is_asset_name(s) || is_garbage_fragment(s)
}

/// Разбивка шума для калибровочного отчёта.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NoiseCount {
    pub asset: usize,
    pub garbage: usize,
    pub both: usize,
}

impl NoiseCount {
    pub fn union(&self) -> usize {
        self.asset + self.garbage - self.both
    }

    pub fn add(&mut self, text: &str) {
        let asset = is_asset_name(text);
        let garbage = is_garbage_fragment(text);
        if asset {
            self.asset += 1;
        }
        if garbage {
            self.garbage += 1;
        }
        if asset && garbage {
            self.both += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ожидания перенесены 1:1 из `text_filters.test.mts` (оракул).
    #[test]
    fn asset_names() {
        for s in [
            "NNHsvRenderer",
            "EventSystem",
            "NodeLink2",
            "AMSController",
            "OptionsUI",
            "Zone2",
        ] {
            assert!(is_asset_name(s), "{s} должен быть ассетом");
        }
        for s in ["Back", "New Game", "Continue", "UI", "", "  ", "Zone 2"] {
            assert!(!is_asset_name(s), "{s} не должен быть ассетом");
        }
    }

    #[test]
    fn garbage_fragments() {
        for s in ["Bff?D", "S5?d", "%IR", "H\\?d", "C:\\Games", "not\\a\\word"] {
            assert!(is_garbage_fragment(s), "{s} должен быть мусором");
        }
        for s in [
            "Really?",
            "50%",
            "100 %",
            "Accessories - 10%",
            "?!",
            "?!?",
            "",
        ] {
            assert!(!is_garbage_fragment(s), "{s} не должен быть мусором");
        }
    }

    #[test]
    fn noise_breakdown_dedups_intersection() {
        let mut n = NoiseCount::default();
        for s in ["NNHsvRenderer", "Bff?D", "%IR", "Hello"] {
            n.add(s);
        }
        assert_eq!(n.asset, 1);
        assert_eq!(n.garbage, 2);
        assert_eq!(n.both, 0);
        assert_eq!(n.union(), 3);
    }
}
