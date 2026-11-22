/**
 * typetree.mts — type tree Unity из SerializedFile и его generic-чтение.
 *
 * В `*.assets` игры typetree ВЫКЛЮЧЕН, а в бандлах — включён (проверено на
 * 107/107: typeTreeEnabled=true). Поэтому для бандлов можно разобрать объект
 * целиком «как в UnityPy», без ручных схем классов: каждый объект несёт своё
 * описание полей. Именно отсюда берутся `strings`, `fields` и `fsm_strings`
 * (PlayMaker-строки живут в бандлах сцен).
 *
 * Алгоритм — порт `UnityPy.helpers.TypeTreeHelper` в режиме `as_dict=True`:
 * те же узлы, те же выравнивания, те же причуды (например, массивы шортов
 * и ushort читаются «перекрёстно», потому что так в эталоне).
 *
 * `ReferencedObject` (ManagedReferencesRegistry) не поддержан осознанно:
 * он требует ref-типов из файла, а в нашей игре не встречается. Если
 * встретится — бросаем ошибку, объект получает `read_failed`, как у Python
 * при неразрешимой ссылке.
 */

import { ByteReader, type Endian } from "./binary.mts";
import type { TypeTreeInfo } from "./serialized.mts";

/** Таблица «общих строк» Unity (112 имён) — общая для всех сборок.
 *
 * Источник: TPK common-strings (AssetsTools.NET), который UnityPy 1.25.0
 * держит в `resources/lzma.tpk`. Смещения кумулятивные: строка идёт через
 * NUL, поэтому индекс в массиве + длина дают следующее смещение. Данные,
 * не код: без таблицы имена узлов с флагом 0x80000000 не раскодировать.
 */
const COMMON_STRING_LIST = [
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
] as const;

/** offset → строка (индекс считается один раз). */
const COMMON_STRINGS: Map<number, string> = (() => {
  const map = new Map<number, string>();
  let offset = 0;
  for (const s of COMMON_STRING_LIST) {
    map.set(offset, s);
    offset += s.length + 1;
  }
  return map;
})();

/** Маркер узла type tree. `metaFlag & 0x4000` — выравнивание до 4 байт. */
export interface TypeTreeNode {
  level: number;
  type: string;
  name: string;
  byteSize: number;
  index: number;
  metaFlag: number;
  version: number;
  flags: number;
  refTypeHash: bigint;
  children: TypeTreeNode[];
}

const ALIGNED_FLAG = 0x4000;

function isAligned(metaFlag: number): boolean {
  return (metaFlag & ALIGNED_FLAG) !== 0;
}

/**
 * Разобрать type tree из blob SerializedFile.
 *
 * Узлы идут подряд (32 байта на v22), имена — либо в строковом буфере, либо
 * в таблице общих строк (старший бит смещения).
 */
export function parseTypeTree(data: Uint8Array, info: TypeTreeInfo, endian: Endian): TypeTreeNode {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const nodeSize = 32;
  const stringStart = info.blobStart + info.nodeCount * nodeSize;
  const stringEnd = info.blobEnd;
  const readCString = (offset: number): string => {
    const start = stringStart + offset;
    if (start < 0 || start >= stringEnd) return "";
    let end = start;
    while (end < stringEnd && data[end] !== 0) end += 1;
    return new TextDecoder().decode(data.subarray(start, end));
  };
  const readName = (raw: number): string => {
    if ((raw & 0x80000000) === 0) return readCString(raw);
    const offset = raw & 0x7fffffff;
    return COMMON_STRINGS.get(offset) ?? String(offset);
  };

  const nodes: TypeTreeNode[] = [];
  for (let i = 0; i < info.nodeCount; i++) {
    const off = info.blobStart + i * nodeSize;
    const version = view.getUint16(off, endian === "le");
    const level = data[off + 2];
    const flags = data[off + 3];
    const typeStrOffset = view.getUint32(off + 4, endian === "le");
    const nameStrOffset = view.getUint32(off + 8, endian === "le");
    const byteSize = view.getInt32(off + 12, endian === "le");
    const index = view.getInt32(off + 16, endian === "le");
    const metaFlag = view.getInt32(off + 20, endian === "le");
    const refTypeHash = view.getBigUint64(off + 24, endian === "le");
    nodes.push({
      level,
      type: readName(typeStrOffset),
      name: readName(nameStrOffset),
      byteSize,
      index,
      metaFlag,
      version,
      flags,
      refTypeHash,
      children: [],
    });
  }

  const fakeRoot: TypeTreeNode = {
    level: -1,
    type: "",
    name: "",
    byteSize: 0,
    index: 0,
    metaFlag: 0,
    version: 0,
    flags: 0,
    refTypeHash: 0n,
    children: [],
  };
  const stack: TypeTreeNode[] = [fakeRoot];
  let parent = fakeRoot;
  let prev = fakeRoot;
  for (const node of nodes) {
    if (node.level > prev.level) {
      stack.push(parent);
      parent = prev;
    } else if (node.level < prev.level) {
      while (node.level <= parent.level) {
        const popped = stack.pop();
        if (!popped) throw new Error("typetree: битая иерархия узлов");
        parent = popped;
      }
    }
    parent.children.push(node);
    prev = node;
  }
  const root = fakeRoot.children[0];
  if (!root) throw new Error("typetree: пустое дерево");
  return root;
}

