//! typetree — type tree Unity и generic-чтение объекта по нему.
//!
//! Порт `.opencode/skills/dump-assets/scripts/typetree.mts` (поведение 1:1):
//! тот же разбор узлов по 32 байта, те же имена из таблицы общих строк и
//! строкового буфера, те же выравнивания и те же причуды (например, массивы
//! `short`/`unsigned short` читаются «перекрёстно», потому что так в эталоне).
//!
//! Зачем: в `*.assets` type tree выключен, а в бандлах включён — каждый объект
//! несёт собственное описание полей, и только оно даёт `strings`/`fields`
//! без ручных схем классов.
//!
//! `ReferencedObject` (ManagedReferencesRegistry) не поддержан осознанно: он
//! требует ref-типов из файла. Как и в эталоне, встреча с ним — ошибка чтения
//! (`None`), а не паника.
//!
//! Границы blob'а: вызывающий передаёт ВЕСЬ type tree blob (START = 0,
//! END = `blob.len()`), поэтому строковый буфер начинается сразу после
//! `node_count * 32` и идёт до конца blob'а.

use crate::value::Val;

/// Порядок байт чисел в SerializedFile.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Endian {
    Le,
    Be,
}

/// Размер узла type tree (v22 и всё, что мы читаем).
const NODE_SIZE: usize = 32;

/// `meta_flag & 0x4000` — выравнивание потока до 4 байт.
const ALIGNED_FLAG: i32 = 0x4000;

/// Таблица «общих строк» Unity (112 имён) — общая для всех сборок.
///
/// Источник: TPK common-strings (AssetsTools.NET), который UnityPy держит в
/// `resources/lzma.tpk`. Смещения кумулятивные: строка идёт через NUL, поэтому
/// `offset += len + 1`. Данные, не код: без таблицы имена узлов с флагом
/// 0x80000000 не раскодировать. Порядок и состав обязаны совпадать с эталоном.
const COMMON_STRING_LIST: &[&str] = &[
    "AABB",
    "AnimationClip",
    "AnimationCurve",
    "AnimationState",
    "Array",
    "Base",
    "BitField",
    "bitset",
    "bool",
    "char",
    "ColorRGBA",
    "Component",
    "data",
    "deque",
    "double",
    "dynamic_array",
    "FastPropertyName",
    "first",
    "float",
    "Font",
    "GameObject",
    "Generic Mono",
    "GradientNEW",
    "GUID",
    "GUIStyle",
    "int",
    "list",
    "long long",
    "map",
    "Matrix4x4f",
    "MdFour",
    "MonoBehaviour",
    "MonoScript",
    "m_ByteSize",
    "m_Curve",
    "m_EditorClassIdentifier",
    "m_EditorHideFlags",
    "m_Enabled",
    "m_ExtensionPtr",
    "m_GameObject",
    "m_Index",
    "m_IsArray",
    "m_IsStatic",
    "m_MetaFlag",
    "m_Name",
    "m_ObjectHideFlags",
    "m_PrefabInternal",
    "m_PrefabParentObject",
    "m_Script",
    "m_StaticEditorFlags",
    "m_Type",
    "m_Version",
    "Object",
    "pair",
    "PPtr<Component>",
    "PPtr<GameObject>",
    "PPtr<Material>",
    "PPtr<MonoBehaviour>",
    "PPtr<MonoScript>",
    "PPtr<Object>",
    "PPtr<Prefab>",
    "PPtr<Sprite>",
    "PPtr<TextAsset>",
    "PPtr<Texture>",
    "PPtr<Texture2D>",
    "PPtr<Transform>",
    "Prefab",
    "Quaternionf",
    "Rectf",
    "RectInt",
    "RectOffset",
    "second",
    "set",
    "short",
    "size",
    "SInt16",
    "SInt32",
    "SInt64",
    "SInt8",
    "staticvector",
    "string",
    "TextAsset",
    "TextMesh",
    "Texture",
    "Texture2D",
    "Transform",
    "TypelessData",
    "UInt16",
    "UInt32",
    "UInt64",
    "UInt8",
    "unsigned int",
    "unsigned long long",
    "unsigned short",
    "vector",
    "Vector2f",
    "Vector3f",
    "Vector4f",
    "m_ScriptingClassIdentifier",
    "Gradient",
    "Type*",
    "int2_storage",
    "int3_storage",
    "BoundsInt",
    "m_CorrespondingSourceObject",
    "m_PrefabInstance",
    "m_PrefabAsset",
    "FileSize",
    "Hash128",
    "RenderingLayerMask",
    "fixed_array",
    "EntityId",
];

