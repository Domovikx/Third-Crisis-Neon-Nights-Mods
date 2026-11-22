/**
 * serialized.mts — SerializedFile Unity (то, что лежит в *.assets и в
 * бандлах) на TypeScript: заголовок, type table, object table, externals.
 *
 * Формат (версия 22, Unity 2022.3 — наша игра):
 *
 *   legacy-префикс (ВСЕГДА big-endian): u32 metadataSize, u32 fileSize,
 *       u32 version, u32 dataOffset
 *   u8 endian (1 = BE), 3 байта reserved
 *   [version >= 22] u32be metadataSize, i64be fileSize, i64be dataOffset,
 *       i64be unknown
 *   cstring unityVersion
 *   i32 targetPlatform
 *   u8  enableTypeTree
 *   i32 typeCount, типы
 *   i32 objectCount, объекты (path_id, byteStart, byteSize, typeID)
 *   i32 scriptCount, скрипты
 *   i32 externalCount, externals
 *   [version >= 20] i32 refTypeCount, ref-типы
 *   cstring userInformation
 *
 * Остальное содержимое файла — little-endian (у нашей игры endian-флаг = 0).
 *
 * Поддержана ТОЛЬКО версия 22: игра на Unity 2022.3, а legacy-ветки (<22)
 * означали бы непроверенный код. При встрече другой версии — внятная ошибка.
 *
 * Type tree в игре ВЫКЛЮЧЕН (типовые деревья не пишутся), но парсер умеет их
 * пропускать/запоминать: это нужно тестам и будущей стадии 3.
 */

import { BinaryFormatError, ByteReader, i64ToNumber, type Endian } from "./binary.mts";

export const SUPPORTED_VERSION = 22;

export interface TypeTreeInfo {
  nodeCount: number;
  stringBufferSize: number;
  /** Границы blob в файле — стадия 3 возьмёт отсюда имена типов/полей. */
  blobStart: number;
  blobEnd: number;
}

export interface SerializedType {
  classId: number;
  isStrippedType: boolean;
  scriptTypeIndex: number;
  scriptId?: Uint8Array;
  oldTypeHash: Uint8Array;
  typeTree?: TypeTreeInfo;
  typeDependencies?: number[];
  /** Только для ref-типов (version >= 21). */
  className?: string;
  nameSpace?: string;
  assemblyName?: string;
}

export interface SerializedObject {
  /** Может превышать 2^53 — поэтому BigInt, как в Python-дампе. */
  pathId: bigint;
  typeId: number;
  /** ClassID из type table (MonoBehaviour = 114 и т.д.). */
  classId: number;
  /** Абсолютное смещение данных объекта в файле (dataOffset уже прибавлен). */
  byteStart: number;
  byteSize: number;
}

export interface SerializedExternal {
  path: string;
  tempEmpty?: string;
  guid?: Uint8Array;
  type?: number;
}

export interface SerializedScript {
  localFileIndex: number;
  localIdentifier: bigint;
}

export interface SerializedFileHeader {
  metadataSize: number;
  fileSize: number;
  version: number;
  dataOffset: number;
  endian: Endian;
  unityVersion: string;
  targetPlatform: number;
  enableTypeTree: boolean;
  unknown: bigint;
}

export interface SerializedFile {
  header: SerializedFileHeader;
  types: SerializedType[];
  refTypes: SerializedType[];
  objects: SerializedObject[];
  externals: SerializedExternal[];
  scripts: SerializedScript[];
  userInformation: string;
  /** Сырые байты файла: чтение объекта — срез по byteStart/byteSize. */
  raw: Uint8Array;
}

/** Быстрая проверка «это SerializedFile?» без полного разбора (как UnityPy). */
export function isSerializedFile(data: Uint8Array): boolean {
  return peekSerializedHeader(data) !== null;
}

/** Прочитать заголовок для проверки типа; null, если данные не похожи. */
export function peekSerializedHeader(data: Uint8Array): SerializedFileHeader | null {
  if (data.length < 20) return null;
  try {
    const r = new ByteReader(data, { endian: "be" });
    let metadataSize = r.u32("be");
    let fileSize = r.u32("be");
    const version = r.u32("be");
    let dataOffset = r.u32("be");
    let endian: Endian = "le";
    if (version >= 9) {
      endian = r.u8() ? "be" : "le";
      r.skip(3);
      if (version >= 22) {
        metadataSize = r.u32("be");
        fileSize = i64ToNumber(r.i64("be"), "SerializedFile: fileSize", 0);
        dataOffset = i64ToNumber(r.i64("be"), "SerializedFile: dataOffset", 0);
      }
    }
    // Поддерживаем только современную ветку (у игры v22); версии < 9 —
    // почти наверняка сырой ресурс с случайными байтами, а не SerializedFile.
    if (version < 9 || version > 100) return null;
    if (metadataSize > data.length || fileSize > data.length || dataOffset > data.length)
      return null;
    if (fileSize < metadataSize || fileSize < dataOffset) return null;
    return {
      metadataSize,
      fileSize,
      version,
      dataOffset,
      endian,
      unityVersion: "",
      targetPlatform: 0,
      enableTypeTree: false,
      unknown: 0n,
    };
  } catch (err) {
    if (err instanceof BinaryFormatError) return null;
    throw err;
  }
}