/** Плавающее число: нужно, чтобы JSONL печатал его как Python (`60.0`). */
export class PyFloat {
  readonly value: number;

  constructor(value: number) {
    this.value = value;
  }

  toString(): string {
    return String(this.value);
  }
}

/** Сырые байты (TypelessData / byte-массив): в JSONL не попадают, только чтение. */
export class RawBytes {
  readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
}

/** Ошибка неподдержанного узла (объект уйдёт в `read_failed`). */
export class UnsupportedTypetree extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedTypetree";
  }
}

function readPrimitive(type: string, r: ByteReader): unknown {
  switch (type) {
    case "SInt8":
      return r.i8();
    case "UInt8":
    case "char":
      return r.u8();
    case "short":
    case "SInt16":
      return r.i16();
    case "unsigned short":
    case "UInt16":
      return r.u16();
    case "int":
    case "SInt32":
      return r.i32();
    case "unsigned int":
    case "UInt32":
    case "Type*":
      return r.u32();
    case "long long":
    case "SInt64":
      return r.i64();
    case "unsigned long long":
    case "UInt64":
    case "FileSize":
      return r.u64();
    case "float":
      return new PyFloat(r.f32());
    case "double":
      return new PyFloat(r.f64());
    case "bool":
      return r.u8() !== 0;
    case "string": {
      // read_aligned_string: при length <= 0 выравнивание НЕ применяется.
      const length = r.i32();
      if (length > 0 && length <= r.remaining) {
        const raw = r.bytes(length);
        r.align(4);
        return new TextDecoder("utf-8", { fatal: false }).decode(raw);
      }
      return "";
    }
    case "TypelessData": {
      const size = r.i32();
      return new RawBytes(size > 0 && size <= r.remaining ? r.bytes(size) : new Uint8Array(0));
    }
    default:
      return undefined;
  }
}

/** Есть ли примитив для такого имени типа (иначе — составной узел). */
function isPrimitive(type: string): boolean {
  return PRIMITIVES.has(type);
}

const PRIMITIVES = new Set([
  "SInt8",
  "UInt8",
  "char",
  "short",
  "SInt16",
  "unsigned short",
  "UInt16",
  "int",
  "SInt32",
  "unsigned int",
  "UInt32",
  "Type*",
  "long long",
  "SInt64",
  "unsigned long long",
  "UInt64",
  "FileSize",
  "float",
  "double",
  "bool",
  "string",
  "TypelessData",
]);