/// Узел type tree: одно поле объекта и его дети.
#[derive(Clone, Debug)]
pub struct TypeTreeNode {
    pub level: i32,
    pub type_name: String,
    pub name: String,
    pub byte_size: i32,
    pub index: i32,
    pub meta_flag: i32,
    pub version: u16,
    pub flags: u8,
    pub ref_type_hash: u64,
    pub children: Vec<TypeTreeNode>,
}

/// Имя из таблицы общих строк по смещению (смещения идут по возрастанию).
fn common_string(offset: u32) -> Option<&'static str> {
    let mut cur: u32 = 0;
    for s in COMMON_STRING_LIST {
        if cur == offset {
            return Some(s);
        }
        if cur > offset {
            return None;
        }
        cur += s.len() as u32 + 1;
    }
    None
}

fn is_aligned(meta_flag: i32) -> bool {
    meta_flag & ALIGNED_FLAG != 0
}

/// Промежуточная запись: узел + индексы детей (дерево собирается после
/// разбора, чтобы не держать ссылки на изменяемый вектор).
struct NodeRec {
    level: i32,
    type_name: String,
    name: String,
    byte_size: i32,
    index: i32,
    meta_flag: i32,
    version: u16,
    flags: u8,
    ref_type_hash: u64,
    children: Vec<usize>,
}

impl NodeRec {
    fn fake_root() -> Self {
        Self {
            level: -1,
            type_name: String::new(),
            name: String::new(),
            byte_size: 0,
            index: 0,
            meta_flag: 0,
            version: 0,
            flags: 0,
            ref_type_hash: 0,
            children: Vec::new(),
        }
    }
}

/// Прочитать `N` байт на смещении `off` (выход за границы — `None`).
fn bytes_at<const N: usize>(data: &[u8], off: usize) -> Option<[u8; N]> {
    let end = off.checked_add(N)?;
    let slice = data.get(off..end)?;
    let mut out = [0u8; N];
    out.copy_from_slice(slice);
    Some(out)
}

fn u16_at(data: &[u8], off: usize, endian: Endian) -> Option<u16> {
    Some(match endian {
        Endian::Le => u16::from_le_bytes(bytes_at::<2>(data, off)?),
        Endian::Be => u16::from_be_bytes(bytes_at::<2>(data, off)?),
    })
}

fn u32_at(data: &[u8], off: usize, endian: Endian) -> Option<u32> {
    Some(match endian {
        Endian::Le => u32::from_le_bytes(bytes_at::<4>(data, off)?),
        Endian::Be => u32::from_be_bytes(bytes_at::<4>(data, off)?),
    })
}

fn i32_at(data: &[u8], off: usize, endian: Endian) -> Option<i32> {
    Some(match endian {
        Endian::Le => i32::from_le_bytes(bytes_at::<4>(data, off)?),
        Endian::Be => i32::from_be_bytes(bytes_at::<4>(data, off)?),
    })
}

fn u64_at(data: &[u8], off: usize, endian: Endian) -> Option<u64> {
    Some(match endian {
        Endian::Le => u64::from_le_bytes(bytes_at::<8>(data, off)?),
        Endian::Be => u64::from_be_bytes(bytes_at::<8>(data, off)?),
    })
}

