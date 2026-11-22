//! rd1.rs — промежуточный JSONL «сырья» (rd1) между декодером и семантикой.
//!
//! ГРАНИЦА (важная часть контракта, см. `docs/rust-vs-ts.md`):
//! здесь заканчивается байтовый уровень и начинается TS. Rust отдаёт ФАКТЫ:
//! контейнер, таблицы SerializedFile, blob'ы type tree, сырые сканы (строки,
//! диалоги, ColorParserList, Settings.*, куча #US) и объектные байты для
//! типизированных объектов. Rust НЕ решает, что попадёт в JSONL/POT: отбор
//! полей (`strings`/`fields`/`fsm_strings`), фильтры UI-текста, дедуп,
//! порядок и имена ассетов — только TS.
//!
//! Записи (по одной на строку, порядок фиксирован — его же повторяет TS-эталон
//! формата в `rawdump.mts`, и это проверяется побайтовым паритетом):
//!
//!   {"t":"asset","asset","path","kind"[,"entries"][,"error"]}
//!   {"t":"sf","i","name","unityVersion","headerVersion","typeTreeEnabled",
//!          "objectCount","endian"}
//!   {"t":"type","sf","typeId","classId","nodeCount","stringSize","blob"}
//!   {"t":"obj","sf","typeId","classId","pathId"[,"raw"]["rs"]["dl"]["cpl"]}
//!   {"t":"warn","texts":[...]}
//!   {"t":"runs","texts":[...]}
//!   {"t":"keys","keys":[{"key","display"}]}
//!   {"t":"us","heap":"<base64>"}

use std::io::{self, Write};
use std::time::Instant;

use crate::dotnet;
use crate::json::Out;
use crate::rawscan;
use crate::serialized::{self, SerializedFile};
use crate::unityfs;

/// Расширения, которые UnityPy НЕ разбирает как SerializedFile.
pub const NON_SERIALIZED_EXTENSIONS: [&str; 5] = [".resS", ".resource", ".config", ".xml", ".dat"];

fn is_non_serialized_entry(path: &str) -> bool {
    NON_SERIALIZED_EXTENSIONS
        .iter()
        .any(|ext| path.ends_with(ext))
}

/// Что получилось по файлу (для отчёта/бенчмарка).
#[derive(Debug, Default, Clone, Copy)]
pub struct FileStats {
    pub objects: usize,
    pub typed_objects: usize,
}

/// Тайминги фаз (мс). Сериализация в JSONL — остаток от общего времени.
#[derive(Debug, Default, Clone, Copy)]
pub struct Timings {
    pub read_ms: f64,
    pub decode_ms: f64,
    pub scan_ms: f64,
    pub runs_ms: f64,
}

/// Монотонная точка отсчёта внутри процесса.
pub struct Clock(Instant);

impl Clock {
    pub fn start() -> Self {
        Clock(Instant::now())
    }

    pub fn ms(&self) -> f64 {
        self.0.elapsed().as_secs_f64() * 1000.0
    }
}

struct Emitter<'a, W: Write> {
    out: &'a mut Out<W>,
    warnings: Vec<String>,
}

impl<'a, W: Write> Emitter<'a, W> {
    fn new(out: &'a mut Out<W>) -> Self {
        Emitter {
            out,
            warnings: Vec::new(),
        }
    }

    fn asset(
        &mut self,
        asset: &str,
        path: &str,
        kind: &str,
        entries: Option<&[unityfs::Entry]>,
        error: Option<&str>,
    ) -> io::Result<()> {
        let out = &mut *self.out;
        out.raw("{\"t\":\"asset\",\"asset\":")?;
        out.string(asset)?;
        out.raw(",\"path\":")?;
        out.string(path)?;
        out.raw(",\"kind\":")?;
        out.string(kind)?;
        if let Some(entries) = entries {
            out.raw(",\"entries\":[")?;
            for (index, entry) in entries.iter().enumerate() {
                if index > 0 {
                    out.raw(",")?;
                }
                out.raw("{\"path\":")?;
                out.string(&entry.path)?;
                out.raw(",\"offset\":")?;
                out.unum(entry.offset as u64)?;
                out.raw(",\"size\":")?;
                out.unum(entry.size as u64)?;
                out.raw("}")?;
            }
            out.raw("]")?;
        }
        if let Some(error) = error {
            out.raw(",\"error\":")?;
            out.string(error)?;
        }
        out.raw("}")?;
        out.newline()
    }

    /// Предупреждения по битым entry: отдельной записью в конце файла.
    fn flush_warnings(&mut self) -> io::Result<()> {
        if self.warnings.is_empty() {
            return Ok(());
        }
        let out = &mut *self.out;
        out.raw("{\"t\":\"warn\",\"texts\":[")?;
        for (index, text) in self.warnings.iter().enumerate() {
            if index > 0 {
                out.raw(",")?;
            }
            out.string(text)?;
        }
        out.raw("]}")?;
        out.newline()?;
        self.warnings.clear();
        Ok(())
    }
}

