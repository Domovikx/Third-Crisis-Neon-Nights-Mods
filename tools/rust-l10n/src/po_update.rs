//! po_update.rs — перенос переводов в новый `template.pot` (аналог `msgmerge -U`).
//!
//! Порт `.opencode/skills/extract-text/scripts/po_update.mts` (поведение 1:1,
//! паритет — гейт `scripts/text_parity.test.mts`). Цикл обновления:
//!
//! - точное совпадение `(msgid, msgctxt)` → перевод переносится, refs/comments
//!   берутся из POT;
//! - ключ исчез, текст жив под другим ctxt → ретаргет (рантайм ключует по
//!   голому тексту);
//! - текст пропал из POT целиком → запись остаётся живой с флагом `legacy`
//!   (потеря живого перевода — регрессия, мёртвая строка безвредна);
//! - новый ключ в POT → пустая запись в конце;
//! - комментарии переводчика всегда переносятся;
//! - fuzzy-догадок нет (эвристики миграции — у `prefill`).
//!
//! **Учёт выпавших ключей** (то, чем страдал TS-эталон и что дало 1 321 мёртвый
//! перевод, `docs/data-audit.md` §5.3): отчёт печатает `carried`, `new`,
//! `retargeted`, `dropped`, `orphans`, `legacy_kept`, `dup_keys`; каждый
//! выпавший ключ виден поимённо (с видео «где текст жив»), а `dropped > 0` —
//! повод для явного предупреждения. Счётчики не влияют на байты PO.
//!
//! Странности оригинала сохранены намеренно: «заголовок» = первый блок файла
//! до первой пустой строки (в PO без заголовка туда попадает весь файл).
//!
//! CLI: `rust-l10n po_update [lang] [--po-dir <dir>] [--root <dir>]
//!       [--dup-rule last|earliest-ref] [--json <path>]`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use rust_l10n_core::json::quoted;
use rust_l10n_core::po::{escape_po, js_ws, parse_po, PoEntry};

use crate::refs::ref_sort_key;

/// Ключ каталога PO: пара (msgid, msgctxt), как tuple в Python.
pub type PoKey = (String, String);

/// Запись в рендере может нести архивный флаг `obsolete` (стиль gettext).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergedEntry {
    pub po: PoEntry,
    pub obsolete: bool,
}

/// Как выбирать победителя, если в исходном PO один ключ записан дважды.
///
/// - [`DupRule::Last`] — последний блок побеждает: поведение TS-эталона и
///   `msgmerge` (dict/Map «последний затирает»). Значение по умолчанию —
///   паритет с оракулом.
/// - [`DupRule::EarliestRef`] — побеждает запись с самым ранним `#:` (то, что
///   увидит рантайм: `po2dat` решает дубли по earliest-ref). Включается флагом
///   `--dup-rule earliest-ref` для аудита данных. На реальном корпусе правила
///   эквивалентны (дублей ключей нет), поэтому паритет не зависит от выбора.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DupRule {
    #[default]
    Last,
    EarliestRef,
}

impl DupRule {
    /// Разбор значения CLI (`last` / `earliest-ref`).
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "last" => Some(DupRule::Last),
            "earliest-ref" => Some(DupRule::EarliestRef),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            DupRule::Last => "last",
            DupRule::EarliestRef => "earliest-ref",
        }
    }
}

/// Почему перевод из старого PO не попал в новый.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropReason {
    /// Текст жив в POT, но под контекстом, который уже переведён (вариант
    /// «дублирующегося контекста» — те 48 групп из `docs/data-audit.md`).
    AlreadyTranslated,
    /// Два исчезнувших ключа претендовали на один целевой — выжил последний
    /// по сортировке (правило ретаргета), значение первого потеряно.
    RetargetOverwritten,
}

impl DropReason {
    pub fn as_str(self) -> &'static str {
        match self {
            DropReason::AlreadyTranslated => "already-translated",
            DropReason::RetargetOverwritten => "retarget-overwritten",
        }
    }
}