/**
 * Разобрать SerializedFile.
 *
 * Читает заголовок и метаданные; данные объектов не трогает (стадия 2:
 * объект читается как сырые байты по `readObjectRaw`).
 */
export function readSerializedFile(data: Uint8Array): SerializedFile {
  const r = new ByteReader(data, { endian: "be" });

  // Legacy-префикс всегда big-endian. Для версии 22 поля здесь нулевые,
  // реальные значения читаются ниже.
  let metadataSize = r.u32("be");
  let fileSize = r.u32("be");
  const version = r.u32("be");
  let dataOffset = r.u32("be");
  let endian: Endian = "le";
  let unknown = 0n;

  if (version >= 9) {
    endian = r.u8() ? "be" : "le";
    r.skip(3); // reserved
    if (version >= 22) {
      metadataSize = r.u32("be");
      fileSize = i64ToNumber(r.i64("be"), "SerializedFile: fileSize", 0);
      dataOffset = i64ToNumber(r.i64("be"), "SerializedFile: dataOffset", 0);
      unknown = r.i64("be");
    } else {
      throw new BinaryFormatError(
        `SerializedFile версии ${version} не поддерживается (игра на ${SUPPORTED_VERSION})`,
        8,
      );
    }
  } else {
    throw new BinaryFormatError(`SerializedFile версии ${version} не поддерживается`, 8);
  }

  if (version > 100) {
    throw new BinaryFormatError(`SerializedFile: неправдоподобная версия ${version}`, 8);
  }
  if (fileSize > data.length) {
    throw new BinaryFormatError(
      `SerializedFile: fileSize ${fileSize} больше файла ${data.length}`,
      r.pos,
    );
  }
  if (dataOffset > data.length) {
    throw new BinaryFormatError(
      `SerializedFile: dataOffset ${dataOffset} больше файла ${data.length}`,
      r.pos,
    );
  }

  r.endian = endian;

  const unityVersion = r.cstring();
  const targetPlatform = r.i32();
  const enableTypeTree = r.u8() !== 0;

  const typeCount = r.i32();
  if (typeCount < 0 || typeCount > 1_000_000) {
    throw new BinaryFormatError(`SerializedFile: некорректное число типов ${typeCount}`, r.pos - 4);
  }
  const types: SerializedType[] = [];
  for (let i = 0; i < typeCount; i++)
    types.push(readSerializedType(r, version, enableTypeTree, false));

  const objectCount = r.i32();
  if (objectCount < 0 || objectCount > data.length) {
    throw new BinaryFormatError(
      `SerializedFile: некорректное число объектов ${objectCount}`,
      r.pos - 4,
    );
  }
  const objects: SerializedObject[] = [];
  for (let i = 0; i < objectCount; i++) {
    const obj = readSerializedObject(r, version, dataOffset, types);
    if (obj.byteStart + obj.byteSize > data.length) {
      throw new BinaryFormatError(
        `SerializedFile: объект ${obj.pathId} выходит за файл (${obj.byteStart}+${obj.byteSize} > ${data.length})`,
        r.pos,
      );
    }
    objects.push(obj);
  }

  const scripts: SerializedScript[] = [];
  if (version >= 11) {
    const scriptCount = r.i32();
    if (scriptCount < 0 || scriptCount > 1_000_000) {
      throw new BinaryFormatError(
        `SerializedFile: некорректное число скриптов ${scriptCount}`,
        r.pos - 4,
      );
    }
    for (let i = 0; i < scriptCount; i++) {
      const localFileIndex = r.i32();
      if (version < 14) {
        scripts.push({ localFileIndex, localIdentifier: BigInt(r.i32()) });
      } else {
        r.align(4);
        scripts.push({ localFileIndex, localIdentifier: r.i64() });
      }
    }
  }

  const externalCount = r.i32();
  if (externalCount < 0 || externalCount > 1_000_000) {
    throw new BinaryFormatError(
      `SerializedFile: некорректное число externals ${externalCount}`,
      r.pos - 4,
    );
  }
  const externals: SerializedExternal[] = [];
  for (let i = 0; i < externalCount; i++) {
    const external: SerializedExternal = { path: "" };
    if (version >= 6) external.tempEmpty = r.cstring();
    if (version >= 5) {
      external.guid = r.bytes(16);
      external.type = r.i32();
    }
    external.path = r.cstring();
    externals.push(external);
  }

  const refTypes: SerializedType[] = [];
  if (version >= 20) {
    const refTypeCount = r.i32();
    if (refTypeCount < 0 || refTypeCount > 1_000_000) {
      throw new BinaryFormatError(
        `SerializedFile: некорректное число ref-типов ${refTypeCount}`,
        r.pos - 4,
      );
    }
    for (let i = 0; i < refTypeCount; i++) {
      refTypes.push(readSerializedType(r, version, enableTypeTree, true));
    }
  }

  const userInformation = version >= 5 ? r.cstring() : "";

  const header: SerializedFileHeader = {
    metadataSize,
    fileSize,
    version,
    dataOffset,
    endian,
    unityVersion,
    targetPlatform,
    enableTypeTree,
    unknown,
  };

  return { header, types, refTypes, objects, externals, scripts, userInformation, raw: data };
}