/// Разобрать type tree из blob SerializedFile.
///
/// Узлы идут подряд (32 байта на узел), имена — либо в строковом буфере
/// (сразу после узлов), либо в таблице общих строк (старший бит смещения).
/// `None` — битый blob, нечитаемая иерархия или пустое дерево (в эталоне это
/// исключения, которые вызывающий превращает в `read_failed`).
pub fn parse_type_tree(blob: &[u8], node_count: usize, endian: Endian) -> Option<TypeTreeNode> {
    let string_start = node_count.checked_mul(NODE_SIZE)?;
    let string_end = blob.len();
    if string_start > string_end {
        return None;
    }

    // C-строка строкового буфера; смещения считаются от `string_start`.
    let read_cstring = |offset: u32| -> String {
        let start = match (string_start as u64).checked_add(offset as u64) {
            Some(v) => v,
            None => return String::new(),
        };
        if start >= string_end as u64 {
            return String::new();
        }
        let start = start as usize;
        let mut end = start;
        while end < string_end && blob[end] != 0 {
            end += 1;
        }
        String::from_utf8_lossy(&blob[start..end]).into_owned()
    };

    // Имя узла: строковый буфер или таблица общих строк (старший бит).
    let read_name = |raw: u32| -> String {
        if raw & 0x8000_0000 == 0 {
            read_cstring(raw)
        } else {
            let offset = raw & 0x7fff_ffff;
            common_string(offset).map_or_else(|| offset.to_string(), str::to_string)
        }
    };

    let mut records: Vec<Option<NodeRec>> = Vec::with_capacity(node_count + 1);
    records.push(Some(NodeRec::fake_root()));
    for i in 0..node_count {
        let off = i * NODE_SIZE;
        let version = u16_at(blob, off, endian)?;
        let level = *blob.get(off + 2)? as i32;
        let flags = *blob.get(off + 3)?;
        let type_str_offset = u32_at(blob, off + 4, endian)?;
        let name_str_offset = u32_at(blob, off + 8, endian)?;
        let byte_size = i32_at(blob, off + 12, endian)?;
        let index = i32_at(blob, off + 16, endian)?;
        let meta_flag = i32_at(blob, off + 20, endian)?;
        let ref_type_hash = u64_at(blob, off + 24, endian)?;
        records.push(Some(NodeRec {
            level,
            type_name: read_name(type_str_offset),
            name: read_name(name_str_offset),
            byte_size,
            index,
            meta_flag,
            version,
            flags,
            ref_type_hash,
            children: Vec::new(),
        }));
    }

    // Иерархия: фейковый корень уровня -1 и стек родителей, как в эталоне.
    let fake = 0usize;
    let level_at = |records: &[Option<NodeRec>], i: usize| -> i32 {
        records[i].as_ref().map_or(-1, |n| n.level)
    };
    let mut stack: Vec<usize> = vec![fake];
    let mut parent = fake;
    let mut prev = fake;
    for idx in 1..records.len() {
        let level = level_at(&records, idx);
        if level > level_at(&records, prev) {
            stack.push(parent);
            parent = prev;
        } else if level < level_at(&records, prev) {
            while level <= level_at(&records, parent) {
                parent = stack.pop()?;
            }
        }
        records[parent].as_mut()?.children.push(idx);
        prev = idx;
    }

    let root_idx = *records[fake].as_ref()?.children.first()?;
    take_node(&mut records, root_idx)
}

/// Собратьowned-дерево из плоских записей (каждый индекс встречается один раз).
fn take_node(records: &mut [Option<NodeRec>], idx: usize) -> Option<TypeTreeNode> {
    let rec = records.get_mut(idx)?.take()?;
    let mut children = Vec::with_capacity(rec.children.len());
    for child in rec.children {
        children.push(take_node(records, child)?);
    }
    Some(TypeTreeNode {
        level: rec.level,
        type_name: rec.type_name,
        name: rec.name,
        byte_size: rec.byte_size,
        index: rec.index,
        meta_flag: rec.meta_flag,
        version: rec.version,
        flags: rec.flags,
        ref_type_hash: rec.ref_type_hash,
        children,
    })
}

