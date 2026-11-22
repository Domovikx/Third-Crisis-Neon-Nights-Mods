//! report.rs — два выхода: машинный JSON и markdown-сводка человеку.
//!
//! POT проверяется один раз (`PotAudit`), языки — по одному отчёту. JSON
//! содержит ВСЕ зарегистрированные классы (включая нули) — отсутствие ключа
//! не должно быть неотличимо от «проверено, чисто». Markdown повторяет те же
//! числа, но с примерами и вердиктом по каждому классу.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use serde_json::{json, Map, Value};

use crate::audit::{ClassResult, LangAudit, PotAudit};
use crate::classes::{Level, CLASSES};

fn classes_json(classes: &BTreeMap<&'static str, ClassResult>) -> Map<String, Value> {
    let mut out = Map::new();
    for (id, result) in classes {
        let samples: Vec<Value> = result
            .samples
            .iter()
            .map(|f| {
                json!({
                    "loc": f.loc,
                    "text": f.text,
                    "detail": f.detail,
                })
            })
            .collect();
        out.insert(
            (*id).to_string(),
            json!({
                "level": result.def.level.as_str(),
                "verdict": result.def.verdict.as_str(),
                "title": result.def.title,
                "count": result.count,
                "samples": samples,
            }),
        );
    }
    out
}

fn calibration_json(cal: &crate::audit::Calibration) -> Value {
    json!({
        "pot_noise": {
            "asset": cal.pot_noise.asset,
            "garbage": cal.pot_noise.garbage,
            "both": cal.pot_noise.both,
            "union": cal.pot_noise.union(),
        },
        "po_noise_entries": cal.po_noise_entries,
        "po_noise_translated": cal.po_noise_translated,
        "dat_raw_tag_rows": cal.dat_raw_tag_rows,
        "dat_rich_both_rows": cal.dat_rich_both_rows,
        "dat_filtered_tag_rows": cal.dat_filtered_tag_rows,
        "dat_font_only_rows": cal.dat_font_only_rows,
        "collapse_groups": cal.collapse_groups,
    })
}

/// JSON одного языка.
pub fn audit_json(audit: &LangAudit) -> String {
    json!({
        "lang": audit.lang,
        "pot_entries": audit.pot_entries,
        "po_entries": audit.po_entries,
        "po_filled": audit.po_filled,
        "dat_rows": audit.dat_rows,
        "calibration": calibration_json(&audit.calibration),
        "classes": classes_json(&audit.classes),
    })
    .to_string()
}

/// JSON самого POT (`tmp/lint-pot.json`).
pub fn pot_json(audit: &PotAudit) -> String {
    json!({
        "lang": "template.pot",
        "pot_entries": audit.entries,
        "po_entries": 0,
        "po_filled": 0,
        "dat_rows": 0,
        "calibration": calibration_json(&audit.calibration),
        "classes": classes_json(&audit.classes),
    })
    .to_string()
}

fn level_totals(classes: &BTreeMap<&'static str, ClassResult>) -> (usize, usize, usize) {
    let mut error = 0;
    let mut warn = 0;
    let mut info = 0;
    for c in classes.values() {
        match c.def.level {
            Level::Error => error += c.count,
            Level::Warn => warn += c.count,
            Level::Info => info += c.count,
        }
    }
    (error, warn, info)
}

fn code(s: &str, max: usize) -> String {
    let mut out: String = s.chars().take(max).collect();
    if s.chars().count() > max {
        out.push('…');
    }
    out.replace('`', "'").replace('\n', " ")
}

/// Счётчики класса по источникам: сначала POT (если есть находки), затем языки.
fn counts_line(pot: Option<&PotAudit>, audits: &[LangAudit], id: &str) -> Vec<(String, usize)> {
    let mut out = Vec::new();
    if let Some(pot) = pot {
        let n = pot.count(id);
        if n > 0 {
            out.push(("POT".to_string(), n));
        }
    }
    for a in audits {
        let n = a.count(id);
        if n > 0 {
            out.push((a.lang.clone(), n));
        }
    }
    out
}