function readValueArray(node: TypeTreeNode, r: ByteReader, size: number): unknown[] {
  const type = node.type;
  const out: unknown[] = [];
  const finish = (): unknown[] => {
    // Эталон выравнивает поток в конце array-чтения по metaFlag самого элемента.
    if (isAligned(node.metaFlag)) r.align(4);
    return out;
  };
  switch (type) {
    case "SInt8":
      for (let i = 0; i < size; i++) out.push(r.i8());
      return finish();
    case "UInt8":
    case "char":
      for (let i = 0; i < size; i++) out.push(r.u8());
      return finish();
    case "short":
      for (let i = 0; i < size; i++) out.push(r.u16());
      return finish();
    case "UInt16":
      for (let i = 0; i < size; i++) out.push(r.i16());
      return finish();
    case "unsigned short":
      for (let i = 0; i < size; i++) out.push(r.i16());
      return finish();
    case "SInt16":
      for (let i = 0; i < size; i++) out.push(r.u16());
      return finish();
    case "int":
    case "SInt32":
      for (let i = 0; i < size; i++) out.push(r.i32());
      return finish();
    case "unsigned int":
    case "UInt32":
    case "Type*":
      for (let i = 0; i < size; i++) out.push(r.u32());
      return finish();
    case "long long":
    case "SInt64":
      for (let i = 0; i < size; i++) out.push(r.i64());
      return finish();
    case "unsigned long long":
    case "UInt64":
    case "FileSize":
      for (let i = 0; i < size; i++) out.push(r.u64());
      return finish();
    case "float":
      for (let i = 0; i < size; i++) out.push(new PyFloat(r.f32()));
      return finish();
    case "double":
      for (let i = 0; i < size; i++) out.push(new PyFloat(r.f64()));
      return finish();
    case "bool":
      for (let i = 0; i < size; i++) out.push(r.u8() !== 0);
      return finish();
    case "string":
      for (let i = 0; i < size; i++) {
        const length = r.i32();
        if (length > 0 && length <= r.remaining) {
          out.push(new TextDecoder().decode(r.bytes(length)));
          r.align(4);
        } else {
          out.push("");
        }
      }
      return finish();
    default:
      break;
  }

  if (type === "TypelessData") {
    // Эталон читает здесь массив байт без длины — на практике не встречается.
    throw new UnsupportedTypetree("TypelessData[]");
  }
  if (type === "pair") {
    const keyNode = node.children[0];
    const valueNode = node.children[1];
    for (let i = 0; i < size; i++) {
      out.push([readValue(keyNode, r), readValue(valueNode, r)]);
    }
    return finish();
  }
  if (type === "ReferencedObject") {
    throw new UnsupportedTypetree("ReferencedObject[]");
  }
  if (node.children.length > 0 && node.children[0].type === "Array") {
    const container = node.children[0];
    const subtype = container.children[1];
    if (isAligned(subtype.metaFlag)) {
      for (let i = 0; i < size; i++) out.push(readValueArray(subtype, r, r.i32()));
    } else {
      for (let i = 0; i < size; i++) {
        const count = r.i32();
        const inner: unknown[] = [];
        for (let k = 0; k < count; k++) inner.push(readValue(subtype, r));
        out.push(inner);
      }
    }
    return finish();
  }

  for (let i = 0; i < size; i++) {
    const item: Record<string, unknown> = {};
    for (const child of node.children) item[child.name] = readValue(child, r);
    out.push(item);
  }
  return finish();
}

/** Прочитать значение по узлу type tree (порт `read_value`, `as_dict=True`). */
export function readValue(node: TypeTreeNode, r: ByteReader): unknown {
  let align = isAligned(node.metaFlag);
  let value: unknown;

  if (isPrimitive(node.type)) {
    value = readPrimitive(node.type, r);
  } else if (node.type === "pair") {
    value = [readValue(node.children[0], r), readValue(node.children[1], r)];
  } else if (node.type === "ReferencedObject") {
    throw new UnsupportedTypetree("ReferencedObject");
  } else if (node.children.length > 0 && node.children[0].type === "Array") {
    const container = node.children[0];
    if (isAligned(container.metaFlag)) align = true;
    const size = r.i32();
    if (size < 0) throw new UnsupportedTypetree("отрицательная длина массива");
    const subtype = container.children[1];
    value = isAligned(subtype.metaFlag)
      ? readValueArray(subtype, r, size)
      : Array.from({ length: size }, () => readValue(subtype, r));
  } else {
    const obj: Record<string, unknown> = {};
    for (const child of node.children) obj[child.name] = readValue(child, r);
    value = obj;
  }

  if (align) r.align(4);
  return value;
}

/**
 * Разобрать объект целиком. `null` — typetree нет или чтение не сошлось
 * с размером объекта (у эталона это `read_failed`).
 */
export function readObjectTypetree(
  root: TypeTreeNode,
  raw: Uint8Array,
  endian: Endian,
): Record<string, unknown> | null {
  const r = new ByteReader(raw, { endian });
  try {
    const value = readValue(root, r);
    if (r.pos !== raw.length) return null;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}
