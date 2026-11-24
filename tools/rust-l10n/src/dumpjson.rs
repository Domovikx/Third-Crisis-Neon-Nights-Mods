//! dumpjson.rs — писатель JSONL дампа: формат Python `json.dumps`, не JS.
//!
//! Дамп сравнивается с эталоном побайтово (`docs/rust-vs-ts.md`), поэтому
//! важны две мелочи, которых нет в `JSON.stringify`:
//!
//! - разделители — `", "` и `": "` (как `json.dumps` по умолчанию);
//! - плавающие числа печатаются как Python `repr`: `60.0`, `1e-05`, `1e+16`.
//!
//! Строки экранируются общим правилом `rust_l10n_core::json::escape`
//! (оно побайтово совпадает с `JSON.stringify`/`json.dumps(ensure_ascii=False)`).

use rust_l10n_core::json::{escape, quoted};

/// Значение для вывода в JSONL дампа.
#[derive(Clone, Debug, PartialEq)]
pub enum J {
    Null,
    Bool(bool),
    /// Знаковое целое — печатается как есть (`-3`).
    I(i64),
    /// Беззнаковое 64-битное (`path_id` больше `i64::MAX`).
    U(u64),
    /// Плавающее — как Python `repr` (`60.0`, `1e-05`).
    F(f64),
    S(String),
    /// Готовый текст без кавычек (64-битный целочисленный id вне `i64`).
    Bare(String),
    Arr(Vec<J>),
    /// Объект: порядок ключей сохраняется (важен для паритета).
    Obj(Vec<(String, J)>),
}

impl J {
    pub fn s(value: impl Into<String>) -> J {
        J::S(value.into())
    }