/// Курсор по байтам (порт `ByteReader` из `binary.mts`).
///
/// Все чтения — проверяемые: выход за границы даёт `None` (в эталоне исключение,
/// которое `read_object` превращает в `read_failed`), паник нет.
struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
    endian: Endian,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8], endian: Endian) -> Self {
        Self {
            data,
            pos: 0,
            endian,
        }
    }

    fn pos(&self) -> usize {
        self.pos
    }

    /// Остаток как знаковое число: после выравнивания позиция может уехать за
    /// конец, и остаток обязан стать отрицательным (как в эталоне).
    fn remaining(&self) -> i64 {
        self.data.len() as i64 - self.pos as i64
    }

    fn take<const N: usize>(&mut self) -> Option<[u8; N]> {
        let end = self.pos.checked_add(N)?;
        if end > self.data.len() {
            return None;
        }
        let mut out = [0u8; N];
        out.copy_from_slice(&self.data[self.pos..end]);
        self.pos = end;
        Some(out)
    }

    fn u8(&mut self) -> Option<u8> {
        self.take::<1>().map(|b| b[0])
    }

    fn i8(&mut self) -> Option<i8> {
        self.u8().map(|v| v as i8)
    }

    fn u16(&mut self) -> Option<u16> {
        match self.endian {
            Endian::Le => self.take::<2>().map(u16::from_le_bytes),
            Endian::Be => self.take::<2>().map(u16::from_be_bytes),
        }
    }

    fn i16(&mut self) -> Option<i16> {
        match self.endian {
            Endian::Le => self.take::<2>().map(i16::from_le_bytes),
            Endian::Be => self.take::<2>().map(i16::from_be_bytes),
        }
    }

    fn u32(&mut self) -> Option<u32> {
        match self.endian {
            Endian::Le => self.take::<4>().map(u32::from_le_bytes),
            Endian::Be => self.take::<4>().map(u32::from_be_bytes),
        }
    }

    fn i32(&mut self) -> Option<i32> {
        match self.endian {
            Endian::Le => self.take::<4>().map(i32::from_le_bytes),
            Endian::Be => self.take::<4>().map(i32::from_be_bytes),
        }
    }

    fn u64(&mut self) -> Option<u64> {
        match self.endian {
            Endian::Le => self.take::<8>().map(u64::from_le_bytes),
            Endian::Be => self.take::<8>().map(u64::from_be_bytes),
        }
    }

    fn i64(&mut self) -> Option<i64> {
        match self.endian {
            Endian::Le => self.take::<8>().map(i64::from_le_bytes),
            Endian::Be => self.take::<8>().map(i64::from_be_bytes),
        }
    }

    fn f32(&mut self) -> Option<f32> {
        self.u32().map(f32::from_bits)
    }

    fn f64(&mut self) -> Option<f64> {
        self.u64().map(f64::from_bits)
    }

    fn bytes(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.pos.checked_add(n)?;
        if end > self.data.len() {
            return None;
        }
        let out = &self.data[self.pos..end];
        self.pos = end;
        Some(out)
    }

    /// Выравнивание позиции вперёд (границы не проверяются, как в эталоне).
    fn align(&mut self, alignment: usize) {
        let rem = self.pos % alignment;
        if rem != 0 {
            self.pos += alignment - rem;
        }
    }
}

/// Примитив, читаемый одним значением (без строк и TypelessData).
#[derive(Clone, Copy)]
enum Elem {
    I8,
    U8,
    I16,
    U16,
    I32,
    U32,
    I64,
    U64,
    F32,
    F64,
    Bool,
}

/// Вид примитива при обычном чтении (не массив).
fn primitive_elem_kind(t: &str) -> Option<Elem> {
    Some(match t {
        "SInt8" => Elem::I8,
        "UInt8" | "char" => Elem::U8,
        "short" | "SInt16" => Elem::I16,
        "unsigned short" | "UInt16" => Elem::U16,
        "int" | "SInt32" => Elem::I32,
        "unsigned int" | "UInt32" | "Type*" => Elem::U32,
        "long long" | "SInt64" => Elem::I64,
        "unsigned long long" | "UInt64" | "FileSize" => Elem::U64,
        "float" => Elem::F32,
        "double" => Elem::F64,
        "bool" => Elem::Bool,
        _ => return None,
    })
}

/// Вид элемента массива. Здесь сохранена ПЕРЕКРЁСТНАЯ схема эталона:
/// `short`/`SInt16` читаются как u16, а `UInt16`/`unsigned short` — как i16.
fn array_elem_kind(t: &str) -> Option<Elem> {
    Some(match t {
        "SInt8" => Elem::I8,
        "UInt8" | "char" => Elem::U8,
        "short" | "SInt16" => Elem::U16,
        "unsigned short" | "UInt16" => Elem::I16,
        "int" | "SInt32" => Elem::I32,
        "unsigned int" | "UInt32" | "Type*" => Elem::U32,
        "long long" | "SInt64" => Elem::I64,
        "unsigned long long" | "UInt64" | "FileSize" => Elem::U64,
        "float" => Elem::F32,
        "double" => Elem::F64,
        "bool" => Elem::Bool,
        _ => return None,
    })
}

fn read_elem(kind: Elem, r: &mut Reader<'_>) -> Option<Val> {
    Some(match kind {
        Elem::I8 => Val::I64(r.i8()? as i64),
        Elem::U8 => Val::U64(r.u8()? as u64),
        Elem::I16 => Val::I64(r.i16()? as i64),
        Elem::U16 => Val::U64(r.u16()? as u64),
        Elem::I32 => Val::I64(r.i32()? as i64),
        Elem::U32 => Val::U64(r.u32()? as u64),
        Elem::I64 => Val::I64(r.i64()?),
        Elem::U64 => Val::U64(r.u64()?),
        Elem::F32 => Val::F64(r.f32()? as f64),
        Elem::F64 => Val::F64(r.f64()?),
        Elem::Bool => Val::Bool(r.u8()? != 0),
    })
}

