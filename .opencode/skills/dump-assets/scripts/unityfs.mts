/**
 * unityfs.mts — контейнер UnityFS (AssetBundle) на TypeScript.
 *
 * Структура файла:
 *
 *   cstring  signature ("UnityFS")
 *   u32be    formatVersion (обычно 6..8)
 *   cstring  playerVersion ("5.x.x")
 *   cstring  engineVersion ("2022.3.62f3")
 *   i64be    size
 *   u32be    compressedBlocksInfoSize
 *   u32be    uncompressedBlocksInfoSize
 *   u32be    flags (младшие 6 бит — сжатие, 0x40 — blocks+directory вместе,
 *                  0x80 — blocksInfo в конце файла, 0x200 — паддинг до 16)
 *   [выравнивание до 16 при formatVersion >= 7]
 *   blocksInfo (сжатый)
 *   [выравнивание до 16, если выставлен 0x200]
 *   блоки данных (каждый сжат своим флагом)
 *
 * Внутри blocksInfo: hash(16), i32 count, count*(u32 uncompressed, u32
 * compressed, u16 flags), i32 nodeCount, node*(i64 offset, i64 size, u32
 * flags, cstring path). ВСЁ здесь big-endian — контейнер пишется big-endian,
 * хотя содержимое (SerializedFile) уже little-endian. Это главная ловушка
 * формата.
 *
 * Сжатие: 0 — без сжатия, 1 — LZMA, 2/3 — LZ4/LZ4HC (на распаковке один
 * формат). У Third Crisis Neon Nights все бандлы — LZ4HC.
 */

import { BinaryFormatError, ByteReader, i64ToNumber, signature } from "./binary.mts";
import { lz4BlockDecompress } from "./lz4.mts";
import { lzmaRawDecompress } from "./lzma.mts";

export const UNITYFS_SIGNATURE = "UnityFS";

/** Значения младших 6 бит флагов (тип сжатия). */
export const COMPRESSION_NONE = 0;
export const COMPRESSION_LZMA = 1;
export const COMPRESSION_LZ4 = 2;
export const COMPRESSION_LZ4HC = 3;
export const COMPRESSION_TYPE_MASK = 0x3f;

export const FLAG_BLOCKS_AND_DIRECTORY_INFO_COMBINED = 0x40;
export const FLAG_BLOCKS_INFO_AT_END = 0x80;
export const FLAG_OLD_WEB_PLUGIN_COMPATIBILITY = 0x100;
/** Новые бандлы: выравнивание перед блоками данных. Старые: бит шифрования. */
export const FLAG_BLOCK_INFO_NEED_PADDING_AT_START = 0x200;
/** Новые бандлы: биты шифрования. */
export const FLAG_NEW_ENCRYPTION = 0x1400;

export interface UnityFsHeader {
  signature: string;
  formatVersion: number;
  playerVersion: string;
  engineVersion: string;
  size: bigint;
  compressedBlocksInfoSize: number;
  uncompressedBlocksInfoSize: number;
  flags: number;
}

export interface UnityFsBlock {
  uncompressedSize: number;
  compressedSize: number;
  flags: number;
}

export interface UnityFsEntry {
  path: string;
  offset: number;
  size: number;
  flags: number;
}

export interface UnityFsArchive {
  header: UnityFsHeader;
  blocks: UnityFsBlock[];
  entries: UnityFsEntry[];
  /** Распакованные блоки данных, склеенные подряд (сюда смотрят offset'ы). */
  data: Uint8Array;
  /** Данные entry по имени или объекту. */
  readEntry(entry: UnityFsEntry | string): Uint8Array;
}

/** Сигнатура файла — UnityFS? */
export function isUnityFs(data: Uint8Array): boolean {
  return signature(data, 8) === `${UNITYFS_SIGNATURE}\0`;
}

/**
 * Старый набор флагов (до фикса выравнивания; Unity CN и старые версии).
 * Правило скопировано из UnityPy: границы 2020.3.34 / 2021.3.2 / 2022.1.1.
 */
export function usesLegacyArchiveFlags(engineVersion: string): boolean {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(engineVersion);
  if (!m) return true;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3] ?? 0);
  if (major < 2020) return true;
  if (major === 2020) return minor < 3 || (minor === 3 && patch < 34);
  if (major === 2021) return minor < 3 || (minor === 3 && patch < 2);
  if (major === 2022) return minor < 1 || (minor === 1 && patch < 1);
  return false;
}

/** Разжать один блок по его флагам. */
function decompressBlock(
  compressed: Uint8Array,
  uncompressedSize: number,
  flags: number,
): Uint8Array {
  const compression = flags & COMPRESSION_TYPE_MASK;
  switch (compression) {
    case COMPRESSION_NONE:
      if (compressed.length !== uncompressedSize) {
        throw new BinaryFormatError(
          `UnityFS: блок без сжатия имеет размер ${compressed.length}, ожидался ${uncompressedSize}`,
          0,
        );
      }
      return compressed;
    case COMPRESSION_LZ4:
    case COMPRESSION_LZ4HC:
      return lz4BlockDecompress(compressed, uncompressedSize);
    case COMPRESSION_LZMA:
      return lzmaRawDecompress(compressed, uncompressedSize);
    default:
      throw new BinaryFormatError(`UnityFS: неизвестный тип сжатия ${compression}`, 0);
  }
}

