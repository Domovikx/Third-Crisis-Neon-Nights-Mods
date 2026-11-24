//! assemble.rs — сборка дампа из rd1: семантика, которая раньше жила в TS.
//!
//! Порт `dumpAssetsFromRaw` (`dump_assets.mts`) + `extract.mts`: какие поля
//! объекта попадут в JSONL, в каком порядке, что отсекается фильтрами и как
//! считается `summaries.jsonl`. Выход обязан совпадать с TS-эталоном
//! ПОБАЙТОВО — это и есть проверка смысла (`docs/rust-vs-ts.md`).
//!
//! Формат вывода — Python `json.dumps` (разделители `", "`/`": "`, плавающие
//! как `repr`), см. `dumpjson.rs`.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

use crate::dumpjson::{render, J};
use crate::inventory::py_strip;
use crate::rd1read::{parse_line, ObjRecord, Record};
use crate::text_filters::{is_known_non_speaker, is_skip_prefix, strip_rich};
use crate::typetree::{parse_type_tree, read_object, Endian, TypeTreeNode};
use crate::value::Val;

/// Лимит длины одного значения в `strings` (code points).
const MAX_STRING_LEN: usize = 500;
/// Лимит `global_strings` на ассет по умолчанию (как `GLOBAL_STRING_LIMIT`).
pub const GLOBAL_STRING_LIMIT: usize = 500;

/// Поля обёрток UnityPy, которые эталон пропускает (`SKIP_ATTRS`).
const SKIP_ATTRS: [&str; 11] = [
    "assets_file",
    "object_reader",
    "container",
    "files",
    "objects",
    "resources",
    "m_GameObject",
    "m_Script",
    "m_Mesh",
    "m_Material",
    "m_Texture",
];

/// Ограничения прогона (как `DumpOptions`: всё `None` = без лимита, кроме
/// `global_strings`, где по умолчанию 500).
#[derive(Clone, Debug)]
pub struct AssembleOptions {
    pub raw_string_limit: Option<usize>,
    pub global_string_limit: Option<usize>,
    pub dotnet_ui_limit: Option<usize>,
}

impl Default for AssembleOptions {
    fn default() -> Self {
        AssembleOptions {
            raw_string_limit: None,
            global_string_limit: Some(GLOBAL_STRING_LIMIT),
            dotnet_ui_limit: None,
        }
    }
}

/// Счётчик обрезки (как `TruncationBucket`).
#[derive(Clone, Debug, Default)]
pub struct Bucket {
    pub units: usize,
    pub dropped: usize,
    pub limit: Option<usize>,
}

/// Статистика прогона.
#[derive(Clone, Debug, Default)]
pub struct Stats {
    pub assets: usize,
    pub objects: usize,
    pub failed: usize,
    pub raw_strings: Bucket,
    pub global_strings: Bucket,
    pub dotnet_ui: Bucket,
    pub string_length_units: usize,
    pub string_length_dropped: usize,
}

/// Имя класса Unity по ClassID (только встречающиеся в игре; иначе `ClassID<id>`).
pub fn unity_class_name(class_id: i32) -> String {
    let name = match class_id {
        1 => "GameObject",
        4 => "Transform",
        20 => "Camera",
        21 => "Material",
        23 => "MeshRenderer",
        28 => "Texture2D",
        33 => "MeshFilter",
        43 => "Mesh",
        48 => "Shader",
        49 => "TextAsset",
        54 => "Rigidbody",
        64 => "MeshCollider",
        65 => "BoxCollider",
        72 => "ComputeShader",
        74 => "AnimationClip",
        81 => "AudioListener",
        82 => "AudioSource",
        83 => "AudioClip",
        84 => "RenderTexture",
        86 => "CustomRenderTexture",
        91 => "AnimatorController",
        95 => "Animator",
        104 => "RenderSettings",
        114 => "MonoBehaviour",
        115 => "MonoScript",
        120 => "LineRenderer",
        124 => "FlareLayer",
        128 => "Font",
        134 => "PhysicMaterial",
        135 => "SphereCollider",
        136 => "CapsuleCollider",
        137 => "SkinnedMeshRenderer",
        142 => "AssetBundle",
        143 => "CharacterController",
        150 => "PreloadData",
        157 => "LightmapSettings",
        164 => "AudioReverbFilter",
        165 => "AudioHighPassFilter",
        167 => "AudioReverbZone",
        169 => "AudioLowPassFilter",
        196 => "NavMeshSettings",
        198 => "ParticleSystem",
        199 => "ParticleSystemRenderer",
        200 => "ShaderVariantCollection",
        212 => "SpriteRenderer",
        213 => "Sprite",
        221 => "AnimatorOverrideController",
        222 => "CanvasRenderer",
        223 => "Canvas",
        224 => "RectTransform",
        225 => "CanvasGroup",
        241 => "AudioMixerController",
        243 => "AudioMixerGroupController",
        245 => "AudioMixerSnapshotController",
        320 => "PlayableDirector",
        328 => "VideoPlayer",
        329 => "VideoClip",
        331 => "SpriteMask",
        73398921 => "VFXRenderer",
        687078895 => "SpriteAtlas",
        850595691 => "LightingSettings",
        1971053207 => "SpriteShapeRenderer",
        2058629509 => "VisualEffectAsset",
        2083052967 => "VisualEffect",
        other => return format!("ClassID{other}"),
    };
    name.to_string()
}

