//! classes.rs — реестр классов дефектов: уровень, вердикт, описание.
//!
//! Один класс = один идентификатор в JSON и один раздел в отчёте. Реестр
//! статичен намеренно: отчёт обязан печатать и классы с нулём находок
//! («проверено, чисто»), иначе отсутствие строки неотличимо от отсутствия
//! проверки. Тест `tests/classes.rs` следит, чтобы у каждого класса была
//! синтетическая фикстура.

/// Уровень находки.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    /// Ломает игру или данные.
    Error,
    /// Подозрительно; нужно посмотреть человеком.
    Warn,
    /// Шум известного типа или справочная информация.
    Info,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Error => "error",
            Level::Warn => "warn",
            Level::Info => "info",
        }
    }

    /// Русская подпись для markdown-отчёта.
    pub fn as_ru(self) -> &'static str {
        match self {
            Level::Error => "ошибка",
            Level::Warn => "предупреждение",
            Level::Info => "инфо",
        }
    }
}

/// Что делать с находкой (вердикт отчёта).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Дефект в данных: править `po/` или источник.
    Data,
    /// Дефект пайплайна: править генератор/слияние/сборку.
    Pipeline,
    /// Не дефект: известный шум, ограничение рантайма или контроль калибровки.
    NotDefect,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Data => "data",
            Verdict::Pipeline => "pipeline",
            Verdict::NotDefect => "not-defect",
        }
    }

    pub fn as_ru(self) -> &'static str {
        match self {
            Verdict::Data => "чинить в данных",
            Verdict::Pipeline => "чинить в пайплайне",
            Verdict::NotDefect => "не дефект",
        }
    }
}

/// Описание класса дефекта.
#[derive(Clone, Copy, Debug)]
pub struct ClassDef {
    pub id: &'static str,
    pub level: Level,
    pub verdict: Verdict,
    pub title: &'static str,
    pub what: &'static str,
    /// Сколько примеров хранить в машинном JSON (счётчик считается целиком).
    pub sample_cap: usize,
}

const fn class(
    id: &'static str,
    level: Level,
    verdict: Verdict,
    title: &'static str,
    what: &'static str,
) -> ClassDef {
    ClassDef {
        id,
        level,
        verdict,
        title,
        what,
        sample_cap: 200,
    }
}

const fn class_cap(
    id: &'static str,
    level: Level,
    verdict: Verdict,
    title: &'static str,
    what: &'static str,
    sample_cap: usize,
) -> ClassDef {
    ClassDef {
        id,
        level,
        verdict,
        title,
        what,
        sample_cap,
    }
}