/// Есть ли примитив для такого имени типа (иначе — составной узел).
fn is_primitive(t: &str) -> bool {
    matches!(
        t,
        "SInt8"
            | "UInt8"
            | "char"
            | "short"
            | "SInt16"
            | "unsigned short"
            | "UInt16"
            | "int"
            | "SInt32"
            | "unsigned int"
            | "UInt32"
            | "Type*"
            | "long long"
            | "SInt64"
            | "unsigned long long"
            | "UInt64"
            | "FileSize"
            | "float"
            | "double"
            | "bool"
            | "string"
            | "TypelessData"
    )
}

/// Примитив по имени узла. `TypelessData` даёт `Val::Null`: сырые байты в JSONL
/// не попадают, но поток сдвигается ровно как в эталоне.
fn read_primitive(t: &str, r: &mut Reader<'_>) -> Option<Val> {
    match t {
        "string" => {
            // read_aligned_string: при length <= 0 выравнивание НЕ применяется.
            let length = r.i32()?;
            if length > 0 && (length as i64) <= r.remaining() {
                let raw = r.bytes(length as usize)?;
                let s = String::from_utf8_lossy(raw).into_owned();
                r.align(4);
                Some(Val::Str(s))
            } else {
                Some(Val::Str(String::new()))
            }
        }
        "TypelessData" => {
            let size = r.i32()?;
            if size > 0 && (size as i64) <= r.remaining() {
                r.bytes(size as usize)?;
            }
            Some(Val::Null)
        }
        _ => read_elem(primitive_elem_kind(t)?, r),
    }
}

/// Закрыть чтение массива: выравнивание по `meta_flag` самого элемента.
fn finish_array(node: &TypeTreeNode, r: &mut Reader<'_>, out: Vec<Val>) -> Vec<Val> {
    if is_aligned(node.meta_flag) {
        r.align(4);
    }
    out
}

/// Прочитать массив `size` элементов узла `node` (порт `readValueArray`).
fn read_value_array(node: &TypeTreeNode, r: &mut Reader<'_>, size: i32) -> Option<Vec<Val>> {
    let t = node.type_name.as_str();
    let mut out: Vec<Val> = Vec::new();

    if let Some(kind) = array_elem_kind(t) {
        for _ in 0..size {
            out.push(read_elem(kind, r)?);
        }
        return Some(finish_array(node, r, out));
    }

    match t {
        "string" => {
            for _ in 0..size {
                let length = r.i32()?;
                if length > 0 && (length as i64) <= r.remaining() {
                    let raw = r.bytes(length as usize)?;
                    out.push(Val::Str(String::from_utf8_lossy(raw).into_owned()));
                    r.align(4);
                } else {
                    out.push(Val::Str(String::new()));
                }
            }
            return Some(finish_array(node, r, out));
        }
        // Эталон читает здесь массив байт без длины — на практике не встречается.
        "TypelessData" | "ReferencedObject" => return None,
        "pair" => {
            let key_node = node.children.first()?;
            let value_node = node.children.get(1)?;
            for _ in 0..size {
                let key = read_value(key_node, r)?;
                let value = read_value(value_node, r)?;
                out.push(Val::Arr(vec![key, value]));
            }
            return Some(finish_array(node, r, out));
        }
        _ => {}
    }

    if !node.children.is_empty() && node.children[0].type_name == "Array" {
        let container = &node.children[0];
        let subtype = container.children.get(1)?;
        if is_aligned(subtype.meta_flag) {
            for _ in 0..size {
                let count = r.i32()?;
                out.push(Val::Arr(read_value_array(subtype, r, count)?));
            }
        } else {
            for _ in 0..size {
                let count = r.i32()?;
                let mut inner: Vec<Val> = Vec::new();
                for _ in 0..count {
                    inner.push(read_value(subtype, r)?);
                }
                out.push(Val::Arr(inner));
            }
        }
        return Some(finish_array(node, r, out));
    }

    for _ in 0..size {
        let mut obj: Vec<(String, Val)> = Vec::with_capacity(node.children.len());
        for child in &node.children {
            obj.push((child.name.clone(), read_value(child, r)?));
        }
        out.push(Val::Obj(obj));
    }
    Some(finish_array(node, r, out))
}