    pub fn obj(pairs: Vec<(&str, J)>) -> J {
        J::Obj(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
    }
}

/// Python `repr(float)` — то же, что печатает эталонный дамп.
///
/// Кажется, что достаточно `format!("{}", x)`, но на ничьих (ровно посередине
/// между двумя 16-значными кандидатами) Rust округляет вверх, а Python/dtoa —
/// к чётной последней цифре: `0.6244583129882812` против `…13`. Поэтому ищем
/// МИНИМАЛЬНУЮ точность, при которой число читается обратно в тот же `f64`:
/// форматирование `{:.*e}` округляет корректно (half-to-even), как эталон.
pub fn py_float_repr(x: f64) -> String {
    if !x.is_finite() {
        return if x.is_nan() {
            "NaN".to_string()
        } else if x > 0.0 {
            "Infinity".to_string()
        } else {
            "-Infinity".to_string()
        };
    }
    if x == 0.0 {
        return if x.is_sign_negative() {
            "-0.0".to_string()
        } else {
            "0.0".to_string()
        };
    }

    // Кратчайшая форма с обратным чтением: экспонента `d.ddddde±k`.
    let mut sci = String::new();
    for precision in 1..=17usize {
        let candidate = format!("{:.*e}", precision - 1, x);
        if candidate.parse::<f64>() == Ok(x) {
            sci = candidate;
            break;
        }
    }
    if sci.is_empty() {
        sci = format!("{:e}", x);
    }

    let (mantissa, exp_text) = sci.split_once('e').unwrap_or((&sci, "0"));
    let exp: i32 = exp_text.parse().unwrap_or(0);
    let digits: String = mantissa
        .chars()
        .filter(|c| *c != '.' && *c != '-')
        .collect();
    let negative = mantissa.starts_with('-');

    let mut out = String::new();
    if negative {
        out.push('-');
    }
    if (-4..16).contains(&exp) {
        // Обычная запись: точка после `exp + 1` цифры.
        let point = exp + 1;
        let digits_vec: Vec<char> = digits.chars().collect();
        if point <= 0 {
            out.push_str("0.");
            for _ in 0..(-point) {
                out.push('0');
            }
            out.extend(digits_vec.iter());
        } else if (point as usize) >= digits_vec.len() {
            out.extend(digits_vec.iter());
            for _ in digits_vec.len()..point as usize {
                out.push('0');
            }
            out.push_str(".0");
        } else {
            out.extend(digits_vec[..point as usize].iter());
            out.push('.');
            out.extend(digits_vec[point as usize..].iter());
        }
    } else {
        // Экспоненциальная запись как у эталона: мантисса + `e±XX`.
        let mut mantissa_out = String::new();
        let digits_vec: Vec<char> = digits.chars().collect();
        mantissa_out.push(digits_vec[0]);
        let rest: String = digits_vec[1..].iter().collect();
        let rest = rest.trim_end_matches('0');
        if !rest.is_empty() {
            mantissa_out.push('.');
            mantissa_out.push_str(rest);
        }
        let sign = if exp < 0 { '-' } else { '+' };
        out.push_str(&mantissa_out);
        out.push('e');
        out.push(sign);
        out.push_str(&format!("{:02}", exp.abs()));
    }
    out
}

/// Отрисовать значение как `json.dumps(..., ensure_ascii=False)`.
pub fn render(value: &J) -> String {
    let mut out = String::with_capacity(256);
    write_value(&mut out, value);
    out
}

fn write_value(out: &mut String, value: &J) {
    match value {
        J::Null => out.push_str("null"),
        J::Bool(true) => out.push_str("true"),
        J::Bool(false) => out.push_str("false"),
        J::I(v) => out.push_str(&v.to_string()),
        J::U(v) => out.push_str(&v.to_string()),
        J::F(v) => out.push_str(&py_float_repr(*v)),
        J::Bare(text) => out.push_str(text),
        J::S(s) => {
            out.push('"');
            out.push_str(&escape(s));
            out.push('"');
        }
        J::Arr(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                write_value(out, item);
            }
            out.push(']');
        }
        J::Obj(pairs) => {
            out.push('{');
            for (i, (key, item)) in pairs.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                out.push_str(&quoted(key));
                out.push_str(": ");
                write_value(out, item);
            }
            out.push('}');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn float_repr_matches_python() {
        // Ожидания сняты с TS-эталона `pyFloatRepr` (2026-11-24).
        assert_eq!(py_float_repr(60.0), "60.0");
        assert_eq!(py_float_repr(0.00001), "1e-05");
        assert_eq!(py_float_repr(1e16), "1e+16");
        assert_eq!(py_float_repr(1.5), "1.5");
        assert_eq!(py_float_repr(-0.0), "-0.0");
        assert_eq!(py_float_repr(0.1), "0.1");
        assert_eq!(py_float_repr(1e-4), "0.0001");
        assert_eq!(
            py_float_repr(1.2345678901234567e20),
            "1.2345678901234567e+20"
        );
        assert_eq!(py_float_repr(-3.4e-5), "-3.4e-05");
        assert_eq!(py_float_repr(1e21), "1e+21");
        assert_eq!(py_float_repr(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(py_float_repr(1.0 / 3.0), "0.3333333333333333");
        assert_eq!(py_float_repr(f64::NAN), "NaN");
        assert_eq!(py_float_repr(f64::INFINITY), "Infinity");
    }

    #[test]
    fn render_python_separators() {
        let row = J::obj(vec![
            ("a", J::I(-3)),
            ("b", J::F(60.0)),
            ("c", J::s("x\"y")),
            ("d", J::Arr(vec![J::I(1), J::I(2)])),
        ]);
        assert_eq!(
            render(&row),
            r#"{"a": -3, "b": 60.0, "c": "x\"y", "d": [1, 2]}"#
        );
    }

    #[test]
    fn render_keeps_key_order_and_unicode() {
        let row = J::Obj(vec![
            ("zz".to_string(), J::s("привет")),
            ("aa".to_string(), J::Null),
        ]);
        assert_eq!(render(&row), r#"{"zz": "привет", "aa": null}"#);
    }
}