/// Перевод, который в этом прогоне некуда применить.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DroppedTranslation {
    pub key: PoKey,
    pub msgstr: String,
    pub reason: DropReason,
    /// Контексты POT с тем же текстом (куда он «переехал»).
    pub alive: Vec<String>,
}

/// Ретаргет: ключ `from` исчез, перевод спасён на ключ `to`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Retarget {
    pub from: PoKey,
    pub to: PoKey,
}

/// Сирота: запись в PO, чьего ключа нет в POT (она живёт только для рантайма
/// по голому тексту и помечена `legacy`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Orphan {
    pub key: PoKey,
    pub msgstr: String,
}

/// Дубль ключа в исходном PO: варианты и выбранный по правилу.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DupKey {
    pub key: PoKey,
    /// Различные непустые переводы ключа в порядке файла.
    pub variants: Vec<String>,
    /// Победитель по [`DupRule`].
    pub chosen: String,
}

/// Статистика слияния. Имена счётчиков — как у TS-эталона (`carried`, `new`,
/// `obsolete`, `retargeted`, `legacy_kept`) плюс новые: `dropped`, `orphans`,
/// `dup_keys` — ровно то, чего не хватало для видимости выпавших ключей.
#[derive(Debug, Clone, Default)]
pub struct MergeStats {
    pub carried: usize,
    pub new: usize,
    pub obsolete: usize,
    /// Ретаргеты, которые реально доехали до PO; затёртые другим кандидатом
    /// попадают в `dropped` (`RetargetOverwritten`).
    pub retargeted: usize,
    pub legacy_kept: usize,
    /// Потерянные в ЭТОМ прогоне переводы (см. [`DroppedTranslation`]).
    pub dropped: usize,
    /// Всего сирот в выходном PO (включая ранее помеченные `legacy`).
    pub orphans: usize,
    /// Дубли ключа в исходном PO с разными переводами.
    pub dup_keys: usize,
    pub dropped_items: Vec<DroppedTranslation>,
    pub retarget_items: Vec<Retarget>,
    pub orphan_items: Vec<Orphan>,
    pub dup_items: Vec<DupKey>,
}

#[derive(Debug, Clone)]
pub struct MergeOutcome {
    pub merged: Vec<MergedEntry>,
    pub stats: MergeStats,
}

/// Ключ для карт слияния — заимствованный: на 10 языках это 40 тыс. записей,
/// и клонирование пары строк на каждую (в карту, в множество, в поиск) стоило
/// ~50 мс из 140 — дороже самого парсинга PO.
type KeyRef<'a> = (&'a str, &'a str);

fn key_ref(e: &PoEntry) -> KeyRef<'_> {
    (e.msgid.as_str(), e.msgctxt.as_str())
}

struct Fill<'a> {
    source: KeyRef<'a>,
    msgstr: &'a str,
    translator: &'a [String],
}