/** Разобрать контейнер UnityFS. */
export function readUnityFs(data: Uint8Array): UnityFsArchive {
  const r = new ByteReader(data, { endian: "be" });

  const sig = r.cstring();
  if (sig !== UNITYFS_SIGNATURE) {
    throw new BinaryFormatError(`UnityFS: сигнатура "${sig}", ожидалась "UnityFS"`, 0);
  }
  const formatVersion = r.u32("be");
  const playerVersion = r.cstring();
  const engineVersion = r.cstring();
  const size = r.i64("be");
  const compressedBlocksInfoSize = r.u32("be");
  const uncompressedBlocksInfoSize = r.u32("be");
  const flags = r.u32("be");

  const header: UnityFsHeader = {
    signature: sig,
    formatVersion,
    playerVersion,
    engineVersion,
    size,
    compressedBlocksInfoSize,
    uncompressedBlocksInfoSize,
    flags,
  };

  const legacy = usesLegacyArchiveFlags(engineVersion);
  if (
    legacy
      ? (flags & FLAG_BLOCK_INFO_NEED_PADDING_AT_START) !== 0
      : (flags & FLAG_NEW_ENCRYPTION) !== 0
  ) {
    throw new BinaryFormatError(
      "UnityFS: бандл зашифрован (ArchiveStorage), расшифровка не поддерживается",
      0,
    );
  }

  // Выравнивание после заголовка появилось в formatVersion 7.
  if (formatVersion >= 7) r.align(16);

  // Здесь начинается область данных блоков (после заголовка/выравнивания).
  const dataStart = r.pos;
  const blocksInfoAtEnd = (flags & FLAG_BLOCKS_INFO_AT_END) !== 0;
  const blocksInfoStart = blocksInfoAtEnd ? data.length - compressedBlocksInfoSize : dataStart;
  if (blocksInfoStart < 0) {
    throw new BinaryFormatError("UnityFS: blocksInfo выходит за начало файла", 0);
  }
  r.seek(blocksInfoStart);
  const blocksInfoCompressed = r.bytes(compressedBlocksInfoSize);
  const blocksInfo = decompressBlock(blocksInfoCompressed, uncompressedBlocksInfoSize, flags);

  const br = new ByteReader(blocksInfo, { endian: "be" });
  br.skip(16); // uncompressedDataHash — для распаковки не нужен
  const blockCount = br.i32();
  if (blockCount < 0 || blockCount * 10 > br.remaining) {
    throw new BinaryFormatError(`UnityFS: некорректное число блоков ${blockCount}`, br.pos);
  }
  const blocks: UnityFsBlock[] = [];
  for (let i = 0; i < blockCount; i++) {
    blocks.push({ uncompressedSize: br.u32(), compressedSize: br.u32(), flags: br.u16() });
  }

  const nodeCount = br.i32();
  if (nodeCount < 0 || nodeCount > br.remaining) {
    throw new BinaryFormatError(`UnityFS: некорректное число entry ${nodeCount}`, br.pos);
  }
  const entries: UnityFsEntry[] = [];
  for (let i = 0; i < nodeCount; i++) {
    const offset = i64ToNumber(br.i64(), "UnityFS: offset entry", br.pos);
    const entrySize = i64ToNumber(br.i64(), "UnityFS: размер entry", br.pos);
    const entryFlags = br.u32();
    entries.push({ path: br.cstring(), offset, size: entrySize, flags: entryFlags });
  }

  // Данные блоков начинаются после blocksInfo (+ паддинг в новых бандлах).
  if (blocksInfoAtEnd) r.seek(dataStart);
  else r.seek(blocksInfoStart + compressedBlocksInfoSize);
  if (!legacy && (flags & FLAG_BLOCK_INFO_NEED_PADDING_AT_START) !== 0) r.align(16);

  const parts: Uint8Array[] = [];
  let total = 0;
  for (const block of blocks) {
    const compressed = r.bytes(block.compressedSize);
    const part = decompressBlock(compressed, block.uncompressedSize, block.flags);
    parts.push(part);
    total += part.length;
  }
  const blockData = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    blockData.set(part, at);
    at += part.length;
  }

  const byPath = new Map(entries.map((e) => [e.path, e]));
  const readEntry = (entry: UnityFsEntry | string): Uint8Array => {
    const found = typeof entry === "string" ? byPath.get(entry) : entry;
    if (!found) throw new BinaryFormatError(`UnityFS: entry "${String(entry)}" не найден`, 0);
    if (found.offset + found.size > blockData.length) {
      throw new BinaryFormatError(
        `UnityFS: entry "${found.path}" выходит за данные (${found.offset}+${found.size} > ${blockData.length})`,
        0,
      );
    }
    return blockData.subarray(found.offset, found.offset + found.size);
  };

  return { header, blocks, entries, data: blockData, readEntry };
}
