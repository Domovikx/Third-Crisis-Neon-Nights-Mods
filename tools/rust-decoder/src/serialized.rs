//! serialized.rs — SerializedFile Unity (порт `serialized.mts`).
//!
//! Формат (версия 22, Unity 2022.3 — наша игра):
//!
//!   legacy-префикс (ВСЕГДА big-endian): u32 metadataSize, u32 fileSize,
//!       u32 version, u32 dataOffset
//!   u8 endian (1 = BE), 3 байта reserved
//!   [version >= 22] u32be metadataSize, i64be fileSize, i64be dataOffset,
//!       i64be unknown
//!   cstring unityVersion, i32 targetPlatform, u8 enableTypeTree,
//!   i32 typeCount, типы, i32 objectCount, объекты,
//!   i32 scriptCount, скрипты, i32 externalCount, externals,
//!   [version >= 20] i32 refTypeCount, ref-типы, cstring userInformation
//!
//! Поддержана ТОЛЬКО версия 22: игра на Unity 2022.3, а legacy-ветки (<22)
//! означали бы непроверенный код. Другая версия — внятная ошибка.

use crate::binio::{fail, i64_to_usize, Reader, Result};

pub const SUPPORTED_VERSION: u32 = 22;

#[derive(Debug, Clone, Copy)]
pub struct TypeTreeInfo {
    pub node_count: i32,
    pub string_buffer_size: i32,
    /// Границы blob в файле — отсюда берётся type tree для TS-семантики.
    pub blob_start: usize,
    pub blob_end: usize,
}

#[derive(Debug, Clone)]
pub struct SerializedType {
    pub class_id: i32,
    pub type_tree: Option<TypeTreeInfo>,
}

#[derive(Debug, Clone, Copy)]
pub struct Object {
    /// 64-битный Unity-хэш; печатается строкой (в TS — BigInt).
    pub path_id: i64,
    pub type_id: i32,
    pub class_id: i32,
    /// Абсолютное смещение данных объекта (dataOffset уже прибавлен).
    pub byte_start: usize,
    pub byte_size: usize,
}

#[derive(Debug, Clone)]
pub struct Header {
    pub metadata_size: usize,
    pub file_size: usize,
    pub version: u32,
    pub data_offset: usize,
    pub be: bool,
    pub unity_version: String,
    pub target_platform: i32,
    pub enable_type_tree: bool,
}

#[derive(Debug)]
pub struct SerializedFile<'a> {
    pub header: Header,
    pub types: Vec<SerializedType>,
    pub objects: Vec<Object>,
    /// Сырые байты файла: чтение объекта — срез по byte_start/byte_size.
    pub raw: &'a [u8],
}

impl SerializedFile<'_> {
    pub fn object_raw(&self, object: &Object) -> &[u8] {
        &self.raw[object.byte_start..object.byte_start + object.byte_size]
    }
}

/// Быстрая проверка «это SerializedFile?» без полного разбора (как UnityPy).
pub fn is_serialized_file(data: &[u8]) -> bool {
    peek_header(data).is_some()
}

/// Прочитать заголовок для проверки типа; None, если данные не похожи.
pub fn peek_header(data: &[u8]) -> Option<(u32, usize, usize, usize)> {
    if data.len() < 20 {
        return None;
    }
    let mut r = Reader::new(data, true);
    let mut metadata_size = r.u32().ok()? as usize;
    let mut file_size = r.u32().ok()? as usize;
    let version = r.u32().ok()?;
    let mut data_offset = r.u32().ok()? as usize;
    if version >= 9 {
        r.u8().ok()?;
        r.skip(3).ok()?;
        if version >= 22 {
            metadata_size = r.u32().ok()? as usize;
            file_size = i64_to_usize(r.i64().ok()?, "fileSize", 0).ok()?;
            data_offset = i64_to_usize(r.i64().ok()?, "dataOffset", 0).ok()?;
        }
    }
    // Версии < 9 — почти наверняка сырой ресурс со случайными байтами.
    if !(9..=100).contains(&version) {
        return None;
    }
    if metadata_size > data.len() || file_size > data.len() || data_offset > data.len() {
        return None;
    }
    if file_size < metadata_size || file_size < data_offset {
        return None;
    }
    Some((version, metadata_size, file_size, data_offset))
}