/// Слить переводы вперёд. Возвращает записи в порядке POT + хвост сирот.
///
/// Порядок операций важен (как в TS-эталоне): сначала собираются ретаргеты по
/// всем исчезнувшим ключам (в отсортированном порядке, поэтому при двух
/// кандидатах на один целевой ключ побеждает последний по сортировке), затем
/// POT рендерится построчно, затем хвост исчезнувших переводов.
pub fn merge_pot<'a>(
    po_entries: &'a [PoEntry],
    pot_entries: &'a [PoEntry],
    dup_rule: DupRule,
) -> MergeOutcome {
    let mut stats = MergeStats::default();

    // 1. Старые переводы: ключ → запись (победитель по `dup_rule`).
    let mut po_map: HashMap<KeyRef<'a>, &'a PoEntry> = HashMap::new();
    let mut dup_variants: BTreeMap<KeyRef<'a>, Vec<String>> = BTreeMap::new();
    for e in po_entries {
        if e.msgid.is_empty() {
            continue;
        }
        let key = key_ref(e);
        if let Some(prev) = po_map.get(&key) {
            if prev.msgstr != e.msgstr {
                let slot = dup_variants.entry(key).or_insert_with(|| {
                    let mut first: Vec<String> = Vec::new();
                    if !prev.msgstr.is_empty() {
                        first.push(prev.msgstr.clone());
                    }
                    first
                });
                if !e.msgstr.is_empty() && !slot.contains(&e.msgstr) {
                    slot.push(e.msgstr.clone());
                }
            }
        }
        let keep_new = match (dup_rule, po_map.get(&key)) {
            (DupRule::EarliestRef, Some(prev)) => ref_sort_key(e) < ref_sort_key(prev),
            _ => true,
        };
        if keep_new {
            po_map.insert(key, e);
        }
    }
    stats.dup_keys = dup_variants.len();
    stats.dup_items = dup_variants
        .into_iter()
        .map(|(key, variants)| DupKey {
            chosen: po_map
                .get(&key)
                .map(|e| e.msgstr.clone())
                .unwrap_or_default(),
            key: (key.0.to_string(), key.1.to_string()),
            variants,
        })
        .collect();

    // 2. Инвентарь POT: ключи + группы по тексту.
    let mut pot_key_ids: HashSet<KeyRef<'a>> = HashSet::new();
    let mut pot_by_text: HashMap<&'a str, Vec<usize>> = HashMap::new();
    for (i, e) in pot_entries.iter().enumerate() {
        if e.msgid.is_empty() {
            continue;
        }
        pot_key_ids.insert(key_ref(e));
        pot_by_text.entry(e.msgid.as_str()).or_default().push(i);
    }

    // 3. Исчезнувшие ключи в порядке Python `sorted()` по (msgid, msgctxt).
    let mut vanished: Vec<KeyRef<'a>> = po_map
        .keys()
        .filter(|k| !pot_key_ids.contains(*k))
        .copied()
        .collect();
    vanished.sort_unstable();

    // 4. Ретаргеты: перевод исчезнувшего ключа → первый по msgctxt живой
    //    (непереведённый) одноимённый ключ POT.
    let mut fills: HashMap<KeyRef<'a>, Fill<'a>> = HashMap::new();
    let mut fill_sources: HashSet<KeyRef<'a>> = HashSet::new();
    for key in &vanished {
        let old = po_map[key];
        if old.msgstr.is_empty() || old.flags.iter().any(|f| f == "legacy") {
            continue;
        }
        let Some(cands) = pot_by_text.get(old.msgid.as_str()) else {
            continue;
        };
        // Если хоть один одноимённый ключ уже переведён, спасать некуда:
        // текст жив и без этого ретаргета.
        let live = cands.iter().any(|&i| {
            po_map
                .get(&key_ref(&pot_entries[i]))
                .is_some_and(|x| !x.msgstr.is_empty())
        });
        if live {
            continue;
        }
        let mut sorted: Vec<usize> = cands.clone();
        sorted.sort_by(|&a, &b| pot_entries[a].msgctxt.cmp(&pot_entries[b].msgctxt));
        let target = key_ref(&pot_entries[sorted[0]]);
        fill_sources.insert(*key);
        let fill = Fill {
            source: *key,
            msgstr: old.msgstr.as_str(),
            translator: &old.translator,
        };
        if let Some(prev) = fills.insert(target, fill) {
            // Второй исчезнувший ключ затёр первый: вариант потерян, но виден.
            stats.dropped += 1;
            stats.dropped_items.push(DroppedTranslation {
                key: (prev.source.0.to_string(), prev.source.1.to_string()),
                msgstr: prev.msgstr.to_string(),
                reason: DropReason::RetargetOverwritten,
                alive: vec![target.1.to_string()],
            });
        }
    }

    // 5. POT построчно.
    let mut merged: Vec<MergedEntry> = Vec::with_capacity(pot_entries.len() + 8);
    for pe in pot_entries {
        if pe.msgid.is_empty() {
            continue;
        }
        let key = key_ref(pe);
        let old = po_map.get(&key).copied();
        // Ретаргет заполняет только пустую запись: живой перевод не перетираем.
        let fill = match (fills.get(&key), old) {
            (Some(fill), None) => Some(fill),
            (Some(fill), Some(o)) if o.msgstr.is_empty() => Some(fill),
            _ => None,
        };
        let entry = PoEntry {
            msgid: pe.msgid.clone(),
            msgctxt: pe.msgctxt.clone(),
            msgstr: match (fill, old) {
                (Some(f), _) => f.msgstr.to_string(),
                (None, Some(o)) => o.msgstr.clone(),
                (None, None) => String::new(),
            },
            refs: pe.refs.clone(),
            comments: pe.comments.clone(),
            // `auto-normalized` — машинная догадка prefill: в новый POT не едет.
            flags: match (fill, old) {
                (Some(_), None) => Vec::new(),
                (_, Some(o)) => o
                    .flags
                    .iter()
                    .filter(|f| *f != "auto-normalized")
                    .cloned()
                    .collect(),
                (None, None) => Vec::new(),
            },
            translator: match (fill, old) {
                (Some(f), _) => f.translator.to_vec(),
                (None, Some(o)) => o.translator.clone(),
                (None, None) => Vec::new(),
            },
        };
        if entry.msgstr.is_empty() {
            stats.new += 1;
        } else {
            stats.carried += 1;
        }
        merged.push(MergedEntry {
            po: entry,
            obsolete: false,
        });
    }
    stats.retargeted = fills.len();
    for (to, fill) in &fills {
        stats.retarget_items.push(Retarget {
            from: (fill.source.0.to_string(), fill.source.1.to_string()),
            to: (to.0.to_string(), to.1.to_string()),
        });
    }
    stats.retarget_items.sort_by(|a, b| a.from.cmp(&b.from));

    // 6. Хвост: переводы, чьих ключей нет в POT (и которых не спас ретаргет).
    for key in &vanished {
        let old = po_map[key];
        if old.msgstr.is_empty() {
            continue;
        }
        if old.flags.iter().any(|f| f == "legacy") {
            // Уже мигрированные триаж-переводы: их нет в POT по замыслу.
            merged.push(MergedEntry {
                po: old.clone(),
                obsolete: false,
            });
            continue;
        }
        if pot_by_text.contains_key(old.msgid.as_str()) {
            if !fill_sources.contains(key) {
                // Текст жив под уже переведённым контекстом — варианту некуда деться.
                let mut alive: Vec<String> = pot_by_text[old.msgid.as_str()]
                    .iter()
                    .map(|&i| pot_entries[i].msgctxt.clone())
                    .collect();
                alive.sort();
                stats.dropped += 1;
                stats.dropped_items.push(DroppedTranslation {
                    key: (key.0.to_string(), key.1.to_string()),
                    msgstr: old.msgstr.clone(),
                    reason: DropReason::AlreadyTranslated,
                    alive,
                });
            }
            continue;
        }
        let mut keep = old.clone();
        if !keep.flags.iter().any(|f| f == "legacy") {
            keep.flags.push("legacy".to_string());
            keep.translator
                .push("legacy: text vanished from POT, kept for runtime lookup".to_string());
        }
        merged.push(MergedEntry {
            po: keep,
            obsolete: false,
        });
        stats.legacy_kept += 1;
    }

    stats.dropped_items.sort_by(|a, b| a.key.cmp(&b.key));

    // 7. Сироты = записи выхода, чьего ключа нет в POT (видимы поимённо).
    for m in &merged {
        let key = key_ref(&m.po);
        if !pot_key_ids.contains(&key) {
            stats.orphans += 1;
            stats.orphan_items.push(Orphan {
                key: (key.0.to_string(), key.1.to_string()),
                msgstr: m.po.msgstr.clone(),
            });
        }
    }

    MergeOutcome { merged, stats }
}