/// Прочитать значение по узлу type tree (порт `read_value`, `as_dict=True`).
fn read_value(node: &TypeTreeNode, r: &mut Reader<'_>) -> Option<Val> {
    let mut align = is_aligned(node.meta_flag);
    let value = if is_primitive(&node.type_name) {
        read_primitive(&node.type_name, r)?
    } else if node.type_name == "pair" {
        let key_node = node.children.first()?;
        let value_node = node.children.get(1)?;
        Val::Arr(vec![read_value(key_node, r)?, read_value(value_node, r)?])
    } else if node.type_name == "ReferencedObject" {
        return None;
    } else if !node.children.is_empty() && node.children[0].type_name == "Array" {
        let container = &node.children[0];
        if is_aligned(container.meta_flag) {
            align = true;
        }
        let size = r.i32()?;
        if size < 0 {
            return None;
        }
        let subtype = container.children.get(1)?;
        if is_aligned(subtype.meta_flag) {
            Val::Arr(read_value_array(subtype, r, size)?)
        } else {
            let mut out: Vec<Val> = Vec::new();
            for _ in 0..size {
                out.push(read_value(subtype, r)?);
            }
            Val::Arr(out)
        }
    } else {
        let mut obj: Vec<(String, Val)> = Vec::with_capacity(node.children.len());
        for child in &node.children {
            obj.push((child.name.clone(), read_value(child, r)?));
        }
        Val::Obj(obj)
    };

    if align {
        r.align(4);
    }
    Some(value)
}