// ---------------------------------------------------------------------------
// Py-помощники
// ---------------------------------------------------------------------------

/// Длина в code points (как `cpLen`).
fn cp_len(s: &str) -> usize {
    s.chars().count()
}

/// Срез `s[:n]` по code points (как `pySlice`).
fn py_slice(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}

fn py_is_upper_char(c: char) -> bool {
    c.is_uppercase()
}

fn py_is_lower_char(c: char) -> bool {
    c.is_lowercase()
}

fn py_is_alpha(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_alphabetic())
}

/// Как `pyIsUpper`: есть заглавная и нет строчных.
fn py_is_upper(s: &str) -> bool {
    let mut has_upper = false;
    for c in s.chars() {
        if py_is_lower_char(c) {
            return false;
        }
        if py_is_upper_char(c) {
            has_upper = true;
        }
    }
    has_upper
}

/// Число ASCII-букв (как `asciiLetters`).
fn ascii_letters(s: &str) -> usize {
    s.bytes().filter(|b| b.is_ascii_alphabetic()).count()
}

fn is_truthy(v: &Val) -> bool {
    match v {
        Val::Null => false,
        Val::Bool(b) => *b,
        Val::I64(v) => *v != 0,
        Val::U64(v) => *v != 0,
        Val::F64(v) => *v != 0.0,
        Val::Str(s) => !s.is_empty(),
        Val::Arr(items) => !items.is_empty(),
        Val::Obj(items) => !items.is_empty(),
    }
}

// ---------------------------------------------------------------------------
// Типизированные поля объекта
// ---------------------------------------------------------------------------

/// PPtr-структура: ровно два ключа `m_FileID`/`m_PathID`.
fn pptr_parts(v: &Val) -> Option<(&Val, &Val)> {
    let Val::Obj(pairs) = v else {
        return None;
    };
    if pairs.len() != 2 {
        return None;
    }
    let mut file_id = None;
    let mut path_id = None;
    for (k, value) in pairs {
        match k.as_str() {
            "m_FileID" => file_id = Some(value),
            "m_PathID" => path_id = Some(value),
            _ => return None,
        }
    }
    Some((file_id?, path_id?))
}

/// Число как JS `number` (целое — без `.0`, дробное — `repr`).
fn js_number(v: &Val) -> J {
    match v {
        Val::I64(x) => J::I(*x),
        Val::U64(x) => J::U(*x),
        Val::F64(x) if x.fract() == 0.0 && x.abs() < 9e15 => J::I(*x as i64),
        Val::F64(x) => J::F(*x),
        Val::Bool(b) => J::I(if *b { 1 } else { 0 }),
        Val::Str(s) => J::Bare(s.clone()),
        _ => J::I(0),
    }
}

/// `path_id` PPtr: bigint в эталоне, печатается без кавычек.
fn js_bigint(v: &Val) -> J {
    match v {
        Val::I64(x) => J::I(*x),
        Val::U64(x) => J::U(*x),
        Val::F64(x) => J::I(x.trunc() as i64),
        Val::Bool(b) => J::I(if *b { 1 } else { 0 }),
        Val::Str(s) => J::Bare(s.clone()),
        _ => J::I(0),
    }
}

fn pptr_to_json(v: &Val) -> J {
    match pptr_parts(v) {
        Some((file_id, path_id)) => J::obj(vec![
            ("file_id", js_number(file_id)),
            ("path_id", js_bigint(path_id)),
        ]),
        None => J::Null,
    }
}

/// Значение `Val` → JSON (для элементов массивов в `fields`).
fn val_to_j(v: &Val) -> J {
    match v {
        Val::Null => J::Null,
        Val::Bool(b) => J::Bool(*b),
        Val::I64(x) => J::I(*x),
        Val::U64(x) => J::U(*x),
        Val::F64(x) => J::F(*x),
        Val::Str(s) => J::s(s.clone()),
        Val::Arr(items) => J::Arr(items.iter().map(val_to_j).collect()),
        Val::Obj(pairs) => J::Obj(
            pairs
                .iter()
                .map(|(k, v)| (k.clone(), val_to_j(v)))
                .collect(),
        ),
    }
}