function readSerializedType(
  r: ByteReader,
  version: number,
  enableTypeTree: boolean,
  isRefType: boolean,
): SerializedType {
  const classId = r.i32();
  const type: SerializedType = {
    classId,
    isStrippedType: false,
    scriptTypeIndex: -1,
    oldTypeHash: new Uint8Array(0),
  };

  if (version >= 16) type.isStrippedType = r.u8() !== 0;
  if (version >= 17) type.scriptTypeIndex = r.i16();

  if (version >= 13) {
    const needsScriptId =
      (isRefType && type.scriptTypeIndex >= 0) ||
      (version < 16 && classId < 0) ||
      (version >= 16 && classId === 114);
    if (needsScriptId) type.scriptId = r.bytes(16);
    type.oldTypeHash = r.bytes(16);
  }

  if (enableTypeTree) {
    const nodeCount = r.i32();
    const stringBufferSize = r.i32();
    // Узел type tree в blob: h(version) B(level) B(flags) I(typeStroffset)
    // I(nameStroffset) i(byteSize) i(index) i(metaFlag) [+Q refTypeHash при v>=19].
    const nodeSize = version >= 19 ? 32 : 24;
    if (nodeCount < 0 || stringBufferSize < 0) {
      throw new BinaryFormatError(
        `SerializedFile: битый type tree (узлов ${nodeCount}, строк ${stringBufferSize})`,
        r.pos - 8,
      );
    }
    const blobStart = r.pos;
    const blobEnd = blobStart + nodeCount * nodeSize + stringBufferSize;
    if (blobEnd > r.length) {
      throw new BinaryFormatError("SerializedFile: type tree выходит за файл", blobStart);
    }
    type.typeTree = { nodeCount, stringBufferSize, blobStart, blobEnd };
    r.seek(blobEnd);

    if (version >= 21) {
      if (isRefType) {
        type.className = r.cstring();
        type.nameSpace = r.cstring();
        type.assemblyName = r.cstring();
      } else {
        const depCount = r.i32();
        if (depCount < 0 || depCount > r.remaining / 4) {
          throw new BinaryFormatError(
            `SerializedFile: некорректные type dependencies ${depCount}`,
            r.pos - 4,
          );
        }
        const deps: number[] = [];
        for (let i = 0; i < depCount; i++) deps.push(r.i32());
        type.typeDependencies = deps;
      }
    }
  }

  return type;
}

function readSerializedObject(
  r: ByteReader,
  version: number,
  dataOffset: number,
  types: SerializedType[],
): SerializedObject {
  // path_id выровнен до 4 (и может быть 64-битным).
  r.align(4);
  const pathId = r.i64();
  const byteStart = i64ToNumber(r.i64(), "SerializedFile: byteStart", r.pos) + dataOffset;
  const byteSize = r.u32();
  const typeId = r.i32();

  if (typeId < 0 || typeId >= types.length) {
    throw new BinaryFormatError(
      `SerializedFile: typeId ${typeId} вне type table (${types.length})`,
      r.pos - 4,
    );
  }
  const classId = types[typeId].classId;

  // Поля древних версий — для полноты формата; в v22 их нет.
  if (version < 16) r.skip(2);
  if (version < 11) r.skip(2);
  if (version >= 11 && version < 17) r.skip(2);
  if (version === 15 || version === 16) r.skip(1);

  return { pathId, typeId, classId, byteStart, byteSize };
}

/** Сырые байты объекта по объекту или path_id. */
export function readObjectRaw(
  file: SerializedFile,
  objectOrPathId: SerializedObject | bigint,
): Uint8Array {
  const obj =
    typeof objectOrPathId === "bigint"
      ? file.objects.find((o) => o.pathId === objectOrPathId)
      : objectOrPathId;
  if (!obj) {
    throw new BinaryFormatError(`SerializedFile: объект ${objectOrPathId} не найден`, 0);
  }
  if (obj.byteStart + obj.byteSize > file.raw.length) {
    throw new BinaryFormatError(
      `SerializedFile: объект ${obj.pathId} выходит за файл (${obj.byteStart}+${obj.byteSize})`,
      0,
    );
  }
  return file.raw.subarray(obj.byteStart, obj.byteStart + obj.byteSize);
}
