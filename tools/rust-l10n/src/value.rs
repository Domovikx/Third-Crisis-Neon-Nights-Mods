//! value.rs — значение, которое может прочитать type tree объекта Unity.
//!
//! Набор ровно тот, что нужно для `strings`/`fields` дампа: примитивы, строки,
//! массивы и объекты (структуры). Числа разделены на целые и плавающие, потому
//! что JSONL печатает их по-разному: целые — как есть (`-3`), плавающие — как
//! Python `repr` (`60.0`, `1e-05`). Отдельный `U64` нужен для 64-битных
//! беззнаковых полей (`path_id`, `FileSize`): они не влезают в `i64` без потери.

/// Значение поля объекта.
#[derive(Clone, Debug, PartialEq)]
pub enum Val {
    /// `null` (в typetree не встречается, нужен для единообразия).
    Null,
    Bool(bool),
    /// Знаковое целое (int, long long, SInt8..SInt64).
    I64(i64),
    /// Беззнаковое целое (UInt*, unsigned long long, FileSize, Type*).
    U64(u64),
    /// Плавающее (float, double). Хранится как f64: float расширяется без потерь.
    F64(f64),
    Str(String),
    Arr(Vec<Val>),
    /// Структура: порядок ключей — порядок полей type tree (важен для вывода).
    Obj(Vec<(String, Val)>),
}

impl Val {
    /// Значение как число для сравнения в тестах (`I64`/`U64` не равны по типу).
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Val::I64(v) => Some(*v as f64),
            Val::U64(v) => Some(*v as f64),
            Val::F64(v) => Some(*v),
            _ => None,
        }
    }

    /// Строковое значение (для `strings`/`fsm`).
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Val::Str(s) => Some(s),
            _ => None,
        }
    }
}
