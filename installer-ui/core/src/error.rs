//! Ошибки ядра. Код — стабильная строка для UI (переводится на стороне TS),
//! detail — техническая причина для лога.

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    /// Нет папки payload или обязательных файлов в ней.
    PayloadMissing,
    /// В payload нет нужного языка (`patch_<lang>.dat`).
    LangUnavailable,
    /// Каталог не похож на установку игры (нет маркеров).
    GameInvalid,
    /// Манифеста нет: удалять/проверять нечего.
    ManifestMissing,
    /// Манифест битый или неизвестной версии.
    ManifestInvalid,
    /// Путь из манифеста выходит за пределы разрешённых.
    UnsafePath,
    /// Ошибка файловой системы.
    Io,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::PayloadMissing => "payload-missing",
            ErrorCode::LangUnavailable => "lang-unavailable",
            ErrorCode::GameInvalid => "game-invalid",
            ErrorCode::ManifestMissing => "manifest-missing",
            ErrorCode::ManifestInvalid => "manifest-invalid",
            ErrorCode::UnsafePath => "unsafe-path",
            ErrorCode::Io => "io",
        }
    }
}

#[derive(Debug, Clone)]
pub struct CoreError {
    pub code: ErrorCode,
    pub detail: String,
}

impl CoreError {
    pub fn new(code: ErrorCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }

    pub fn io(detail: impl Into<String>) -> Self {
        Self::new(ErrorCode::Io, detail)
    }

    /// Формат для Tauri: `код: подробность` (UI режет по первому `": "`).
    pub fn wire(&self) -> String {
        format!("{}: {}", self.code.as_str(), self.detail)
    }
}

impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.detail)
    }
}

impl std::error::Error for CoreError {}

impl From<std::io::Error> for CoreError {
    fn from(e: std::io::Error) -> Self {
        CoreError::io(e.to_string())
    }
}