fn render_counts(counts: &[(String, usize)]) -> String {
    if counts.is_empty() {
        return "нет".to_string();
    }
    counts
        .iter()
        .map(|(lang, n)| format!("{lang} {n}"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Markdown-отчёт: POT + языки (порядок audits сохраняется).
pub fn report_markdown(audits: &[LangAudit], pot: Option<&PotAudit>) -> String {
    let mut out = String::new();
    let langs: Vec<&str> = audits.iter().map(|a| a.lang.as_str()).collect();
    let pot_entries = pot
        .map(|p| p.entries)
        .or_else(|| audits.first().map(|a| a.pot_entries))
        .unwrap_or(0);

    out.push_str("# Аудит целостности данных POT/PO/DAT\n\n");
    let _ = writeln!(
        out,
        "Снимок: **{pot_entries}** записей POT, языки: {}.\n",
        langs.join(", ")
    );
    out.push_str(
        "Инструмент только читает: находки — это адреса и классы, правки не делаются. \
         Методика, калибровка и разбор — `docs/data-audit.md`.\n\n",
    );

    // ── POT ─────────────────────────────────────────────────────────
    if let Some(pot) = pot {
        let (e, w, i) = level_totals(&pot.classes);
        let _ = writeln!(
            out,
            "**POT**: {pot_entries} записей; error {e}, warn {w}, info {i}.\n"
        );
    }

    // ── Сводка по языкам ─────────────────────────────────────────────
    out.push_str("## Сводка по языкам\n\n");
    out.push_str("| Язык | PO записей | Заполнено | .dat строк | error | warn | info |\n");
    out.push_str("| ---- | ---------: | --------: | ---------: | ----: | ---: | ---: |\n");
    for a in audits {
        let (e, w, i) = level_totals(&a.classes);
        let _ = writeln!(
            out,
            "| `{}` | {} | {} | {} | {} | {} | {} |",
            a.lang, a.po_entries, a.po_filled, a.dat_rows, e, w, i
        );
    }
    out.push('\n');

    // ── Сводка по классам ────────────────────────────────────────────
    out.push_str("## Сводка по классам\n\n");
    out.push_str("| Класс | Уровень | Всего | Где |\n");
    out.push_str("| ----- | ------- | ----: | --- |\n");
    for def in CLASSES {
        let counts = counts_line(pot, audits, def.id);
        let total: usize = counts.iter().map(|(_, n)| n).sum();
        if total == 0 {
            continue;
        }
        let _ = writeln!(
            out,
            "| `{}` | {} | {} | {} |",
            def.id,
            def.level.as_ru(),
            total,
            render_counts(&counts)
        );
    }
    out.push('\n');
    out.push_str(
        "Классы с нулём не показаны — они проверены и чисты; полный список (включая нули) \
         есть в `tmp/lint-pot.json` и `tmp/lint-<lang>.json`.\n\n",
    );

    // ── Калибровка ───────────────────────────────────────────────────
    out.push_str("## Калибровка\n\n");
    let cal = audits
        .iter()
        .max_by_key(|a| a.calibration.dat_rich_both_rows)
        .map(|a| &a.calibration)
        .or_else(|| pot.map(|p| &p.calibration));
    if let Some(c) = cal {
        let _ = writeln!(
            out,
            "**Шум POT.** {} записей: `isAssetName` — {}, `isGarbageFragment` — {}, \
             пересечение — {} (объединение {}).",
            pot_entries,
            c.pot_noise.asset,
            c.pot_noise.garbage,
            c.pot_noise.both,
            c.pot_noise.union()
        );
        out.push_str(
            "Контроль: на снимке 2026-11-21 (33 271 запись) те же фильтры дают 4 297. \
             Расхождение объясняется ростом POT; проверяется повторным прогоном на старом \
             файле (`--pot <git show …>`), а не подгонкой.\n\n",
        );
        if c.dat_rich_both_rows == 0 {
            out.push_str(
                "В этом снимке явных `rt` нет (0 строк с `r` и `rt`), поэтому `font`-калибровка \
                 здесь нулевая. Она выполнена отдельно на снимке 2026-11-21 с явными `rt` \
                 (412 строк): отличий с учётом `<font>` — 48, после исключения — 0; см. \
                 `tmp/lint-report-old-dat.md`.\n\n",
            );
        } else {
            let _ = writeln!(
                out,
                "**`<font>`/`<material>`.** Строк с `r` и `rt`: {}; отличий по тегам с учётом \
                 `<font>` — {}, после исключения — {}, из них только-шрифтовых (ложных) — {}.",
                c.dat_rich_both_rows,
                c.dat_raw_tag_rows,
                c.dat_filtered_tag_rows,
                c.dat_font_only_rows
            );
            out.push_str(
                "Контроль: исторические 48 «дисбалансов» — это ровно `только-шрифтовые` строки \
                 на снимке 2026-11-21; наш чекер их не флагает.\n\n",
            );
        }
        let total_collapse: usize = audits.iter().map(|a| a.calibration.collapse_groups).sum();
        let _ = writeln!(
            out,
            "**Схлопнутые группы.** {} групп, где у одного текста несколько разных переводов, \
             а в `.dat` попадёт один:\n",
            total_collapse
        );
        for a in audits {
            if a.calibration.collapse_groups == 0 {
                continue;
            }
            let _ = writeln!(
                out,
                "- `{}`: {} групп",
                a.lang, a.calibration.collapse_groups
            );
        }
        out.push('\n');
    }

    // ── Разделы по классам ───────────────────────────────────────────
    out.push_str("## Классы подробно\n\n");
    for def in CLASSES {
        let counts = counts_line(pot, audits, def.id);
        let total: usize = counts.iter().map(|(_, n)| n).sum();
        if total == 0 {
            continue;
        }
        let _ = writeln!(
            out,
            "### {} (`{}`, {})\n",
            def.title,
            def.id,
            def.level.as_ru()
        );
        let _ = writeln!(out, "{}\n", def.what);
        let _ = writeln!(
            out,
            "Всего: **{}**. Где: {}.\n",
            total,
            render_counts(&counts)
        );
        out.push_str("Примеры:\n");
        let mut shown = 0;
        if let Some(pot) = pot {
            if let Some(result) = pot.classes.get(def.id) {
                for f in &result.samples {
                    if shown >= 5 {
                        break;
                    }
                    let _ = writeln!(
                        out,
                        "- **POT** `{}` — «{}» — {}",
                        f.loc,
                        code(&f.text, 90),
                        code(&f.detail, 160)
                    );
                    shown += 1;
                }
            }
        }
        for a in audits {
            if shown >= 5 {
                break;
            }
            let Some(result) = a.classes.get(def.id) else {
                continue;
            };
            for f in &result.samples {
                if shown >= 5 {
                    break;
                }
                let _ = writeln!(
                    out,
                    "- **{}** `{}` — «{}» — {}",
                    a.lang,
                    f.loc,
                    code(&f.text, 90),
                    code(&f.detail, 160)
                );
                shown += 1;
            }
        }
        if shown == 0 {
            out.push_str("- (примеры не сохранены)\n");
        }
        let _ = writeln!(out, "\nВердикт: **{}**.\n", def.verdict.as_ru());
    }

    // ── Полный список схлопнутых групп ───────────────────────────────
    if audits.iter().any(|a| a.count("dat.collapse") > 0) {
        out.push_str("## Схлопнутые группы: полный список\n\n");
        out.push_str(
            "Рантайм ищет по голому тексту, поэтому в `.dat` остаётся один вариант. \
             Это ограничение C#-рантайма, а не сборки; список нужен, чтобы помнить, \
             какие варианты переводчиков не прозвучат.\n\n",
        );
        for a in audits {
            let Some(result) = a.classes.get("dat.collapse") else {
                continue;
            };
            if result.count == 0 {
                continue;
            }
            let _ = writeln!(out, "### `{}` — {} групп\n", a.lang, result.count);
            for f in &result.samples {
                let _ = writeln!(out, "- «{}» — {}", code(&f.text, 120), code(&f.detail, 300));
            }
            out.push('\n');
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audit::{audit_pot, audit_strings};

    #[test]
    fn json_contains_every_class_and_calibration() {
        let pot = "#, x\nmsgid \"\"\nmsgstr \"h\"\n\nmsgctxt \"ui\"\nmsgid \"Hi\"\nmsgstr \"\"\n";
        let po = "msgctxt \"ui\"\nmsgid \"Hi\"\nmsgstr \"Привет\"\n";
        let dat = "{\"t\": \"Hi\", \"x\": \"Привет\"}\n";
        let audit = audit_strings("ru", pot, po, Some(dat));
        let text = audit_json(&audit);
        let value: Value = serde_json::from_str(&text).expect("валидный JSON");
        let classes = value["classes"].as_object().expect("classes");
        assert_eq!(classes.len(), CLASSES.len());
        assert!(classes.contains_key("po.anchor.empty"));
        assert!(value["calibration"]["pot_noise"]["union"].is_number());

        let pot_audit = audit_pot(pot);
        let pot_value: Value = serde_json::from_str(&pot_json(&pot_audit)).expect("POT JSON");
        assert_eq!(pot_value["lang"], "template.pot");
    }

    #[test]
    fn markdown_has_summary_and_no_zero_classes() {
        let pot = "msgid \"\"\nmsgstr \"h\"\n\nmsgctxt \"ui\"\nmsgid \"Hi\"\nmsgstr \"\"\n";
        let po = "msgctxt \"ui\"\nmsgid \"Hi\"\nmsgstr \"Привет\"\n";
        let dat = "{\"t\": \"Hi\", \"x\": \"Привет\"}\n";
        let audit = audit_strings("ru", pot, po, Some(dat));
        let pot_audit = audit_pot(pot);
        let md = report_markdown(&[audit], Some(&pot_audit));
        assert!(md.contains("## Сводка по языкам"));
        assert!(md.contains("## Калибровка"));
        assert!(
            !md.contains("### Пустой перевод"),
            "нулевые классы не разворачиваем"
        );
    }
}