/// Разобрать SerializedFile (заголовок и метаданные; данные объектов не трогаем).
pub fn read_serialized_file(data: &[u8]) -> Result<SerializedFile<'_>> {
    let mut r = Reader::new(data, true);

    let _legacy_metadata_size = r.u32()?;
    let _legacy_file_size = r.u32()?;
    let version = r.u32()?;
    let _legacy_data_offset = r.u32()?;

    if version < 9 {
        return fail(
            format!("SerializedFile версии {} не поддерживается", version),
            8,
        );
    }
    let be = r.u8()? != 0;
    r.skip(3)?;
    if version < 22 {
        return fail(
            format!(
                "SerializedFile версии {} не поддерживается (игра на {})",
                version, SUPPORTED_VERSION
            ),
            8,
        );
    }
    let metadata_size = r.u32()? as usize;
    let file_size = i64_to_usize(r.i64()?, "SerializedFile: fileSize", 0)?;
    let data_offset = i64_to_usize(r.i64()?, "SerializedFile: dataOffset", 0)?;
    let _unknown = r.i64()?;

    if version > 100 {
        return fail(
            format!("SerializedFile: неправдоподобная версия {}", version),
            8,
        );
    }
    if file_size > data.len() {
        return fail(
            format!(
                "SerializedFile: fileSize {} больше файла {}",
                file_size,
                data.len()
            ),
            r.pos,
        );
    }
    if data_offset > data.len() {
        return fail(
            format!(
                "SerializedFile: dataOffset {} больше файла {}",
                data_offset,
                data.len()
            ),
            r.pos,
        );
    }

    r.be = be;

    let unity_version = r.cstring()?;
    let target_platform = r.i32()?;
    let enable_type_tree = r.u8()? != 0;

    let type_count = r.i32()?;
    if !(0..=1_000_000).contains(&type_count) {
        return fail(
            format!("SerializedFile: некорректное число типов {}", type_count),
            r.pos.saturating_sub(4),
        );
    }
    let mut types = Vec::with_capacity(type_count as usize);
    for _ in 0..type_count {
        types.push(read_type(&mut r, version, enable_type_tree, false)?);
    }

    let object_count = r.i32()?;
    if object_count < 0 || object_count as usize > data.len() {
        return fail(
            format!(
                "SerializedFile: некорректное число объектов {}",
                object_count
            ),
            r.pos.saturating_sub(4),
        );
    }
    let mut objects = Vec::with_capacity(object_count as usize);
    for _ in 0..object_count {
        let object = read_object(&mut r, version, data_offset, &types)?;
        if object.byte_start + object.byte_size > data.len() {
            return fail(
                format!(
                    "SerializedFile: объект {} выходит за файл ({} + {} > {})",
                    object.path_id,
                    object.byte_start,
                    object.byte_size,
                    data.len()
                ),
                r.pos,
            );
        }
        objects.push(object);
    }

    // Скрипты: в v22 localFileIndex + выравнивание + i64.
    let script_count = r.i32()?;
    if !(0..=1_000_000).contains(&script_count) {
        return fail(
            format!(
                "SerializedFile: некорректное число скриптов {}",
                script_count
            ),
            r.pos.saturating_sub(4),
        );
    }
    for _ in 0..script_count {
        let _local_file_index = r.i32()?;
        r.align(4);
        let _local_identifier = r.i64()?;
    }

    let external_count = r.i32()?;
    if !(0..=1_000_000).contains(&external_count) {
        return fail(
            format!(
                "SerializedFile: некорректное число externals {}",
                external_count
            ),
            r.pos.saturating_sub(4),
        );
    }
    for _ in 0..external_count {
        let _temp_empty = r.cstring()?;
        let _guid = r.bytes(16)?;
        let _kind = r.i32()?;
        let _path = r.cstring()?;
    }

    let ref_type_count = r.i32()?;
    if !(0..=1_000_000).contains(&ref_type_count) {
        return fail(
            format!(
                "SerializedFile: некорректное число ref-типов {}",
                ref_type_count
            ),
            r.pos.saturating_sub(4),
        );
    }
    for _ in 0..ref_type_count {
        read_type(&mut r, version, enable_type_tree, true)?;
    }

    let _user_information = r.cstring()?;

    Ok(SerializedFile {
        header: Header {
            metadata_size,
            file_size,
            version,
            data_offset,
            be,
            unity_version,
            target_platform,
            enable_type_tree,
        },
        types,
        objects,
        raw: data,
    })
}