/// Прочитать объект целиком.
///
/// `None` — ошибка чтения, не-объект в корне или позиция после чтения не равна
/// длине `raw` (ровно как `readObjectTypetree`: иначе это `read_failed`).
pub fn read_object(root: &TypeTreeNode, raw: &[u8], endian: Endian) -> Option<Vec<(String, Val)>> {
    let mut r = Reader::new(raw, endian);
    let value = read_value(root, &mut r)?;
    if r.pos() != raw.len() {
        return None;
    }
    match value {
        Val::Obj(fields) => Some(fields),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Смещение имени в таблице общих строк (для сборки тестовых blob'ов).
    fn common_offset(name: &str) -> u32 {
        let mut cur: u32 = 0;
        for s in COMMON_STRING_LIST {
            if *s == name {
                return cur;
            }
            cur += s.len() as u32 + 1;
        }
        panic!("нет имени {name} в таблице общих строк");
    }

    /// Смещение в таблице с выставленным старшим битом.
    fn common_ref(name: &str) -> u32 {
        0x8000_0000 | common_offset(name)
    }

    /// Дописать узел (32 байта) в blob.
    #[allow(clippy::too_many_arguments)]
    fn push_node(
        blob: &mut Vec<u8>,
        endian: Endian,
        version: u16,
        level: u8,
        flags: u8,
        type_off: u32,
        name_off: u32,
        byte_size: i32,
        index: i32,
        meta_flag: i32,
        ref_type_hash: u64,
    ) {
        let start = blob.len();
        blob.resize(start + NODE_SIZE, 0);
        let put = |blob: &mut Vec<u8>, off: usize, raw: &[u8]| {
            blob[off..off + raw.len()].copy_from_slice(raw);
        };
        match endian {
            Endian::Le => {
                put(blob, start, &version.to_le_bytes());
                put(blob, start + 4, &type_off.to_le_bytes());
                put(blob, start + 8, &name_off.to_le_bytes());
                put(blob, start + 12, &byte_size.to_le_bytes());
                put(blob, start + 16, &index.to_le_bytes());
                put(blob, start + 20, &meta_flag.to_le_bytes());
                put(blob, start + 24, &ref_type_hash.to_le_bytes());
            }
            Endian::Be => {
                put(blob, start, &version.to_be_bytes());
                put(blob, start + 4, &type_off.to_be_bytes());
                put(blob, start + 8, &name_off.to_be_bytes());
                put(blob, start + 12, &byte_size.to_be_bytes());
                put(blob, start + 16, &index.to_be_bytes());
                put(blob, start + 20, &meta_flag.to_be_bytes());
                put(blob, start + 24, &ref_type_hash.to_be_bytes());
            }
        }
        blob[start + 2] = level;
        blob[start + 3] = flags;
    }

    fn leaf(level: i32, ty: &str, name: &str, meta: i32) -> TypeTreeNode {
        TypeTreeNode {
            level,
            type_name: ty.to_string(),
            name: name.to_string(),
            byte_size: -1,
            index: 0,
            meta_flag: meta,
            version: 22,
            flags: 0,
            ref_type_hash: 0,
            children: Vec::new(),
        }
    }

    #[test]
    fn common_string_table_has_112_names() {
        assert_eq!(COMMON_STRING_LIST.len(), 112);
        assert_eq!(common_string(0), Some("AABB"));
        assert_eq!(common_string(common_offset("m_Name")), Some("m_Name"));
        assert_eq!(common_string(common_offset("EntityId")), Some("EntityId"));
        // Неизвестное смещение таблицы — не имя.
        assert_eq!(common_string(u32::MAX), None);
    }

    #[test]
    fn parses_single_node_from_common_strings() {
        let mut blob: Vec<u8> = Vec::new();
        push_node(
            &mut blob,
            Endian::Le,
            22,
            0,
            0,
            common_ref("AABB"),
            common_ref("m_Name"),
            4,
            7,
            0,
            0,
        );
        // Строковый буфер пуст: имена берутся из таблицы.
        let root = parse_type_tree(&blob, 1, Endian::Le).expect("дерево разобрано");
        assert_eq!(root.level, 0);
        assert_eq!(root.type_name, "AABB");
        assert_eq!(root.name, "m_Name");
        assert_eq!(root.byte_size, 4);
        assert_eq!(root.index, 7);
        assert_eq!(root.version, 22);
        assert_eq!(root.flags, 0);
        assert_eq!(root.ref_type_hash, 0);
        assert!(root.children.is_empty());

        // Неизвестное смещение таблицы печатается десятичным числом.
        let mut blob2: Vec<u8> = Vec::new();
        push_node(
            &mut blob2,
            Endian::Le,
            22,
            0,
            0,
            0x8000_0000 | 99_999,
            0x8000_0000 | 99_999,
            0,
            0,
            0,
            0,
        );
        let root2 = parse_type_tree(&blob2, 1, Endian::Le).expect("дерево разобрано");
        assert_eq!(root2.type_name, "99999");
        assert_eq!(root2.name, "99999");
    }

    #[test]
    fn parses_string_buffer_and_hierarchy() {
        // Четыре узла: root(0) -> a(1) -> a1(2), root -> b(1).
        let mut blob: Vec<u8> = Vec::new();
        let type_off = 0u32; // "Root\0"
        let name_off = 5u32; // "root\0"
        push_node(
            &mut blob,
            Endian::Le,
            22,
            0,
            0,
            type_off,
            name_off,
            0,
            0,
            0,
            0,
        );
        push_node(&mut blob, Endian::Le, 22, 1, 0, 10, 16, 0, 1, 0, 0);
        push_node(&mut blob, Endian::Le, 22, 2, 0, 10, 16, 0, 2, 0, 0);
        push_node(&mut blob, Endian::Le, 22, 1, 0, 10, 18, 0, 3, 0, 0);
        // Строковый буфер: "Root\0root\0Child\0a\0b\0" — смещения 0/5/10/16/18.
        blob.extend_from_slice(b"Root\0root\0Child\0a\0b\0");

        let root = parse_type_tree(&blob, 4, Endian::Le).expect("дерево разобрано");
        assert_eq!(root.type_name, "Root");
        assert_eq!(root.name, "root");
        assert_eq!(root.children.len(), 2);
        assert_eq!(root.children[0].type_name, "Child");
        assert_eq!(root.children[0].name, "a");
        assert_eq!(root.children[0].children.len(), 1);
        assert_eq!(root.children[0].children[0].name, "a");
        assert_eq!(root.children[1].name, "b");
        assert!(root.children[1].children.is_empty());
    }

    #[test]
    fn parse_is_endian_aware() {
        let mut blob: Vec<u8> = Vec::new();
        push_node(
            &mut blob,
            Endian::Be,
            22,
            0,
            0,
            common_ref("int"),
            common_ref("m_Index"),
            0x0102_0304,
            0x0506_0708,
            0,
            0x0102_0304_0506_0708,
        );
        let root = parse_type_tree(&blob, 1, Endian::Be).expect("дерево разобрано");
        assert_eq!(root.byte_size, 0x0102_0304);
        assert_eq!(root.index, 0x0506_0708);
        assert_eq!(root.ref_type_hash, 0x0102_0304_0506_0708);
    }

    #[test]
    fn reads_primitives_with_alignment() {
        // root: [string s, UInt8 flag(meta 0x4000), int v]
        let mut root = leaf(0, "Base", "root", 0);
        root.children = vec![
            leaf(1, "string", "s", 0),
            leaf(1, "UInt8", "flag", ALIGNED_FLAG),
            leaf(1, "int", "v", 0),
        ];

        // "abc" -> len(4)+3 = 7, внутренний align -> 8; u8 -> 9, meta align -> 12; int -> 16.
        let mut raw: Vec<u8> = Vec::new();
        raw.extend_from_slice(&3i32.to_le_bytes());
        raw.extend_from_slice(b"abc");
        raw.push(0); // паддинг до 8
        raw.push(1); // flag
        raw.extend_from_slice(&[0, 0, 0]); // паддинг до 12
        raw.extend_from_slice(&42i32.to_le_bytes());
        assert_eq!(raw.len(), 16);

        let obj = read_object(&root, &raw, Endian::Le).expect("объект прочитан");
        assert_eq!(
            obj,
            vec![
                ("s".to_string(), Val::Str("abc".to_string())),
                ("flag".to_string(), Val::U64(1)),
                ("v".to_string(), Val::I64(42)),
            ]
        );
    }

    /// root: [int id, Array arr(subtype)]
    fn array_tree(elem_type: &str) -> TypeTreeNode {
        let mut root = leaf(0, "Base", "root", 0);

        let mut container = leaf(2, "Array", "Array", ALIGNED_FLAG);
        container.children = vec![
            leaf(3, "int", "size", 0),
            leaf(3, elem_type, "data", ALIGNED_FLAG),
        ];
        let mut field = leaf(1, "Array", "arr", ALIGNED_FLAG);
        field.children = vec![container, leaf(2, elem_type, "data", ALIGNED_FLAG)];

        root.children = vec![leaf(1, "int", "id", 0), field];
        root
    }

    #[test]
    fn short_array_reads_as_u16() {
        let root = array_tree("short");
        let mut raw: Vec<u8> = Vec::new();
        raw.extend_from_slice(&7i32.to_le_bytes()); // id
        raw.extend_from_slice(&2i32.to_le_bytes()); // size
        raw.extend_from_slice(&1u16.to_le_bytes());
        raw.extend_from_slice(&65535u16.to_le_bytes());
        assert_eq!(raw.len(), 12);

        let obj = read_object(&root, &raw, Endian::Le).expect("объект прочитан");
        assert_eq!(
            obj,
            vec![
                ("id".to_string(), Val::I64(7)),
                (
                    "arr".to_string(),
                    Val::Arr(vec![Val::U64(1), Val::U64(65535)])
                ),
            ]
        );
    }

    #[test]
    fn unsigned_short_array_reads_as_i16() {
        let root = array_tree("unsigned short");
        let mut raw: Vec<u8> = Vec::new();
        raw.extend_from_slice(&7i32.to_le_bytes());
        raw.extend_from_slice(&2i32.to_le_bytes());
        raw.extend_from_slice(&1u16.to_le_bytes());
        raw.extend_from_slice(&65535u16.to_le_bytes());

        // Перекрёстное чтение: 0xFFFF как i16 = -1.
        let obj = read_object(&root, &raw, Endian::Le).expect("объект прочитан");
        assert_eq!(
            obj,
            vec![
                ("id".to_string(), Val::I64(7)),
                ("arr".to_string(), Val::Arr(vec![Val::I64(1), Val::I64(-1)])),
            ]
        );
    }

    #[test]
    fn negative_array_length_fails() {
        let root = array_tree("short");
        let mut raw: Vec<u8> = Vec::new();
        raw.extend_from_slice(&7i32.to_le_bytes());
        raw.extend_from_slice(&(-1i32).to_le_bytes());
        assert_eq!(read_object(&root, &raw, Endian::Le), None);
    }

    #[test]
    fn leftover_bytes_after_read_fail() {
        let mut root = leaf(0, "Base", "root", 0);
        root.children = vec![leaf(1, "int", "v", 0)];

        let mut raw: Vec<u8> = Vec::new();
        raw.extend_from_slice(&5i32.to_le_bytes());
        raw.extend_from_slice(&[0, 0, 0, 0]); // лишние 4 байта
        assert_eq!(read_object(&root, &raw, Endian::Le), None);

        // Ровно те же данные без хвоста читаются.
        assert!(read_object(&root, &raw[..4], Endian::Le).is_some());
    }

    #[test]
    fn truncated_data_fails_instead_of_panicking() {
        let mut root = leaf(0, "Base", "root", 0);
        root.children = vec![leaf(1, "int", "v", 0)];
        assert_eq!(read_object(&root, &[1, 2], Endian::Le), None);
    }
}