/// Порт `_serialize_list`: массив попадает в `fields`, если эталон его пишет.
fn serialize_list(items: &[Val]) -> Option<J> {
    if items.is_empty() {
        return Some(J::Arr(Vec::new()));
    }
    match &items[0] {
        Val::Str(_) | Val::Bool(_) | Val::I64(_) | Val::U64(_) | Val::F64(_) => {
            Some(J::Arr(items.iter().map(val_to_j).collect()))
        }
        Val::Obj(_) if pptr_parts(&items[0]).is_some() => Some(J::Arr(
            items
                .iter()
                .map(|item| {
                    if pptr_parts(item).is_some() {
                        pptr_to_json(item)
                    } else {
                        val_to_j(item)
                    }
                })
                .collect(),
        )),
        _ => None,
    }
}

/// Разложить типизированный объект на `strings`/`fields` (+ признак FSM).
pub fn collect_typed_fields(
    typed: &[(String, Val)],
) -> (Vec<(String, J)>, Vec<(String, J)>, bool, usize) {
    // Сортировка ссылок вместо «sort ключей + find по каждому»: у объектов
    // бывает до сотни полей, и O(n²) на 578 474 объектах заметен.
    let mut items: Vec<&(String, Val)> = typed.iter().collect();
    items.sort_by(|a, b| a.0.cmp(&b.0));

    let mut strings: Vec<(String, J)> = Vec::new();
    let mut fields: Vec<(String, J)> = Vec::new();
    let mut cut_values = 0usize;

    for (key, value) in items {
        if key.starts_with('_') || SKIP_ATTRS.contains(&key.as_str()) {
            continue;
        }
        match value {
            Val::Str(text) => {
                if text.is_empty() {
                    continue;
                }
                if cp_len(text) > MAX_STRING_LEN {
                    cut_values += 1;
                }
                strings.push((key.clone(), J::s(py_slice(text, MAX_STRING_LEN))));
            }
            Val::Obj(_) if pptr_parts(value).is_some() => {
                fields.push((key.clone(), pptr_to_json(value)));
            }
            Val::Arr(items) => {
                if let Some(list) = serialize_list(items) {
                    fields.push((key.clone(), list));
                }
            }
            Val::I64(_) | Val::U64(_) | Val::F64(_) | Val::Bool(_) => {
                fields.push((key.clone(), val_to_j(value)));
            }
            _ => {}
        }
    }

    let is_fsm = typed.iter().any(|(k, _)| k == "fsm");
    (strings, fields, is_fsm, cut_values)
}

/// Строка-идентификатор с slash-путём (`expressions/idle`), не текст.
fn has_slash_path(s: &str) -> bool {
    let chars: Vec<char> = s.chars().collect();
    for i in 0..chars.len().saturating_sub(2) {
        let is_word = |c: char| c.is_alphanumeric() || c == '_';
        if is_word(chars[i]) && chars[i + 1] == '/' && is_word(chars[i + 2]) {
            return true;
        }
    }
    false
}

/// Видимые UI-строки PlayMaker FSM (порт `parseFsmStrings`).
pub fn parse_fsm_strings(typed: &[(String, Val)]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    fn add(raw: &str, out: &mut Vec<String>, seen: &mut HashSet<String>) {
        let s = py_strip(raw);
        if cp_len(s) < 2 || seen.contains(s) {
            return;
        }
        if has_slash_path(s) {
            return;
        }
        if s.starts_with("line_") {
            return;
        }
        seen.insert(s.to_string());
        out.push(s.to_string());
    }

    fn walk(value: &Val, out: &mut Vec<String>, seen: &mut HashSet<String>) {
        match value {
            Val::Arr(items) => {
                for item in items {
                    walk(item, out, seen);
                }
            }
            Val::Obj(pairs) => {
                let has_use_var = pairs
                    .iter()
                    .any(|(k, v)| k == "useVariable" && is_truthy(v));
                if let Some((_, Val::Str(text))) = pairs.iter().find(|(k, _)| k == "value") {
                    if !has_use_var {
                        add(text, out, seen);
                    }
                }
                if let Some((_, Val::Arr(params))) = pairs.iter().find(|(k, _)| k == "stringParams")
                {
                    for param in params {
                        if let Val::Str(text) = param {
                            add(text, out, seen);
                        }
                    }
                }
                for (_, child) in pairs {
                    walk(child, out, seen);
                }
            }
            _ => {}
        }
    }

    for (_, value) in typed {
        walk(value, &mut out, &mut seen);
    }
    out
}

// ---------------------------------------------------------------------------
// PlayMaker-диалоги из raw-строк
// ---------------------------------------------------------------------------