/// Отрендерить слияние: записи с `obsolete` — закомментированные блоки `#~`
/// (стиль gettext). `parse_po` такие строки при повторном чтении пропускает —
/// это документированное ограничение оригинала: архив читаем глазами.
pub fn render_merged(entries: &[MergedEntry], header: &[String]) -> String {
    // Один буфер вместо `format!` на каждую из ~200 тыс. строк: рендер — треть
    // времени инструмента (25 мс из 80 на `ru.po`), и это чистые аллокации.
    let mut out = String::with_capacity(header.len() * 32 + entries.len() * 180);
    for line in header {
        out.push_str(line);
        out.push('\n');
    }
    out.push('\n');
    for e in entries {
        let prefix = if e.obsolete { "#~ " } else { "" };
        for r in &e.po.refs {
            out.push_str(prefix);
            out.push_str("#: ");
            out.push_str(r);
            out.push('\n');
        }
        for c in &e.po.comments {
            out.push_str(prefix);
            out.push_str("#. ");
            out.push_str(c);
            out.push('\n');
        }
        for t in &e.po.translator {
            // TS: `${prefix}# ${t}`.replace(/\s+$/, "") — режем хвостовые пробелы
            // у ВСЕЙ строки (пустой комментарий = голая `#`).
            let line = format!("{prefix}# {t}");
            out.push_str(line.trim_end_matches(js_ws));
            out.push('\n');
        }
        let flags: Vec<&str> =
            e.po.flags
                .iter()
                .map(String::as_str)
                .filter(|f| !f.is_empty())
                .collect();
        if !flags.is_empty() {
            out.push_str(prefix);
            out.push_str("#, ");
            out.push_str(&flags.join(", "));
            out.push('\n');
        }
        if !e.po.msgctxt.is_empty() {
            out.push_str(prefix);
            out.push_str("msgctxt \"");
            out.push_str(&escape_po(&e.po.msgctxt));
            out.push_str("\"\n");
        }
        out.push_str(prefix);
        out.push_str("msgid \"");
        out.push_str(&escape_po(&e.po.msgid));
        out.push_str("\"\n");
        out.push_str(prefix);
        out.push_str("msgstr \"");
        out.push_str(&escape_po(&e.po.msgstr));
        out.push_str("\"\n");
        out.push('\n');
    }
    while out.ends_with('\n') {
        out.pop();
    }
    out.push('\n');
    out
}