/// Полный реестр. Порядок = порядок разделов отчёта.
pub const CLASSES: &[ClassDef] = &[
    // ── Структура и ключи ────────────────────────────────────────────────
    class(
        "pot.duplicate-key",
        Level::Error,
        Verdict::Pipeline,
        "Дубликат ключа в POT",
        "Одна пара (msgctxt, msgid) встречается в template.pot больше одного раза. \
         POT — множество пар; дубликат означает, что генератор не слил записи.",
    ),
    class(
        "po.duplicate-key-diff",
        Level::Error,
        Verdict::Data,
        "Дубликат ключа с разными переводами",
        "В одном PO одна пара (msgctxt, msgid) имеет несколько разных msgstr. \
         Какой из них попадёт в словарь, решает порядок сортировки, а не смысл.",
    ),
    class(
        "po.duplicate-key-same",
        Level::Info,
        Verdict::NotDefect,
        "Дубликат ключа с одинаковым переводом",
        "Повтор пары (msgctxt, msgid) с тем же msgstr. Смысла не меняет, но \
         раздувает файл; чистится слиянием.",
    ),
    class(
        "po.empty-msgid",
        Level::Error,
        Verdict::Pipeline,
        "Пустой msgid в теле файла",
        "Запись без msgid (кроме заголовочной). Такую строку нельзя ни найти \
         в игре, ни перевести; обычно это следствие битого слияния.",
    ),
    class(
        "po.malformed-field",
        Level::Error,
        Verdict::Data,
        "Битая строка поля PO",
        "Строка начинается с msgid/msgctxt/msgstr или кавычки, но не разбирается \
         парсером (нет закрывающей кавычки и т.п.). Поле молча теряется; чинится \
         пересозданием/починкой PO, а не игрой.",
    ),
    class(
        "po.orphan-text",
        Level::Warn,
        Verdict::Pipeline,
        "Перевод текста, которого нет в POT",
        "Запись PO ссылается на текст, отсутствующий в template.pot: строка \
         исчезла из игры, а перевод остался. В рантайме это мёртвый груз \
         (и потенциально чужая подстановка по голому тексту).",
    ),
    class(
        "po.orphan-context",
        Level::Warn,
        Verdict::Pipeline,
        "Контекст (спикер) исчез из POT",
        "Текст в POT есть, а пары (msgctxt, msgid) — нет: контекст переименован \
         или схлопнут при пересборке. Перевод этого варианта теряется.",
    ),
    class(
        "po.missing-key",
        Level::Error,
        Verdict::Pipeline,
        "Ключ POT отсутствует в PO",
        "После `po:update` каждая пара POT обязана быть в PO (пусть с пустым \
         msgstr). Отсутствие ключа — потеря строки на слиянии.",
    ),
    class(
        "po.copy-through",
        Level::Warn,
        Verdict::Data,
        "Перевод совпадает с оригиналом",
        "Заполненный msgstr равен msgid у человекочитаемой строки: перевод не \
         сделан, а выдан за сделанный.",
    ),
    class(
        "po.copy-through-noise",
        Level::Info,
        Verdict::NotDefect,
        "Копия оригинала у шума/имени/термина",
        "msgstr == msgid у имени ассета, бинарного фрагмента, имени персонажа \
         (`speaker-name`) или одиночного термина. Это штатный авто-триаж: такие \
         строки не переводятся.",
    ),
    class(
        "po.key-drift",
        Level::Warn,
        Verdict::Pipeline,
        "Ключ отличается пробелами/невидимками",
        "Текст PO совпадает с POT только после нормализации пробелов или \
         невидимых символов. Рантайм ищет по точному тексту, поэтому перевод \
         может не примениться.",
    ),
    // ── Экранирование и кодировка ────────────────────────────────────────
    class(
        "po.escape.double",
        Level::Warn,
        Verdict::Data,
        "Двойное экранирование",
        "В значении остались литеральные `\\n`, `\\t`, `\\r` или `\\\"` \
         (обратный слэш + буква). Обычно текст экранировали дважды; в игре \
         будет виден сам слэш.",
    ),
    class(
        "po.escape.backslash",
        Level::Info,
        Verdict::Data,
        "Лишний обратный слэш",
        "В человекочитаемом значении есть обратный слэш, не образующий \
         известной escape-последовательности. Проверить, не остаток ли это \
         сырых байтов.",
    ),
    class(
        "po.escape.unknown",
        Level::Warn,
        Verdict::Data,
        "Неизвестная escape-последовательность",
        "В исходной строке PO есть `\\x` с неизвестной буквой. Парсер её \
         «съедает» (слэш пропадает), поэтому данные меняются молча.",
    ),
    class(
        "po.encoding.zero-width",
        Level::Error,
        Verdict::Data,
        "Невидимый / bidi-символ",
        "ZWSP, ZWNJ, ZWJ, BOM, мягкий перенос или bidi-марка. Такие символы \
         ломают поиск по тексту и могут визуально переставлять строку.",
    ),
    class(
        "po.encoding.nbsp",
        Level::Warn,
        Verdict::Data,
        "Неразрывный пробел (NBSP)",
        "U+00A0 вместо обычного пробела. Иногда намеренно (типографика), но \
         для поиска и сравнения это другой символ.",
    ),
    class(
        "po.encoding.mixed-alpha",
        Level::Warn,
        Verdict::Data,
        "Смешанные алфавиты внутри слова",
        "В одном слове есть и кириллица, и латиница (например, латинская `c` \
         в русском слове). Классическая невидимая опечатка.",
    ),
    class(
        "po.encoding.mojibake",
        Level::Error,
        Verdict::Data,
        "Мохибейк",
        "UTF-8, прочитанный как cp1251/cp866 (или наоборот). Текст в игре \
         превращается в мусор; лечится перекодировкой источника.",
    ),
    class(
        "po.encoding.typographic",
        Level::Warn,
        Verdict::NotDefect,
        "Типографская кавычка в латинском слове",
        "Кудрявый апостроф/кавычка вплотную к латинским буквам. Для `de`, `pl` и `fr` это \
         стандартная типографика (в данных только она и найдена), для остальных языков — \
         риск сломать поиск и сравнение.",
    ),
    // ── Разметка ─────────────────────────────────────────────────────────
    class(
        "po.tag.balance",
        Level::Error,
        Verdict::Data,
        "Несбалансированные теги",
        "В переводе открыт тег без закрытия или есть лишнее закрытие \
         (`<i>`, `<b>`, `<color>`, `<size>` и т.п.). `<font>` и `<material>` \
         намеренно не учитываются — их выбирает рантайм.",
    ),
    class(
        "po.tag.unclosed",
        Level::Info,
        Verdict::NotDefect,
        "Тег не закрыт до конца строки",
        "Открытый `<i>`/`<b>`/`<color>` без закрытия. TMP закрывает такой тег \
         неявно в конце строки; для `rich_text` это частый осознанный приём. \
         Класс существует, чтобы отделить это от реального лишнего закрытия.",
    ),
    class(
        "po.tag.nesting",
        Level::Error,
        Verdict::Data,
        "Нарушена вложенность тегов",
        "Закрытие идёт не в том порядке: `<b><i>…</b></i>`. Rich-текст в \
         таком виде рендерится непредсказуемо.",
    ),
    class(
        "po.tag.missing",
        Level::Warn,
        Verdict::Data,
        "Потерян тег оригинала",
        "В переводе меньше тегов, чем в оригинале (с учётом rich_text). \
         Стилизация теряется.",
    ),
    class(
        "po.tag.extra",
        Level::Warn,
        Verdict::Data,
        "Лишний тег в переводе",
        "В переводе есть тег, которого нет в оригинале. Иногда это осознанное \
         выделение, но проверять нужно: лишний тег легко не закрыть.",
    ),
    // ── Смысловые якоря ──────────────────────────────────────────────────
    class(
        "po.anchor.numbers",
        Level::Warn,
        Verdict::Data,
        "Числа не совпадают с оригиналом",
        "Последовательность цифр в переводе отличается от оригинала. Числа — \
         механика (количество, цена, статы), их не локализуют.",
    ),
    class(
        "po.anchor.line-ids",
        Level::Warn,
        Verdict::Data,
        "Номер строки не совпадает",
        "Идентификатор вида `132-…` в переводе изменён. По нему ищут строку в \
         дампе и ассетах.",
    ),
    class(
        "po.anchor.placeholders",
        Level::Error,
        Verdict::Data,
        "Плейсхолдеры потеряны или переставлены",
        "`{0}`, `%s`, `%d`, `[name]` и подобные должны совпадать по количеству \
         и порядку: иначе подстановка в рантайме уйдёт не туда.",
    ),
    class(
        "po.anchor.empty",
        Level::Info,
        Verdict::NotDefect,
        "Пустой перевод",
        "msgstr пуст. Для непереведённого языка это нормальное состояние; класс \
         существует, чтобы отличать «не переведено» от «переведено пусто».",
    ),
    class(
        "po.anchor.single-char",
        Level::Warn,
        Verdict::Data,
        "Перевод из одного символа",
        "Оригинал длиннее, а перевод — один символ. Похоже на обрывок или \
         случайное нажатие.",
    ),
    class(
        "po.anchor.truncated",
        Level::Info,
        Verdict::Data,
        "Похоже на обрезку",
        "Оригинал заканчивается точкой/восклицанием, а перевод — буквой без \
         завершения. Эвристика: требует глазами, поэтому инфо.",
    ),
    // ── Словарь .dat ─────────────────────────────────────────────────────
    class(
        "dat.missing-file",
        Level::Error,
        Verdict::Pipeline,
        "Нет файла словаря",
        "`runtime/patch_<lang>.dat` отсутствует, хотя PO есть. Язык не \
         собран — в игре будет молчание.",
    ),
    class(
        "dat.parse-error",
        Level::Error,
        Verdict::Pipeline,
        "Битая строка .dat",
        "Строка не разбирается как JSON-объект с непустым `t`. Загрузчик C# \
         такую строку пропускает — перевод молча теряется.",
    ),
    class(
        "dat.duplicate-key",
        Level::Warn,
        Verdict::Pipeline,
        "Дубликат `t` в .dat",
        "Один и тот же текст встречается несколько раз. Загрузчик берёт первую \
         строку; остальные — мёртвый вес и потенциальная путаница.",
    ),
    class(
        "dat.unknown-field",
        Level::Info,
        Verdict::NotDefect,
        "Неизвестное поле строки",
        "В JSON-строке есть ключ вне контракта `t/x/r/rt/sk`. Рантайм его \
         игнорирует; полезно знать, если поле задумывалось.",
    ),
    class(
        "dat.not-in-pot",
        Level::Error,
        Verdict::Data,
        "Строка .dat не из POT/PO",
        "`t` нет ни в PO, ни в POT — остаток старой сборки или мусор. Такой \
         перевод может сработать по голому тексту в неожиданном месте.",
    ),
    class(
        "dat.not-in-po",
        Level::Error,
        Verdict::Pipeline,
        "Строка .dat есть в POT, но не в PO",
        "`t` из POT отсутствует в PO, но попал в словарь. Значит, .dat собран \
         не из текущего PO (или PO потерял ключ).",
    ),
    class(
        "dat.lost-translation",
        Level::Error,
        Verdict::Pipeline,
        "Заполненный перевод не попал в .dat",
        "В PO есть непустой msgstr, а строки в .dat нет или `x` пуст. Игрок \
         увидит оригинал при готовом переводе.",
    ),
    class(
        "dat.invented",
        Level::Error,
        Verdict::Pipeline,
        "Перевод в .dat без источника в PO",
        "`x` непуст, а в PO для этого текста нет ни одного заполненного \
         msgstr. Словарь содержит перевод, которого нет в источнике.",
    ),
    class(
        "dat.mismatch",
        Level::Error,
        Verdict::Pipeline,
        "Перевод .dat не совпадает с PO",
        "`x` не равен ни одному варианту msgstr для этого текста. .dat устарел \
         или собран из другого файла.",
    ),
    class(
        "dat.copy-through",
        Level::Warn,
        Verdict::Data,
        "В .dat перевод = оригинал",
        "`x == t` при заполненном msgstr у человекочитаемой строки. То же, что \
         copy-through в PO, но уже в рантайм-словаре.",
    ),
    class(
        "dat.copy-through-noise",
        Level::Info,
        Verdict::NotDefect,
        "В .dat копия у шума/имени/термина",
        "`x == t` у имени ассета, бинарного фрагмента или одиночного термина — \
         штатный авто-триаж.",
    ),
    class_cap(
        "dat.collapse",
        Level::Info,
        Verdict::NotDefect,
        "Разные переводы схлопнуты в одну строку",
        "Рантайм ищет по голому тексту, поэтому .dat хранит один вариант на \
         текст. Группа показывает, какие переводы разных спикеров потеряны. \
         Это ограничение C#-рантайма, а не сборки.",
        5000,
    ),
    class(
        "dat.rich-lost",
        Level::Error,
        Verdict::Pipeline,
        "Потерян rich_text",
        "У оригинала есть `#. rich_text`, а в .dat нет строки или поля `r`. \
         Стилизованная реплика отрисуется без разметки.",
    ),
    class(
        "dat.rich-mismatch",
        Level::Error,
        Verdict::Pipeline,
        "rich_text в .dat не совпадает с POT",
        "Поле `r` отличается от `#. rich_text` шаблона. Это уже не перевод, а \
         рассинхронизация сборки.",
    ),
    class(
        "dat.rich-extra",
        Level::Warn,
        Verdict::Pipeline,
        "rich_text в .dat без источника",
        "Поле `r` есть, а в POT у этого текста нет `#. rich_text`.",
    ),
    class(
        "dat.rt-mismatch",
        Level::Warn,
        Verdict::Data,
        "Явный rich_translation не совпадает с PO",
        "У переводчика есть `# rich:`, а поле `rt` в .dat другое (или наоборот).",
    ),
    class(
        "dat.rt-unclosed",
        Level::Info,
        Verdict::NotDefect,
        "Незакрытый тег в rich_translation",
        "В `rt` остался открытый тег до конца строки (TMP закроет неявно). \
         Отделено от лишнего закрытия/нарушенной вложенности.",
    ),
    class(
        "dat.rt-tags",
        Level::Warn,
        Verdict::Data,
        "Теги rich_translation расходятся с rich_text",
        "Набор тегов в `rt` отличается от `r` (без `<font>`/`<material>`). \
         Обычно это ручная правка разметки перевода.",
    ),
    class(
        "dat.rt-balance",
        Level::Error,
        Verdict::Data,
        "Несбалансированные теги в rich_translation",
        "В поле `rt` открыт тег без закрытия или нарушена вложенность.",
    ),
    // ── Калибровка / шум ─────────────────────────────────────────────────
    class(
        "pot.noise",
        Level::Info,
        Verdict::NotDefect,
        "Шумовая запись POT",
        "Имя ассета или бинарный фрагмент по фильтрам `isAssetName` / \
         `isGarbageFragment`. Переводить не нужно; счётчик — контроль \
         калибровки (известный порядок величины).",
    ),
];

/// Найти описание класса по идентификатору.
pub fn class_def(id: &str) -> Option<&'static ClassDef> {
    CLASSES.iter().find(|c| c.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn ids_are_unique() {
        let mut seen = HashSet::new();
        for c in CLASSES {
            assert!(seen.insert(c.id), "дубликат id: {}", c.id);
        }
    }

    #[test]
    fn every_id_has_a_description() {
        for c in CLASSES {
            assert!(!c.title.is_empty(), "{}: пустой title", c.id);
            assert!(!c.what.is_empty(), "{}: пустое описание", c.id);
        }
    }
}