/// Порт `parsePlaymakerDialogues`: пары `line_X` + текст + спикер.
pub fn parse_playmaker_dialogues(raw_strings: &[String]) -> Vec<J> {
    let mut results: Vec<J> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut i = 0usize;
    while i < raw_strings.len() {
        let s = py_strip(&raw_strings[i]);
        if !s.starts_with("line_") {
            i += 1;
            continue;
        }
        i += 1;
        if i < raw_strings.len() && py_strip(&raw_strings[i]) == s {
            i += 1;
        }

        let mut text = "";
        while i < raw_strings.len() {
            let ns = py_strip(&raw_strings[i]);
            if is_skip_prefix(ns) || ns.is_empty() {
                i += 1;
                continue;
            }
            if cp_len(ns) <= 3 || !ns.contains(' ') {
                i += 1;
                continue;
            }
            if ns.starts_with('{') || ns.starts_with('[') {
                i += 1;
                continue;
            }
            text = ns;
            i += 1;
            break;
        }
        if text.is_empty() {
            continue;
        }

        let clean = strip_rich(text);
        let rich_text = if text != clean {
            text.to_string()
        } else {
            String::new()
        };

        let mut speaker = "";
        if i < raw_strings.len() {
            let ns = py_strip(&raw_strings[i]);
            let first = ns.chars().next();
            if !ns.is_empty()
                && !is_skip_prefix(ns)
                && !ns.starts_with("line_")
                && !ns.contains(' ')
                && first.is_some_and(py_is_upper_char)
                && py_is_alpha(ns)
                && !is_known_non_speaker(ns)
            {
                speaker = ns;
                i += 1;
            }
        }

        let key = format!("{speaker}|{clean}");
        if !clean.is_empty() && !seen.contains(&key) {
            seen.insert(key);
            results.push(J::obj(vec![
                ("speaker", J::s(speaker)),
                ("text", J::s(clean)),
                ("rich_text", J::s(rich_text)),
            ]));
        }
    }
    results
}

// ---------------------------------------------------------------------------
// global_strings
// ---------------------------------------------------------------------------

/// Порт `isGlobalStringCandidate`.
pub fn is_global_string_candidate(s: &str) -> bool {
    if ascii_letters(s) < 3 {
        return false;
    }
    let forbidden = [
        '#', '$', '%', '@', '&', '*', '{', '}', '(', ')', '<', '>', '|', '^', '~', '`', '=',
    ];
    if s.chars().any(|c| forbidden.contains(&c)) || s.contains('[') || s.contains(']') {
        return false;
    }
    let chars: Vec<char> = s.chars().collect();
    let second = chars.get(1).copied().unwrap_or(' ');
    if s.starts_with('_') && py_is_alpha(&second.to_string()) && py_is_upper_char(second) {
        return false;
    }
    if s.contains('/') && !s.starts_with("http") {
        return false;
    }
    if chars
        .iter()
        .all(|c| py_is_upper_char(*c) || c.is_ascii_digit() || *c == ' ')
    {
        let upper = s.to_uppercase();
        if cp_len(s) >= 3 && !"AEIOUY ".chars().any(|c| upper.contains(c)) {
            return false;
        }
    }
    if s.contains(' ') && !s.chars().any(|c| "/\\.()[]".contains(c)) {
        return true;
    }
    if py_is_upper(s) {
        return "AEIOU".chars().any(|v| s.contains(v));
    }
    if py_is_upper_char(chars[0]) && chars[1..].iter().any(|c| py_is_lower_char(*c)) {
        return ascii_letters(s) >= 4;
    }
    ascii_letters(s) >= 6
}

/// Порт `uiPriority`.
pub fn ui_priority(s: &str) -> i32 {
    if s.contains(' ') {
        if s.contains('/') || s.contains('\\') {
            return -10;
        }
        return 100;
    }
    if py_is_upper(s) {
        let has_vowel = "AEIOU".chars().any(|v| s.contains(v));
        let has_underscore = s.contains('_');
        if has_vowel && !has_underscore && (2..=20).contains(&cp_len(s)) {
            return 80;
        }
    }
    let chars: Vec<char> = s.chars().collect();
    if chars.first().is_some_and(|c| py_is_upper_char(*c))
        && chars[1..].iter().any(|c| py_is_lower_char(*c))
    {
        return 50;
    }
    if s.starts_with('_') {
        return -50;
    }
    if chars.first().is_some_and(|c| py_is_lower_char(*c))
        && chars[1..].iter().any(|c| py_is_upper_char(*c))
    {
        return 20;
    }
    0
}

/// Обрезка списка с учётом счётчика (как `capList`).
fn cap_list(items: Vec<J>, limit: Option<usize>, bucket: &mut Bucket) -> Vec<J> {
    bucket.limit = limit;
    match limit {
        None => items,
        Some(limit) if items.len() <= limit => items,
        Some(limit) => {
            bucket.units += 1;
            bucket.dropped += items.len() - limit;
            items.into_iter().take(limit).collect()
        }
    }
}