/// Заголовок = ПЕРВЫЙ блок файла до первой пустой строки, без пустых строк.
///
/// `\r\n`/`\r` нормализуются в `\n`: Python читает текст в universal-newline
/// режиме, иначе в шапку попал бы `\r` (в репозиторных `po/*.po` EOL = CRLF).
pub fn extract_header(raw_text: &str) -> Vec<String> {
    let universal = raw_text.replace("\r\n", "\n").replace('\r', "\n");
    universal
        .split("\n\n")
        .next()
        .unwrap_or("")
        .split('\n')
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

#[derive(Debug, Clone)]
pub struct PoUpdateOptions {
    pub lang: String,
    /// Каталог с `template.pot` и `<lang>.po` (по умолчанию `<root>/po`).
    pub po_dir: PathBuf,
    pub dup_rule: DupRule,
    /// Писать `<lang>.po.bak` перед перезаписью (по умолчанию да, как в TS).
    pub backup: bool,
}

impl PoUpdateOptions {
    pub fn new(root: &Path) -> Self {
        Self {
            lang: "ru".to_string(),
            po_dir: root.join("po"),
            dup_rule: DupRule::default(),
            backup: true,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PoUpdateResult {
    pub po_path: PathBuf,
    pub backup_path: Option<PathBuf>,
    pub stats: MergeStats,
}

/// Ядро: прочитать POT/PO, слить, записать PO (+ бэкап). Метаданные не нужны.
pub fn run_po_update(options: &PoUpdateOptions) -> Result<PoUpdateResult, String> {
    let pot_path = options.po_dir.join("template.pot");
    let pot_raw = std::fs::read_to_string(&pot_path)
        .map_err(|_| format!("{} missing (run potgen first)", pot_path.display()))?;
    let po_path = options.po_dir.join(format!("{}.po", options.lang));
    let po_raw = std::fs::read_to_string(&po_path).map_err(|_| {
        format!(
            "{} missing (seed it from template.pot first)",
            po_path.display()
        )
    })?;

    let header = extract_header(&po_raw);
    let pot: Vec<PoEntry> = parse_po(&pot_raw)
        .into_iter()
        .filter(|e| !e.msgid.is_empty())
        .collect();
    let old: Vec<PoEntry> = parse_po(&po_raw)
        .into_iter()
        .filter(|e| !e.msgid.is_empty())
        .collect();
    let outcome = merge_pot(&old, &pot, options.dup_rule);

    let backup_path = if options.backup {
        let path = PathBuf::from(format!("{}.bak", po_path.display()));
        std::fs::copy(&po_path, &path).map_err(|e| format!("{}: {e}", path.display()))?;
        Some(path)
    } else {
        None
    };
    write_atomic(&po_path, &render_merged(&outcome.merged, &header))?;

    Ok(PoUpdateResult {
        po_path,
        backup_path,
        stats: outcome.stats,
    })
}

/// Атомарная запись (`.part` → rename): обрыв не обнулит существующий PO.
pub fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let part = PathBuf::from(format!("{}.part", path.display()));
    if let Err(err) = std::fs::write(&part, text) {
        let _ = std::fs::remove_file(&part);
        return Err(format!("{}: {err}", part.display()));
    }
    if let Err(err) = std::fs::rename(&part, path) {
        let _ = std::fs::remove_file(&part);
        return Err(format!("{}: {err}", path.display()));
    }
    Ok(())
}

/// Отчёт по слиянию в JSON (полные списки, не «первые 10») — для аудита данных:
/// именно этот файл делает 1 321 сироту поимённо видимой.
pub fn report_to_json(stats: &MergeStats) -> String {
    fn key_json(key: &PoKey) -> String {
        format!("[{}, {}]", quoted(&key.0), quoted(&key.1))
    }
    let mut out = String::new();
    out.push('{');
    out.push_str(&format!("\"carried\": {}", stats.carried));
    out.push_str(&format!(", \"new\": {}", stats.new));
    out.push_str(&format!(", \"obsolete\": {}", stats.obsolete));
    out.push_str(&format!(", \"retargeted\": {}", stats.retargeted));
    out.push_str(&format!(", \"legacyKept\": {}", stats.legacy_kept));
    out.push_str(&format!(", \"dropped\": {}", stats.dropped));
    out.push_str(&format!(", \"orphans\": {}", stats.orphans));
    out.push_str(&format!(", \"dupKeys\": {}", stats.dup_keys));

    out.push_str(", \"retargets\": [");
    for (i, r) in stats.retarget_items.iter().enumerate() {
        if i > 0 {
            out.push_str(", ");
        }
        out.push_str(&format!(
            "{{\"from\": {}, \"to\": {}}}",
            key_json(&r.from),
            key_json(&r.to)
        ));
    }
    out.push(']');

    out.push_str(", \"droppedItems\": [");
    for (i, d) in stats.dropped_items.iter().enumerate() {
        if i > 0 {
            out.push_str(", ");
        }
        out.push_str(&format!(
            "{{\"key\": {}, \"msgstr\": {}, \"reason\": {}, \"alive\": [{}]}}",
            key_json(&d.key),
            quoted(&d.msgstr),
            quoted(d.reason.as_str()),
            d.alive
                .iter()
                .map(|c| quoted(c))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    out.push(']');

    out.push_str(", \"orphanItems\": [");
    for (i, o) in stats.orphan_items.iter().enumerate() {
        if i > 0 {
            out.push_str(", ");
        }
        out.push_str(&format!(
            "{{\"key\": {}, \"msgstr\": {}}}",
            key_json(&o.key),
            quoted(&o.msgstr)
        ));
    }
    out.push_str("]}");
    out.push('\n');
    out
}
