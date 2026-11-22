//! rules.rs — 6 правил QA, перенесённые 1:1 из TS-эталона
//! (`.opencode/skills/translate-qa/scripts/qa_translate.mts`, функция `check`).
//!
//! Правила:
//!   1. покрытие (по языку, папкам, спикерам);
//!   2. copy-through в диалогах (`x === t`);
//!   3. дисбаланс rich-тегов (`r` против `rt`, имена тегов);
//!   4. латиница в RU-переводе (кириллицы < 30 %, длина > 10);
//!   5. дубли `(msgid, msgctxt)` с разным `msgstr` в `po/<lang>.po`;
//!   6. пустой `x` для диалоговой записи из POT.
//!
//! Legacy-строки (`sk`) и `#, no-translate` исключаются из 2/3/4/6.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::Path;

use crate::dat::load_dat;
use crate::po::{js_ws, parse_po, PoEntry};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Level {
    Error,
    Warning,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Error => "error",
            Level::Warning => "warning",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Finding {
    pub level: Level,
    pub rule: &'static str,
    pub rel: String,
    pub text: String,
    pub detail: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stat {
    pub filled: usize,
    pub total: usize,
}

#[derive(Debug)]
pub struct Summary {
    pub total: usize,
    pub filled: usize,
    pub coverage: f64,
    pub errors: usize,
    pub warnings: usize,
    /// Спикер → (заполнено, всего), по убыванию `total` (стабильно).
    pub by_speaker: Vec<(String, Stat)>,
    /// Папка/тип источника → (заполнено, всего), по возрастанию ключа.
    pub by_dir: Vec<(String, Stat)>,
}

#[derive(Debug)]
pub struct Report {
    pub summary: Summary,
    pub findings: Vec<Finding>,
}

/// Map с сохранением порядка вставки (JS `Map`) и сортировкой на выходе.
#[derive(Default)]
struct OrderedStats {
    keys: Vec<String>,
    index: HashMap<String, usize>,
    stats: Vec<Stat>,
}

impl OrderedStats {
    fn inc(&mut self, key: &str, filled: bool) {
        if let Some(&i) = self.index.get(key) {
            self.stats[i].total += 1;
            if filled {
                self.stats[i].filled += 1;
            }
            return;
        }
        self.index.insert(key.to_string(), self.keys.len());
        self.keys.push(key.to_string());
        self.stats.push(Stat {
            filled: usize::from(filled),
            total: 1,
        });
    }

    fn into_vec(self) -> Vec<(String, Stat)> {
        self.keys.into_iter().zip(self.stats).collect()
    }
}

/// Ссылка на источник строки: первая `translations/…` или `[kind:…]`, иначе `po`.
fn rel_of(entry: &PoEntry) -> String {
    entry
        .refs
        .iter()
        .find(|r| r.starts_with("translations/") || (r.starts_with('[') && r.ends_with(']')))
        .cloned()
        .unwrap_or_else(|| "po".to_string())
}
/// Спикер из `msgctxt speaker:X` (иначе пустая строка).
pub fn speaker_of(ctxt: &str) -> &str {
    ctxt.strip_prefix("speaker:").unwrap_or("")
}

/// Папка-источник по ссылкам `#:` (на текущем POT refs нет → всегда `ui`).
pub fn sourcedir_of(refs: &[String]) -> String {
    for r in refs {
        if r.starts_with("translations/") {
            let parts: Vec<&str> = r.split('/').collect();
            return if parts.len() > 1 {
                parts[1].to_string()
            } else {
                r.clone()
            };
        }
    }
    for r in refs {
        if r.starts_with('[') && r.ends_with(']') {
            let kind = if r.len() >= 2 {
                r[1..r.len() - 1].split(':').next().unwrap_or("")
            } else {
                ""
            };
            if ["dlg", "bundle", "set", "fsm", "spk", "raw"].contains(&kind) {
                return kind.to_string();
            }
        }
    }
    if refs.is_empty() {
        "ui".to_string()
    } else {
        "?".to_string()
    }
}

/// Доля кириллицы среди букв (1.0, если букв нет).
pub fn cyr_ratio(s: &str) -> f64 {
    let mut letters = 0usize;
    let mut cyr = 0usize;
    for c in s.chars() {
        if !is_unicode_letter(c) {
            continue;
        }
        letters += 1;
        if matches!(c, '\u{0410}'..='\u{042f}' | '\u{0430}'..='\u{044f}' | '\u{0401}' | '\u{0451}')
        {
            cyr += 1;
        }
    }
    if letters == 0 {
        1.0
    } else {
        cyr as f64 / letters as f64
    }
}

/// `\p{L}` из JS (Unicode-буква). Rust `is_alphabetic` — свойство Alphabetic:
/// оно включает комбинирующие знаки, которых в `\p{L}` нет, поэтому категория
/// M* вычитается явно (покрыто тестом `хелперы_доля_кириллицы…`).
///
/// Остаточный зазор — категория Nl (римские цифры и подобное): JS-регекс
/// `\p{L}` их не считает буквами, а `is_alphabetic` — считает. В переводах
/// проекта таких символов нет (паритет побайтовый на всём ru-корпусе), поэтому
/// отдельная таблица категорий ради этого случая не тянется.
fn is_unicode_letter(c: char) -> bool {
    c.is_alphabetic() && !is_combining_mark(c)
}

/// Приближение категорий M* (комбинирующие знаки), которых нет в `\p{L}`.
fn is_combining_mark(c: char) -> bool {
    matches!(c,
        '\u{0300}'..='\u{036f}' | '\u{0483}'..='\u{0489}' | '\u{0591}'..='\u{05bd}'
        | '\u{0610}'..='\u{061a}' | '\u{064b}'..='\u{065f}' | '\u{1ab0}'..='\u{1aff}'
        | '\u{1dc0}'..='\u{1dff}' | '\u{20d0}'..='\u{20f0}' | '\u{fe20}'..='\u{fe2f}')
}

/// Найти `<...>` (регекс `/<[^>]+>/g`): от `<` до ближайшего `>`, минимум один символ.
fn tags_of(s: &str) -> Vec<&str> {
    let bytes = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        let Some(offset) = bytes[i + 1..].iter().position(|&b| b == b'>') else {
            break;
        };
        let end = i + 1 + offset;
        if end > i + 1 {
            out.push(&s[i..=end]);
        }
        i = end + 1;
    }
    out
}

/// `<font …>` / `<material …>` — шрифт и материал выбирает рантайм, в сравнении
/// вёрстки они не участвуют (фильтр `^<\/?(?:font|material)\b/i`).
fn is_render_owned(name: &str) -> bool {
    let Some(rest) = name.strip_prefix('<') else {
        return false;
    };
    let rest = rest.strip_prefix('/').unwrap_or(rest);
    for owned in ["font", "material"] {
        if rest.len() >= owned.len()
            && rest.as_bytes()[..owned.len()].eq_ignore_ascii_case(owned.as_bytes())
        {
            let boundary = match rest.as_bytes().get(owned.len()) {
                None => true,
                Some(&b) => !(b.is_ascii_alphanumeric() || b == b'_'),
            };
            if boundary {
                return true;
            }
        }
    }
    false
}

/// Первое слово тега (`split(/\s+/)[0]`) без render-owned имён.
fn first_tag_names<'a>(tags: &'a [&'a str]) -> Vec<&'a str> {
    tags.iter()
        .map(|t| {
            let end = t
                .char_indices()
                .find(|(_, c)| js_ws(*c))
                .map(|(i, _)| i)
                .unwrap_or(t.len());
            &t[..end]
        })
        .filter(|name| !is_render_owned(name))
        .collect()
}

/// `String.prototype.slice(0, n)` в UTF-16 code units.
///
/// Суррогатная пара на границе в TS разрезалась бы (в JSON это `\udXXX`).
/// Astral-символов в корпусе нет; здесь пара остаётся целой — единственное
/// документированное отличие, покрыто тестом.
fn js_prefix(s: &str, n: usize) -> &str {
    let mut units = 0usize;
    let mut end = 0usize;
    for (i, c) in s.char_indices() {
        let w = c.len_utf16();
        if units + w > n {
            return &s[..i];
        }
        units += w;
        end = i + c.len_utf8();
    }
    &s[..end]
}

/// Сравнение строк как `Array.prototype.sort()` по умолчанию (UTF-16 code units).
fn utf16_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `String.prototype.localeCompare` для наших ключей папок: латиница в нижнем
/// регистре, поэтому совпадает с кодовым порядком (проверено на реальных данных:
/// единственный ключ — `ui`). Для смешанного регистра — регистронезависимо.
fn dir_cmp(a: &str, b: &str) -> Ordering {
    a.to_lowercase()
        .cmp(&b.to_lowercase())
        .then_with(|| a.cmp(b))
}

/// Прогнать QA для языка `lang` относительно `root` (папка с `po/` и `runtime/`).
pub fn check(lang: &str, root: &Path) -> std::io::Result<Report> {
    let pot_text = std::fs::read_to_string(root.join("po").join("template.pot"))?;
    let pot: Vec<PoEntry> = parse_po(&pot_text)
        .into_iter()
        .filter(|e| !e.msgid.is_empty())
        .collect();
    let dat = load_dat(&root.join("runtime").join(format!("patch_{lang}.dat")));

    let mut findings: Vec<Finding> = Vec::new();
    let total = pot.len();
    let mut filled = 0usize;
    let mut by_speaker = OrderedStats::default();
    let mut by_dir = OrderedStats::default();

    for e in &pot {
        let text = &e.msgid;
        let ctxt = &e.msgctxt;
        let rel = rel_of(e);
        let row = dat.get(text.as_str());
        let tr = row.map(|r| r.x.as_str()).unwrap_or("");
        let sk = row.is_some_and(|r| r.sk);
        if !tr.is_empty() {
            filled += 1;
        }
        let d = sourcedir_of(&e.refs);
        by_dir.inc(&d, !tr.is_empty());
        let sp = speaker_of(ctxt);
        if !sp.is_empty() {
            by_speaker.inc(sp, !tr.is_empty());
        }

        let dlg = !sp.is_empty() || d == "dialogues";
        if sk || e.flags.iter().any(|f| f == "no-translate") {
            continue;
        }

        if dlg && tr.is_empty() {
            findings.push(Finding {
                level: Level::Error,
                rule: "empty-dialogue",
                rel: rel.clone(),
                text: text.clone(),
                detail: "пустой перевод в диалоге".to_string(),
            });
        }
        if dlg && !tr.is_empty() && tr == text {
            findings.push(Finding {
                level: Level::Error,
                rule: "copy-through",
                rel: rel.clone(),
                text: text.clone(),
                detail: "перевод совпадает с оригиналом".to_string(),
            });
        }
        let r = row.map(|row| row.r.as_str()).unwrap_or("");
        let rt = row.map(|row| row.rt.as_str()).unwrap_or("");
        if !r.is_empty() && !rt.is_empty() {
            let tags = tags_of(r);
            let ttags = tags_of(rt);
            if first_tag_names(&tags) != first_tag_names(&ttags) {
                findings.push(Finding {
                    level: Level::Error,
                    rule: "tag-imbalance",
                    rel: rel.clone(),
                    text: text.clone(),
                    detail: format!("{} vs {}", tags.join(","), ttags.join(",")),
                });
            }
        }
        // Латиница-остаток — проверка конкретной письменности (ru).
        if lang == "ru"
            && !tr.is_empty()
            && tr.chars().count() > 10
            && cyr_ratio(tr) < 0.3
            && tr.chars().any(|c| c.is_ascii_alphabetic())
        {
            findings.push(Finding {
                level: Level::Warning,
                rule: "latin-leftover",
                rel: rel.clone(),
                text: text.clone(),
                detail: js_prefix(tr, 80).to_string(),
            });
        }
    }

    // Дубли в самом po: один (msgid, msgctxt) с РАЗНЫМИ переводами — ошибка.
    let po_path = root.join("po").join(format!("{lang}.po"));
    if let Ok(po_text) = std::fs::read_to_string(&po_path) {
        let mut keys: Vec<String> = Vec::new();
        let mut index: HashMap<String, usize> = HashMap::new();
        let mut variants: Vec<Vec<String>> = Vec::new();
        for e in parse_po(&po_text) {
            if e.msgid.is_empty() {
                continue;
            }
            let key = format!("{}\u{0}{}", e.msgctxt, e.msgid);
            let slot = match index.get(&key) {
                Some(&i) => i,
                None => {
                    index.insert(key.clone(), keys.len());
                    keys.push(key);
                    variants.push(Vec::new());
                    keys.len() - 1
                }
            };
            if !variants[slot].contains(&e.msgstr) {
                variants[slot].push(e.msgstr.clone());
            }
        }
        for (key, set) in keys.iter().zip(variants.iter()) {
            if set.len() <= 1 {
                continue;
            }
            let mut sorted = set.clone();
            sorted.sort_by(|a, b| utf16_cmp(a, b));
            let (ctxt, text) = key.split_once('\u{0}').unwrap_or((key.as_str(), ""));
            findings.push(Finding {
                level: Level::Error,
                rule: "duplicate-po",
                rel: format!("po/{lang}.po"),
                text: text.to_string(),
                detail: format!("{ctxt}: {}", crate::json::quoted_array(&sorted)),
            });
        }
    }

    let errors = findings.iter().filter(|f| f.level == Level::Error).count();
    let warnings = findings
        .iter()
        .filter(|f| f.level == Level::Warning)
        .count();

    let mut by_speaker = by_speaker.into_vec();
    by_speaker.sort_by_key(|(_, stat)| std::cmp::Reverse(stat.total));
    let mut by_dir = by_dir.into_vec();
    by_dir.sort_by(|a, b| dir_cmp(&a.0, &b.0));

    let summary = Summary {
        total,
        filled,
        coverage: (100.0 * filled as f64) / (total.max(1) as f64),
        errors,
        warnings,
        by_speaker,
        by_dir,
    };
    Ok(Report { summary, findings })
}
