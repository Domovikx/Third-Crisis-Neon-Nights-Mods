//! po2dat.rs — компиляция `po/<lang>.po` в `runtime/patch_<lang>.dat`
//! (1:1 с `.opencode/skills/extract-text/scripts/po2dat.mts`).
//!
//! Строка `.dat` — один JSON-объект (JSONL):
//! `{"t": text, "x": translation, "r": rich_text?, "rt": rich_translation?, "sk": true?}`
//!
//! rich_text берётся из `#. rich_text:` комментариев `po/template.pot`,
//! явный rich_translation — из `# rich_translation: ...` (алиас `# rich: ...`) в PO. Дубликаты текста решаются
//! «earliest-ref-file-wins» (повторяет first-wins загрузчика C#).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use rust_l10n_core::json::quoted;
use rust_l10n_core::po::{js_trim, parse_po, PoEntry};

use crate::refs::ref_sort_key;

/// Строка словаря. Поля опциональны: пустые в JSON не пишутся.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DatRow {
    pub t: String,
    pub x: String,
    pub r: Option<String>,
    pub rt: Option<String>,
    pub sk: bool,
}

#[derive(Debug, Default)]
pub struct DatReport {
    pub po_entries: usize,
    pub filled: usize,
    /// (текст, варианты `[(msgstr[0..60], msgctxt), …]`)
    pub dupes: Vec<(String, Vec<(String, String)>)>,
    pub no_rich: usize,
    pub rich_only: usize,
    pub gated_auto_normalized: usize,
}

/// `msgid -> rich_text` из `#. rich_text:` комментариев template.pot
/// (первый для текста побеждает).
pub fn load_pot_rich(root: &Path) -> HashMap<String, String> {
    let mut rich_map: HashMap<String, String> = HashMap::new();
    let Ok(text) = std::fs::read_to_string(root.join("po").join("template.pot")) else {
        return rich_map;
    };
    for e in parse_po(&text) {
        if e.msgid.is_empty() || rich_map.contains_key(&e.msgid) {
            continue;
        }
        for c in &e.comments {
            if let Some(rest) = c.strip_prefix("rich_text:") {
                rich_map.insert(e.msgid.clone(), js_trim(rest).to_string());
                break;
            }
        }
    }
    rich_map
}

/// Явный `rich_translation` из комментариев переводчика.
///
/// Основное имя — `# rich_translation: …` (совпадает с полем `rt`, которое
/// читает рантайм). `# rich: …` остаётся алиасом: старые PO писались так.
/// Если есть оба, побеждает `rich_translation:`.
pub fn rt_override(entry: Option<&PoEntry>) -> String {
    let Some(entry) = entry else {
        return String::new();
    };
    let mut legacy = "";
    for c in &entry.translator {
        if let Some(rest) = c.strip_prefix("rich_translation:") {
            let value = js_trim(rest);
            if !value.is_empty() {
                return value.to_string();
            }
        }
        if legacy.is_empty() {
            if let Some(rest) = c.strip_prefix("rich:") {
                legacy = rest;
            }
        }
    }
    js_trim(legacy).to_string()
}

/// `String.prototype.slice(0, n)` в UTF-16 code units (для отчёта о дублях).
fn js_slice_utf16(s: &str, n: usize) -> String {
    let mut units = 0usize;
    for (i, c) in s.char_indices() {
        if units + c.len_utf16() > n {
            return s[..i].to_string();
        }
        units += c.len_utf16();
    }
    s.to_string()
}