/// Разобрать один файл и записать rd1-записи.
pub fn emit_file<W: Write>(
    out: &mut Out<W>,
    asset: &str,
    path: &str,
    bytes: &[u8],
    timings: &mut Timings,
) -> io::Result<FileStats> {
    let clock = Clock::start();
    let lower = path.to_lowercase();
    let mut stats = FileStats::default();

    if lower.ends_with(".dll") {
        let mut emitter = Emitter::new(out);
        emitter.asset(asset, path, "dotnet", None, None)?;
        if let Some(heap) = dotnet::find_us_heap(bytes) {
            let slice = dotnet::us_heap_slice(bytes, heap);
            let out = &mut *emitter.out;
            out.raw("{\"t\":\"us\",\"heap\":")?;
            out.base64(slice)?;
            out.raw("}")?;
            out.newline()?;
        }
        return Ok(stats);
    }

    let decode_started = clock.ms();
    if unityfs::is_unityfs(bytes) {
        let mut emitter = Emitter::new(out);
        match unityfs::read_unityfs(bytes) {
            Ok(archive) => {
                let mut parsed: Vec<(String, SerializedFile<'_>)> = Vec::new();
                for entry in &archive.entries {
                    if is_non_serialized_entry(&entry.path) {
                        continue;
                    }
                    let body = archive.read_entry(entry);
                    if !serialized::is_serialized_file(body) {
                        continue;
                    }
                    match serialized::read_serialized_file(body) {
                        Ok(file) => parsed.push((entry.path.clone(), file)),
                        Err(err) => emitter.warnings.push(format!("{}: {}", entry.path, err)),
                    }
                }
                timings.decode_ms += clock.ms() - decode_started;
                emitter.asset(asset, path, "unityfs", Some(&archive.entries), None)?;
                for (index, (name, file)) in parsed.iter().enumerate() {
                    emit_serialized_file(
                        &mut emitter,
                        index,
                        name,
                        file,
                        &clock,
                        timings,
                        &mut stats,
                    )?;
                }
                emitter.flush_warnings()?;
                emit_file_tail(&mut *emitter.out, bytes, timings)?;
            }
            Err(err) => {
                timings.decode_ms += clock.ms() - decode_started;
                emitter.asset(asset, path, "unityfs", None, Some(&err.0))?;
            }
        }
        return Ok(stats);
    }

    if serialized::is_serialized_file(bytes) {
        let mut emitter = Emitter::new(out);
        match serialized::read_serialized_file(bytes) {
            Ok(file) => {
                let name = path.rsplit(['/', '\\']).next().unwrap_or(asset).to_string();
                timings.decode_ms += clock.ms() - decode_started;
                emitter.asset(asset, path, "serialized", None, None)?;
                emit_serialized_file(&mut emitter, 0, &name, &file, &clock, timings, &mut stats)?;
                emit_file_tail(&mut *emitter.out, bytes, timings)?;
            }
            Err(err) => {
                timings.decode_ms += clock.ms() - decode_started;
                emitter.asset(asset, path, "serialized", None, Some(&err.0))?;
            }
        }
        return Ok(stats);
    }

    // Сырой ресурс или вообще не Unity: объектов нет, но strings/settings есть.
    timings.decode_ms += clock.ms() - decode_started;
    let kind = if lower.ends_with(".resource") {
        "raw"
    } else {
        "unknown"
    };
    let mut emitter = Emitter::new(out);
    emitter.asset(asset, path, kind, None, None)?;
    emit_file_tail(&mut *emitter.out, bytes, timings)?;
    Ok(stats)
}

/// Хвост файла: сканы целого файла (ключи настроек и печатные строки).
fn emit_file_tail<W: Write>(
    out: &mut Out<W>,
    bytes: &[u8],
    timings: &mut Timings,
) -> io::Result<()> {
    let runs_started = Clock::start();
    let settings = rawscan::scan_settings_keys(bytes);
    let runs = rawscan::scan_runs(bytes);
    timings.runs_ms += runs_started.ms();

    if !runs.is_empty() {
        out.raw("{\"t\":\"runs\",\"texts\":[")?;
        for (index, text) in runs.iter().enumerate() {
            if index > 0 {
                out.raw(",")?;
            }
            out.string(text)?;
        }
        out.raw("]}")?;
        out.newline()?;
    }
    if !settings.is_empty() {
        out.raw("{\"t\":\"keys\",\"keys\":[")?;
        for (index, key) in settings.iter().enumerate() {
            if index > 0 {
                out.raw(",")?;
            }
            out.raw("{\"key\":")?;
            out.string(&key.key)?;
            out.raw(",\"display\":")?;
            out.string(&key.display)?;
            out.raw("}")?;
        }
        out.raw("]}")?;
        out.newline()?;
    }
    Ok(())
}

fn emit_serialized_file<W: Write>(
    emitter: &mut Emitter<'_, W>,
    index: usize,
    name: &str,
    file: &SerializedFile<'_>,
    clock: &Clock,
    timings: &mut Timings,
    stats: &mut FileStats,
) -> io::Result<()> {
    let header = &file.header;
    {
        let out = &mut *emitter.out;
        out.raw("{\"t\":\"sf\",\"i\":")?;
        out.unum(index as u64)?;
        out.raw(",\"name\":")?;
        out.string(name)?;
        out.raw(",\"unityVersion\":")?;
        out.string(&header.unity_version)?;
        out.raw(",\"headerVersion\":")?;
        out.num(header.version as i64)?;
        out.raw(",\"typeTreeEnabled\":")?;
        out.raw(if header.enable_type_tree {
            "true"
        } else {
            "false"
        })?;
        out.raw(",\"objectCount\":")?;
        out.unum(file.objects.len() as u64)?;
        out.raw(",\"endian\":")?;
        out.string(if header.be { "be" } else { "le" })?;
        out.raw("}")?;
        out.newline()?;
    }

    // Type tree'ы: blob передаётся как есть, разбирает его TS (семантика — там).
    for (type_id, kind) in file.types.iter().enumerate() {
        let Some(tree) = kind.type_tree else {
            continue;
        };
        let blob = &file.raw[tree.blob_start..tree.blob_end];
        let out = &mut *emitter.out;
        out.raw("{\"t\":\"type\",\"sf\":")?;
        out.unum(index as u64)?;
        out.raw(",\"typeId\":")?;
        out.unum(type_id as u64)?;
        out.raw(",\"classId\":")?;
        out.num(kind.class_id as i64)?;
        out.raw(",\"nodeCount\":")?;
        out.num(tree.node_count as i64)?;
        out.raw(",\"stringSize\":")?;
        out.num(tree.string_buffer_size as i64)?;
        out.raw(",\"blob\":")?;
        out.base64(blob)?;
        out.raw("}")?;
        out.newline()?;
    }

    for object in &file.objects {
        let raw = file.object_raw(object);
        let typed = file.types[object.type_id as usize].type_tree.is_some();
        let scan_started = clock.ms();
        let raw_strings = rawscan::scan_raw_strings(raw, 0);
        let dialogues = rawscan::parse_dialogue_from_raw(raw, 0);
        let has_color_marker = raw_strings.iter().any(|s| s.text == "ColorParserList");
        let colors = if has_color_marker {
            rawscan::parse_color_parser_list(raw)
        } else {
            None
        };
        timings.scan_ms += clock.ms() - scan_started;

        stats.objects += 1;
        if typed {
            stats.typed_objects += 1;
        }

        let out = &mut *emitter.out;
        out.raw("{\"t\":\"obj\",\"sf\":")?;
        out.unum(index as u64)?;
        out.raw(",\"typeId\":")?;
        out.num(object.type_id as i64)?;
        out.raw(",\"classId\":")?;
        out.num(object.class_id as i64)?;
        out.raw(",\"pathId\":")?;
        out.string(&object.path_id.to_string())?;
        if typed {
            out.raw(",\"raw\":")?;
            out.base64(raw)?;
        }
        if !raw_strings.is_empty() {
            out.raw(",\"rs\":[")?;
            for (i, item) in raw_strings.iter().enumerate() {
                if i > 0 {
                    out.raw(",")?;
                }
                out.string(&item.text)?;
            }
            out.raw("]")?;
        }
        if !dialogues.is_empty() {
            out.raw(",\"dl\":[")?;
            for (i, dialogue) in dialogues.iter().enumerate() {
                if i > 0 {
                    out.raw(",")?;
                }
                out.raw("{\"offset\":")?;
                out.unum(dialogue.offset as u64)?;
                out.raw(",\"speaker\":")?;
                out.string(&dialogue.speaker)?;
                out.raw(",\"text\":")?;
                out.string(&dialogue.text)?;
                out.raw(",\"rich_text\":")?;
                out.string(&dialogue.rich_text)?;
                out.raw("}")?;
            }
            out.raw("]")?;
        }
        if let Some(colors) = &colors {
            out.raw(",\"cpl\":{")?;
            for (i, (name, hex)) in colors.iter().enumerate() {
                if i > 0 {
                    out.raw(",")?;
                }
                out.string(name)?;
                out.raw(":")?;
                out.string(hex)?;
            }
            out.raw("}")?;
        }
        out.raw("}")?;
        out.newline()?;
    }
    Ok(())
}