/// Порт `selectGlobalStrings`.
pub fn select_global_strings(
    texts: &[String],
    limit: Option<usize>,
    bucket: &mut Bucket,
) -> Vec<String> {
    let mut candidates: Vec<(String, usize, i32)> = Vec::new();
    for (index, raw) in texts.iter().enumerate() {
        let text = py_strip(raw);
        let length = cp_len(text);
        if (3..=120).contains(&length) && is_global_string_candidate(text) {
            candidates.push((text.to_string(), index, ui_priority(text)));
        }
    }
    candidates.sort_by(|a, b| b.2.cmp(&a.2).then(a.1.cmp(&b.1)));
    let ordered: Vec<String> = candidates.into_iter().map(|(text, _, _)| text).collect();
    let items: Vec<J> = ordered.into_iter().map(J::S).collect();
    cap_list(items, limit, bucket)
        .into_iter()
        .filter_map(|j| match j {
            J::S(s) => Some(s),
            _ => None,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Сборка файлов
// ---------------------------------------------------------------------------

/// Состояние одного SerializedFile внутри ассета (endian + разобранные деревья).
struct FileState {
    endian: Endian,
    trees: HashMap<usize, Option<TypeTreeNode>>,
}

/// Контекст ассета между записями rd1.
struct Ctx {
    asset: String,
    kind: String,
    error: Option<String>,
    files: Vec<FileState>,
    class_names: Vec<String>,
    settings: Option<Vec<(String, String)>>,
    runs: Vec<String>,
    dotnet_settings: Option<Vec<(String, String)>>,
    writer: Option<BufWriter<File>>,
    objects: usize,
}

impl Ctx {
    fn new(asset: String, kind: String, writer: Option<BufWriter<File>>) -> Self {
        Ctx {
            asset,
            kind,
            error: None,
            files: Vec::new(),
            class_names: Vec::new(),
            settings: None,
            runs: Vec::new(),
            dotnet_settings: None,
            writer,
            objects: 0,
        }
    }
}

/// Собрать дамп из rd1 в `out_dir`.
///
/// `parse_only` — режим замера: читать и разбирать rd1, ничего не собирая
/// (нужен, чтобы отделить стоимость парсера от сборки при профилировании).
pub fn assemble(
    raw_path: &Path,
    out_dir: &Path,
    options: &AssembleOptions,
    parse_only: bool,
) -> Result<Stats, String> {
    std::fs::create_dir_all(out_dir).map_err(|e| format!("{}: {e}", out_dir.display()))?;
    let summaries_path = out_dir.join("summaries.jsonl");
    let mut summaries = BufWriter::new(
        File::create(&summaries_path).map_err(|e| format!("{}: {e}", summaries_path.display()))?,
    );

    let mut stats = Stats::default();
    let mut index: Vec<(String, usize)> = Vec::new();
    let mut ctx: Option<Ctx> = None;

    let file = File::open(raw_path).map_err(|e| format!("{}: {e}", raw_path.display()))?;
    let mut reader = std::io::BufReader::with_capacity(1 << 20, file);
    let mut line: Vec<u8> = Vec::with_capacity(4096);

    loop {
        line.clear();
        let read = std::io::BufRead::read_until(&mut reader, b'\n', &mut line)
            .map_err(|e| format!("rd1: {e}"))?;
        if read == 0 {
            break;
        }
        let body = if line.last() == Some(&b'\n') {
            &line[..line.len() - 1]
        } else {
            &line[..]
        };
        if body.is_empty() {
            continue;
        }
        let Some(record) = parse_line(body) else {
            return Err(format!("rd1: не разобрана строка ({} байт)", body.len()));
        };

        if parse_only {
            std::hint::black_box(&record);
            continue;
        }
        match record {
            Record::Asset { asset, kind, error } => {
                finalize(&mut ctx, &mut summaries, &mut stats, &mut index, options);
                let writer = if kind == "dotnet" || kind == "raw" {
                    None
                } else {
                    let path = out_dir.join(format!("{asset}.jsonl"));
                    Some(BufWriter::with_capacity(
                        1 << 20,
                        File::create(&path).map_err(|e| format!("{}: {e}", path.display()))?,
                    ))
                };
                let mut next = Ctx::new(asset, kind, writer);
                next.error = error;
                ctx = Some(next);
            }
            Record::Sf {
                i,
                endian_be,
                type_tree_enabled: _,
                object_count: _,
            } => {
                if let Some(ctx) = ctx.as_mut() {
                    while ctx.files.len() <= i {
                        ctx.files.push(FileState {
                            endian: Endian::Le,
                            trees: HashMap::new(),
                        });
                    }
                    ctx.files[i].endian = if endian_be { Endian::Be } else { Endian::Le };
                }
            }
            Record::Type {
                sf,
                type_id,
                class_id: _,
                node_count,
                string_size: _,
                blob,
            } => {
                if let Some(ctx) = ctx.as_mut() {
                    if let Some(file) = ctx.files.get_mut(sf) {
                        let tree = parse_type_tree(&blob, node_count, file.endian);
                        file.trees.insert(type_id, tree);
                    }
                }
            }
            Record::Obj(obj) => {
                let Some(ctx) = ctx.as_mut() else {
                    continue;
                };
                let Some(writer) = ctx.writer.as_mut() else {
                    continue;
                };
                let Some(file) = ctx.files.get(obj.sf) else {
                    continue;
                };
                let tree = file.trees.get(&obj.type_id).and_then(|t| t.as_ref());
                let row = build_row(&ctx.asset, &obj, tree, file.endian, options, &mut stats);
                let text = render(&row);
                writer
                    .write_all(text.as_bytes())
                    .and_then(|_| writer.write_all(b"\n"))
                    .map_err(|e| format!("запись {}: {e}", ctx.asset))?;
                ctx.class_names.push(unity_class_name(obj.class_id));
                ctx.objects += 1;
            }
            Record::Warn(_) => {}
            Record::Runs(texts) => {
                if let Some(ctx) = ctx.as_mut() {
                    ctx.runs = texts;
                }
            }
            Record::Keys(keys) => {
                if let Some(ctx) = ctx.as_mut() {
                    ctx.settings = Some(keys);
                }
            }
            Record::Us(heap) => {
                if let Some(ctx) = ctx.as_mut() {
                    let (entries, dropped) = crate::dotnet_scan::scan_dotnet_strings(
                        &heap,
                        Some((0, heap.len())),
                        options.dotnet_ui_limit,
                    );
                    stats.dotnet_ui.dropped += dropped;
                    ctx.dotnet_settings = Some(
                        entries
                            .into_iter()
                            .map(|entry| (entry.key, entry.display))
                            .collect(),
                    );
                }
            }
        }
    }

    finalize(&mut ctx, &mut summaries, &mut stats, &mut index, options);
    summaries.flush().map_err(|e| format!("summaries: {e}"))?;

    // index.md — как в TS: по алфавиту.
    let mut index_sorted = index.clone();
    index_sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let mut md =
        String::from("# Asset Dump Index (Unity)\n\n| File | Objects |\n|------|---------|\n");
    for (name, total) in index_sorted {
        md.push_str(&format!("| [{name}]({name}.jsonl) | {total} |\n"));
    }
    let index_path = out_dir.join("index.md");
    std::fs::write(&index_path, md).map_err(|e| format!("{}: {e}", index_path.display()))?;

    Ok(stats)
}

/// Собрать строку объекта (порт `extractObject` + обёртка `asset`).
fn build_row(
    asset: &str,
    obj: &ObjRecord,
    tree: Option<&TypeTreeNode>,
    endian: Endian,
    options: &AssembleOptions,
    stats: &mut Stats,
) -> J {
    let all_texts = &obj.rs;
    let typed = tree.and_then(|tree| {
        let raw = obj.raw.as_deref().unwrap_or(&[]);
        read_object(tree, raw, endian)
    });

    let mut pairs: Vec<(&str, J)> = vec![
        ("asset", J::s(asset)),
        ("path_id", parse_path_id(&obj.path_id)),
        ("type", J::s(unity_class_name(obj.class_id))),
    ];

    let mut is_fsm = false;
    match &typed {
        None => {
            let has_marker = all_texts.iter().any(|t| t == "ColorParserList");
            if has_marker {
                if let Some(colors) = &obj.cpl {
                    pairs.push(("color_parser_list", map_to_j(colors)));
                } else {
                    pairs.push(("error", J::s("read_failed")));
                }
            } else {
                pairs.push(("error", J::s("read_failed")));
            }
        }
        Some(typed) => {
            let (strings, fields, fsm, cut_values) = collect_typed_fields(typed);
            if !strings.is_empty() {
                pairs.push(("strings", J::Obj(strings)));
            }
            if !fields.is_empty() {
                pairs.push(("fields", J::Obj(fields)));
            }
            if cut_values > 0 {
                stats.string_length_units += 1;
                stats.string_length_dropped += cut_values;
            }
            is_fsm = fsm;
        }
    }

    // Диалоги: сырые (с offset) + PlayMaker-пары из тех же raw-строк.
    let mut dialogues: Vec<J> = obj
        .dl
        .iter()
        .map(|d| {
            J::obj(vec![
                ("offset", J::I(d.offset)),
                ("speaker", J::s(d.speaker.clone())),
                ("text", J::s(d.text.clone())),
                ("rich_text", J::s(d.rich_text.clone())),
            ])
        })
        .collect();
    dialogues.extend(parse_playmaker_dialogues(all_texts));
    if !dialogues.is_empty() {
        pairs.push(("dialogues", J::Arr(dialogues)));
    }

    if is_fsm {
        if let Some(typed) = &typed {
            let fsm_strings = parse_fsm_strings(typed);
            if !fsm_strings.is_empty() {
                pairs.push((
                    "fsm_strings",
                    J::Arr(fsm_strings.into_iter().map(J::S).collect()),
                ));
            }
        }
    }

    if !all_texts.is_empty() {
        let items: Vec<J> = all_texts.iter().map(|t| J::S(t.clone())).collect();
        let capped = cap_list(items, options.raw_string_limit, &mut stats.raw_strings);
        pairs.push(("raw_strings", J::Arr(capped)));
    }

    J::obj(pairs)
}

/// `path_id` из rd1 — десятичная строка (может выходить за `i64`).
fn parse_path_id(text: &str) -> J {
    if let Ok(v) = text.parse::<i64>() {
        return J::I(v);
    }
    if let Ok(v) = text.parse::<u64>() {
        return J::U(v);
    }
    J::Bare(text.to_string())
}

/// `{имя: значение}` — формат `color_parser_list`.
fn map_to_j(pairs: &[(String, String)]) -> J {
    J::Obj(
        pairs
            .iter()
            .map(|(k, v)| (k.clone(), J::s(v.clone())))
            .collect(),
    )
}

/// `[{key, display}, …]` — формат `settings_keys` в summaries.
fn settings_to_j(pairs: &[(String, String)]) -> J {
    J::Arr(
        pairs
            .iter()
            .map(|(k, v)| J::obj(vec![("key", J::s(k.clone())), ("display", J::s(v.clone()))]))
            .collect(),
    )
}

/// Закрыть ассет: строка `summaries.jsonl` + индекс (порт `finalize`).
fn finalize(
    ctx: &mut Option<Ctx>,
    summaries: &mut BufWriter<File>,
    stats: &mut Stats,
    index: &mut Vec<(String, usize)>,
    options: &AssembleOptions,
) {
    let Some(mut ctx) = ctx.take() else {
        return;
    };
    if let Some(writer) = ctx.writer.as_mut() {
        let _ = writer.flush();
    }
    if let Some(error) = &ctx.error {
        eprintln!("    ERROR: {}: {error}", ctx.asset);
        stats.failed += 1;
        return;
    }

    let mut pairs: Vec<(&str, J)> = vec![
        ("schema_version", J::s("3")),
        ("asset", J::s(ctx.asset.clone())),
        ("total_objects", J::I(ctx.objects as i64)),
        ("object_types", counter_most_common(&ctx.class_names)),
    ];
    if ctx.kind == "dotnet" {
        pairs.push(("format", J::s("dotnet_us_heap")));
        if let Some(settings) = &ctx.dotnet_settings {
            if !settings.is_empty() {
                pairs.push(("settings_keys", settings_to_j(settings)));
            }
        }
    } else {
        if ctx.kind == "raw" {
            pairs.push(("format", J::s("raw_binary")));
        }
        if let Some(settings) = &ctx.settings {
            if !settings.is_empty() {
                pairs.push(("settings_keys", settings_to_j(settings)));
            }
        }
        let mut found: HashSet<&str> = HashSet::new();
        for (key, display) in ctx.settings.iter().flatten() {
            found.insert(key.as_str());
            found.insert(display.as_str());
        }
        let global = select_global_strings(
            &ctx.runs,
            options.global_string_limit,
            &mut stats.global_strings,
        );
        let filtered: Vec<String> = global
            .into_iter()
            .filter(|text| !found.contains(text.as_str()))
            .collect();
        if !filtered.is_empty() {
            pairs.push((
                "global_strings",
                J::Arr(filtered.into_iter().map(J::S).collect()),
            ));
        }
    }

    let text = render(&J::obj(pairs));
    if summaries.write_all(text.as_bytes()).is_err() || summaries.write_all(b"\n").is_err() {
        eprintln!("    ERROR: не записана строка summaries для {}", ctx.asset);
    }
    index.push((ctx.asset.clone(), ctx.objects));
    stats.assets += 1;
    stats.objects += ctx.objects;
    if ctx.kind != "dotnet" && ctx.kind != "raw" {
        eprintln!("  {}: {} objects", ctx.asset, ctx.objects);
    }
}

/// Порт `counterMostCommon`: по убыванию, при равенстве — порядок появления.
fn counter_most_common(values: &[String]) -> J {
    let mut order: Vec<(String, usize)> = Vec::new();
    let mut index: HashMap<&str, usize> = HashMap::new();
    for name in values {
        if let Some(&at) = index.get(name.as_str()) {
            order[at].1 += 1;
        } else {
            index.insert(name.as_str(), order.len());
            order.push((name.clone(), 1));
        }
    }
    order.sort_by(|a, b| b.1.cmp(&a.1));
    J::Obj(
        order
            .into_iter()
            .map(|(k, v)| (k, J::I(v as i64)))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(pairs: &[(&str, Val)]) -> Val {
        Val::Obj(
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
        )
    }

    #[test]
    fn class_names_known_and_unknown() {
        assert_eq!(unity_class_name(114), "MonoBehaviour");
        assert_eq!(unity_class_name(999999), "ClassID999999");
    }

    #[test]
    fn typed_fields_skip_underscore_and_pptr() {
        let typed = vec![
            ("m_Name".to_string(), Val::Str("Hero".into())),
            ("_hidden".to_string(), Val::Str("x".into())),
            (
                "m_Script".to_string(),
                obj(&[("m_FileID", Val::I64(0)), ("m_PathID", Val::I64(5))]),
            ),
            (
                "Target".to_string(),
                obj(&[("m_FileID", Val::I64(1)), ("m_PathID", Val::U64(u64::MAX))]),
            ),
            ("Count".to_string(), Val::I64(3)),
            ("Ratio".to_string(), Val::F64(0.5)),
            (
                "Tags".to_string(),
                Val::Arr(vec![Val::Str("a".into()), Val::Str("b".into())]),
            ),
        ];
        let (strings, fields, is_fsm, cut) = collect_typed_fields(&typed);
        assert_eq!(strings, vec![("m_Name".to_string(), J::s("Hero"))]);
        assert!(!is_fsm);
        assert_eq!(cut, 0);
        let names: Vec<&str> = fields.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(names, vec!["Count", "Ratio", "Tags", "Target"]);
        assert_eq!(
            render(&fields[3].1),
            r#"{"file_id": 1, "path_id": 18446744073709551615}"#
        );
    }

    #[test]
    fn strings_value_truncated_to_500_code_points() {
        let long = "я".repeat(600);
        let typed = vec![("Note".to_string(), Val::Str(long))];
        let (strings, _, _, cut) = collect_typed_fields(&typed);
        assert_eq!(cut, 1);
        match &strings[0].1 {
            J::S(text) => assert_eq!(text.chars().count(), 500),
            other => panic!("не строка: {other:?}"),
        }
    }

    #[test]
    fn playmaker_dialogue_pairs() {
        let raw: Vec<String> = vec![
            "line_0".into(),
            "You there!".into(),
            "Guard".into(),
            "line_1".into(),
            "Move along.".into(),
        ];
        let out = parse_playmaker_dialogues(&raw);
        assert_eq!(out.len(), 2);
        assert_eq!(
            render(&out[0]),
            r#"{"speaker": "Guard", "text": "You there!", "rich_text": ""}"#
        );
        assert_eq!(
            render(&out[1]),
            r#"{"speaker": "", "text": "Move along.", "rich_text": ""}"#
        );
    }

    #[test]
    fn fsm_strings_walk_skips_ids() {
        let typed = vec![(
            "fsm".to_string(),
            obj(&[(
                "states",
                Val::Arr(vec![obj(&[
                    ("value", Val::Str("Hello there".into())),
                    ("useVariable", Val::Bool(false)),
                    (
                        "stringParams",
                        Val::Arr(vec![Val::Str("Param text".into())]),
                    ),
                    ("path", Val::Str("expressions/idle".into())),
                ])]),
            )]),
        )];
        assert_eq!(parse_fsm_strings(&typed), vec!["Hello there", "Param text"]);
    }

    #[test]
    fn global_strings_filter_and_priority() {
        assert!(is_global_string_candidate("Main Camera"));
        assert!(!is_global_string_candidate("actions/open"));
        assert!(!is_global_string_candidate("_MainTex"));
        assert_eq!(ui_priority("Main Camera"), 100);
        let mut bucket = Bucket::default();
        let texts: Vec<String> = vec!["Main Camera".into(), "Other Label".into()];
        let picked = select_global_strings(&texts, Some(1), &mut bucket);
        assert_eq!(picked, vec!["Main Camera"]);
        assert_eq!(bucket.dropped, 1);
    }

    #[test]
    fn counters_orders_by_count_then_appearance() {
        let values: Vec<String> = ["B", "A", "B", "C"].iter().map(|s| s.to_string()).collect();
        assert_eq!(
            render(&counter_most_common(&values)),
            r#"{"B": 2, "A": 1, "C": 1}"#
        );
    }
}