/// Скомпилировать `po/<lang>.po` (+ rich из template.pot) в строки `.dat`.
pub fn build_dat(lang: &str, root: &Path) -> Result<(Vec<DatRow>, DatReport), String> {
    let po_path = root.join("po").join(format!("{lang}.po"));
    let raw =
        std::fs::read_to_string(&po_path).map_err(|_| format!("missing {}", po_path.display()))?;

    let entries: Vec<PoEntry> = parse_po(&raw)
        .into_iter()
        .filter(|e| !e.msgid.is_empty())
        .collect();
    let rich_map = load_pot_rich(root);

    let mut report = DatReport {
        po_entries: entries.len(),
        ..DatReport::default()
    };
    let mut rows: Vec<DatRow> = Vec::new();

    // Группы по тексту в порядке первого появления (JS `Map`).
    let mut order: Vec<String> = Vec::new();
    let mut by_text: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, e) in entries.iter().enumerate() {
        match by_text.get_mut(&e.msgid) {
            Some(group) => group.push(i),
            None => {
                order.push(e.msgid.clone());
                by_text.insert(e.msgid.clone(), vec![i]);
            }
        }
    }

    let mut seen_texts: HashSet<&str> = HashSet::new();
    for text in &order {
        let group: Vec<&PoEntry> = by_text[text].iter().map(|&i| &entries[i]).collect();
        let mut filled: Vec<&PoEntry> = group
            .iter()
            .copied()
            .filter(|e| !e.msgstr.is_empty())
            .collect();
        let mut msgstr = String::new();

        if !filled.is_empty() {
            // Earliest-ref-file-wins: повторяет first-wins загрузчика C# по
            // отсортированным файлам. Сортировка стабильная (как в JS).
            filled.sort_by_key(|a| ref_sort_key(a));
            let variants: HashSet<&str> = filled.iter().map(|e| e.msgstr.as_str()).collect();
            if variants.len() > 1 {
                report.dupes.push((
                    text.clone(),
                    filled
                        .iter()
                        .map(|e| (js_slice_utf16(&e.msgstr, 60), e.msgctxt.clone()))
                        .collect(),
                ));
            }
            msgstr = filled[0].msgstr.clone();
            // Гейт ревью: авто-нормализованное едет только после снятия флага.
            // Гейт смотрит ТОЛЬКО на победителя сортировки (поведение Python).
            if filled[0].flags.iter().any(|f| f == "auto-normalized") {
                report.gated_auto_normalized += 1;
                continue;
            }
        }

        if seen_texts.contains(text.as_str()) {
            continue;
        }

        let rich = rich_map.get(text).cloned().unwrap_or_default();
        let rich_tr = if filled.is_empty() {
            String::new()
        } else {
            rt_override(filled.first().copied())
        };
        if rich.is_empty() && msgstr.is_empty() {
            continue;
        }

        seen_texts.insert(text.as_str());
        if rich.is_empty() {
            report.no_rich += 1;
        }

        let mut row = DatRow {
            t: text.clone(),
            x: msgstr,
            ..DatRow::default()
        };
        if !rich.is_empty() {
            row.r = Some(rich);
        }
        if !rich_tr.is_empty() {
            row.rt = Some(rich_tr);
        }
        if !filled.is_empty() && filled[0].flags.iter().any(|f| f == "legacy") {
            row.sk = true;
        }
        if row.x.is_empty() {
            report.rich_only += 1;
        } else {
            report.filled += 1;
        }
        rows.push(row);
    }

    Ok((rows, report))
}

/// Одна JSON-строка в формате старого Python-пайплайна: `{"t": "...", "x": "..."}`
/// — с `": "` и `", "`, чтобы `.dat` совпадал байт-в-байт.
pub fn to_json_line(row: &DatRow) -> String {
    let mut out = String::with_capacity(row.t.len() + row.x.len() + 32);
    out.push_str("{\"t\": ");
    out.push_str(&quoted(&row.t));
    out.push_str(", \"x\": ");
    out.push_str(&quoted(&row.x));
    if let Some(r) = &row.r {
        out.push_str(", \"r\": ");
        out.push_str(&quoted(r));
    }
    if let Some(rt) = &row.rt {
        out.push_str(", \"rt\": ");
        out.push_str(&quoted(rt));
    }
    if row.sk {
        out.push_str(", \"sk\": true");
    }
    out.push('}');
    out
}

/// Записать строки в `.dat` (один JSON-объект на строку, UTF-8).
///
/// Запись атомарная (`.part` → rename): обрыв не оставит половину словаря.
pub fn write_dat(rows: &[DatRow], out_path: &Path) -> Result<(), String> {
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let mut body = String::new();
    for row in rows {
        body.push_str(&to_json_line(row));
        body.push('\n');
    }
    let part = PathBuf::from(format!("{}.part", out_path.display()));
    let write = std::fs::write(&part, body).map_err(|e| format!("{}: {e}", part.display()));
    if let Err(err) = write {
        let _ = std::fs::remove_file(&part);
        return Err(err);
    }
    std::fs::rename(&part, out_path).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        format!("{}: {e}", out_path.display())
    })
}
