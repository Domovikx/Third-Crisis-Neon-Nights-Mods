//! dat.rs — загрузка `runtime/patch_<lang>.dat` (JSONL, один объект на строку).
//!
//! Контракт TS-эталона (`qa_translate.mts::loadDat`): битые строки
//! пропускаются, ключ — `t`, ПЕРВАЯ строка с таким `t` побеждает.

use std::collections::HashMap;
use std::path::Path;

use serde_json::Value;

/// Нужные QA поля строки `.dat` (`r`/`rt` — rich-разметка, `sk` — legacy-триаж).
#[derive(Debug, Default, Clone)]
pub struct DatRow {
    pub x: String,
    pub r: String,
    pub rt: String,
    pub sk: bool,
}

/// JS-истинность значения (для `Boolean(row.sk)`): строка важна постольку,
/// поскольку в данных `sk` — boolean, но контракт не должен падать на мусоре.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

fn string_of(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

/// Прочитать `.dat`; нет файла — пустая карта (язык без собранного словаря).
pub fn load_dat(path: &Path) -> HashMap<String, DatRow> {
    let mut rows: HashMap<String, DatRow> = HashMap::new();
    let Ok(text) = std::fs::read_to_string(path) else {
        return rows;
    };
    for line in text.split(['\r', '\n']) {
        if line.trim().is_empty() {
            continue;
        }
        // Битая строка — как в Python/TS-версии, пропускаем.
        let Ok(Value::Object(map)) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(Value::String(t)) = map.get("t") else {
            continue;
        };
        if t.is_empty() || rows.contains_key(t) {
            continue;
        }
        let sk = map.get("sk").is_some_and(truthy);
        rows.insert(
            t.clone(),
            DatRow {
                x: string_of(map.get("x")),
                r: string_of(map.get("r")),
                rt: string_of(map.get("rt")),
                sk,
            },
        );
    }
    rows
}