fn read_type(
    r: &mut Reader<'_>,
    version: u32,
    enable_type_tree: bool,
    is_ref_type: bool,
) -> Result<SerializedType> {
    let class_id = r.i32()?;
    let _is_stripped = r.u8()? != 0;
    let script_type_index = r.i16()?;

    let needs_script_id = (is_ref_type && script_type_index >= 0)
        || (version < 16 && class_id < 0)
        || (version >= 16 && class_id == 114);
    if needs_script_id {
        r.bytes(16)?;
    }
    r.bytes(16)?; // oldTypeHash

    let mut type_tree = None;
    if enable_type_tree {
        let node_count = r.i32()?;
        let string_buffer_size = r.i32()?;
        // Узел v22 = 32 байта; blob = узлы + строковый буфер.
        let node_size = if version >= 19 { 32 } else { 24 };
        if node_count < 0 || string_buffer_size < 0 {
            return fail(
                format!(
                    "SerializedFile: битый type tree (узлов {}, строк {})",
                    node_count, string_buffer_size
                ),
                r.pos.saturating_sub(8),
            );
        }
        let blob_start = r.pos;
        let blob_len = node_count as usize * node_size + string_buffer_size as usize;
        let blob_end = blob_start + blob_len;
        if blob_end > r.len() {
            return fail("SerializedFile: type tree выходит за файл", blob_start);
        }
        type_tree = Some(TypeTreeInfo {
            node_count,
            string_buffer_size,
            blob_start,
            blob_end,
        });
        r.seek(blob_end)?;

        if version >= 21 {
            if is_ref_type {
                // Ref-тип: тройка имён вместо зависимостей.
                let _class_name = r.cstring()?;
                let _namespace = r.cstring()?;
                let _assembly = r.cstring()?;
            } else {
                let dep_count = r.i32()?;
                if dep_count < 0 || dep_count as usize > r.remaining() / 4 {
                    return fail(
                        format!(
                            "SerializedFile: некорректные type dependencies {}",
                            dep_count
                        ),
                        r.pos.saturating_sub(4),
                    );
                }
                for _ in 0..dep_count {
                    r.i32()?;
                }
            }
        }
    }

    Ok(SerializedType {
        class_id,
        type_tree,
    })
}

fn read_object(
    r: &mut Reader<'_>,
    version: u32,
    data_offset: usize,
    types: &[SerializedType],
) -> Result<Object> {
    r.align(4);
    let path_id = r.i64()?;
    let byte_start = i64_to_usize(r.i64()?, "SerializedFile: byteStart", r.pos)? + data_offset;
    let byte_size = r.u32()? as usize;
    let type_id = r.i32()?;

    if type_id < 0 || type_id as usize >= types.len() {
        return fail(
            format!(
                "SerializedFile: typeId {} вне type table ({})",
                type_id,
                types.len()
            ),
            r.pos.saturating_sub(4),
        );
    }
    let class_id = types[type_id as usize].class_id;

    // Поля древних версий — в v22 их нет.
    if version < 16 {
        r.skip(2)?;
    }
    if version < 11 {
        r.skip(2)?;
    }
    if (11..17).contains(&version) {
        r.skip(2)?;
    }
    if version == 15 || version == 16 {
        r.skip(1)?;
    }

    Ok(Object {
        path_id,
        type_id,
        class_id,
        byte_start,
        byte_size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{build_serialized_file, SerializedFixture};

    #[test]
    fn заголовок_и_объекты() {
        let file = build_serialized_file(&SerializedFixture {
            enable_type_tree: false,
            types: vec![(1, None), (114, None)],
            objects: vec![(42, 0, b"hello".to_vec()), (-7, 1, b"world!".to_vec())],
        });
        assert!(is_serialized_file(&file));
        let sf = read_serialized_file(&file).unwrap();
        assert_eq!(sf.header.version, 22);
        assert_eq!(sf.header.unity_version, "2022.3.62f3");
        assert!(!sf.header.enable_type_tree);
        assert_eq!(sf.header.data_offset, 48 + sf.header.metadata_size);
        assert_eq!(sf.objects.len(), 2);
        assert_eq!(sf.objects[0].path_id, 42);
        assert_eq!(sf.objects[0].class_id, 1);
        assert_eq!(sf.objects[1].path_id, -7);
        assert_eq!(sf.object_raw(&sf.objects[1]), b"world!");
    }

    #[test]
    fn type_tree_blob_отдаётся_диапазоном() {
        // Узел: typeOffset=0 ("int"), nameOffset=0 — значения для теста не важны.
        let mut nodes = vec![0u8; 32];
        nodes[4..8].copy_from_slice(&0u32.to_le_bytes());
        let strings = vec![b'i', b'n', b't', 0, 0, 0, 0, 0];
        let file = build_serialized_file(&SerializedFixture {
            enable_type_tree: true,
            types: vec![(1, Some((nodes, strings)))],
            objects: vec![(1, 0, vec![1, 2, 3, 4])],
        });
        let sf = read_serialized_file(&file).unwrap();
        let info = sf.types[0].type_tree.expect("type tree есть");
        assert_eq!(info.node_count, 1);
        assert_eq!(info.string_buffer_size, 8);
        assert_eq!(info.blob_end - info.blob_start, 32 + 8);
        assert_eq!(
            &sf.raw[info.blob_end - 8..info.blob_end],
            &[b'i', b'n', b't', 0, 0, 0, 0, 0]
        );
    }

    #[test]
    fn сырой_мусор_не_принимается() {
        assert!(!is_serialized_file(b"not a serialized file at all"));
    }
}
