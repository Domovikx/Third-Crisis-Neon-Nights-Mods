//! report.rs — сериализация отчёта и находок.
//!
//! Формат машинно-сравнимый с TS: `--findings` пишет по одному объекту на
//! строку в порядке находок (ключи `level, rule, rel, text, detail`), поэтому
//! паритет проверяется побайтовым сравнением файлов.
//!
//! HTML-отчёт сюда НЕ переносится (решение: рендер — не узкое место, KISS;
//! см. `docs/qa-scaling.md`). Rust отдаёт данные, HTML рисует TS.

use crate::json::{number, quoted};
use crate::rules::{Finding, Report};

fn finding_json(f: &Finding) -> String {
    format!(
        "{{\"level\":{},\"rule\":{},\"rel\":{},\"text\":{},\"detail\":{}}}",
        quoted(f.level.as_str()),
        quoted(f.rule),
        quoted(&f.rel),
        quoted(&f.text),
        quoted(&f.detail)
    )
}

/// Находки как JSONL (одна строка на находку, `\n` в конце каждой).
pub fn findings_jsonl(findings: &[Finding]) -> String {
    let mut out = String::new();
    for f in findings {
        out.push_str(&finding_json(f));
        out.push('\n');
    }
    out
}

/// Полный отчёт: сводка + находки (один JSON-объект, pretty не нужен).
pub fn report_json(lang: &str, report: &Report) -> String {
    let s = &report.summary;
    let mut out = String::with_capacity(256 + report.findings.len() * 160);
    out.push_str("{\"lang\":");
    out.push_str(&quoted(lang));
    out.push_str(",\"summary\":{\"total\":");
    out.push_str(&number(s.total as f64));
    out.push_str(",\"filled\":");
    out.push_str(&number(s.filled as f64));
    out.push_str(",\"coverage\":");
    out.push_str(&number(s.coverage));
    out.push_str(",\"errors\":");
    out.push_str(&number(s.errors as f64));
    out.push_str(",\"warnings\":");
    out.push_str(&number(s.warnings as f64));
    out.push_str(",\"by_speaker\":[");
    for (i, (name, st)) in s.by_speaker.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push('[');
        out.push_str(&quoted(name));
        out.push_str(&format!(
            ",{{\"filled\":{},\"total\":{}}}]",
            st.filled, st.total
        ));
    }
    out.push_str("],\"by_dir\":[");
    for (i, (name, st)) in s.by_dir.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push('[');
        out.push_str(&quoted(name));
        out.push_str(&format!(
            ",{{\"filled\":{},\"total\":{}}}]",
            st.filled, st.total
        ));
    }
    out.push_str("]},\"findings\":[");
    for (i, f) in report.findings.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&finding_json(f));
    }
    out.push_str("]}");
    out
}
