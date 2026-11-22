/**
 * helpers.mts — синтетические фикстуры для тестов дампера.
 *
 * ВАЖНО: файлы игры в тесты НЕ кладём (это перераспространение контента).
 * Все фикстуры собираются байтами прямо здесь: контейнер UnityFS и
 * SerializedFile в миниатюре.
 *
 * Вспомогательный `Buf` — растущий писатель LE/BE (в проде не нужен: дампер
 * только читает, поэтому живёт в тестах).
 */

export type TestEndian = "le" | "be";

export class Buf {
  private readonly chunks: number[] = [];
  private readonly scratch = new Uint8Array(8);
  private readonly scratchView = new DataView(this.scratch.buffer);

  get length(): number {
    return this.chunks.length;
  }

  u8(value: number): this {
    this.chunks.push(value & 0xff);
    return this;
  }

  u16(value: number, endian: TestEndian = "le"): this {
    this.scratchView.setUint16(0, value, endian === "le");
    return this.raw(this.scratch.subarray(0, 2));
  }

  u32(value: number, endian: TestEndian = "le"): this {
    this.scratchView.setUint32(0, value, endian === "le");
    return this.raw(this.scratch.subarray(0, 4));
  }

  i32(value: number, endian: TestEndian = "le"): this {
    this.scratchView.setInt32(0, value, endian === "le");
    return this.raw(this.scratch.subarray(0, 4));
  }

  i64(value: bigint, endian: TestEndian = "le"): this {
    this.scratchView.setBigInt64(0, value, endian === "le");
    return this.raw(this.scratch.subarray(0, 8));
  }

  raw(bytes: Uint8Array): this {
    for (const b of bytes) this.chunks.push(b);
    return this;
  }

  cstring(text: string): this {
    for (const b of new TextEncoder().encode(text)) this.chunks.push(b);
    this.chunks.push(0);
    return this;
  }

  align(alignment: number, fill = 0): this {
    while (this.chunks.length % alignment !== 0) this.chunks.push(fill);
    return this;
  }

  patchU32(offset: number, value: number, endian: TestEndian = "le"): void {
    this.scratchView.setUint32(0, value, endian === "le");
    for (let i = 0; i < 4; i++) this.chunks[offset + i] = this.scratch[i];
  }

  patchI64(offset: number, value: bigint, endian: TestEndian = "le"): void {
    this.scratchView.setBigInt64(0, value, endian === "le");
    for (let i = 0; i < 8; i++) this.chunks[offset + i] = this.scratch[i];
  }

  toBytes(): Uint8Array {
    return new Uint8Array(this.chunks);
  }
}

/** LZ4-блок «только литералы» — валидный LZ4, не требующий энкодера. */
export function lz4Literals(data: Uint8Array): Uint8Array {
  const out = new Buf();
  if (data.length === 0) return new Uint8Array([0]);
  if (data.length < 15) {
    out.u8(data.length << 4);
  } else {
    out.u8(0xf0);
    let rest = data.length - 15;
    while (rest >= 255) {
      out.u8(255);
      rest -= 255;
    }
    out.u8(rest);
  }
  return out.raw(data).toBytes();
}

export interface TestBlock {
  uncompressedSize: number;
  compressedSize: number;
  flags: number;
}

export interface TestNode {
  path: string;
  offset: number;
  size: number;
  flags?: number;
}

/** Блок blocksInfo UnityFS (big-endian), hash — нули. */
export function buildBlocksInfo(blocks: TestBlock[], nodes: TestNode[]): Uint8Array {
  const out = new Buf();
  out.raw(new Uint8Array(16)); // uncompressedDataHash
  out.i32(blocks.length, "be");
  for (const block of blocks) {
    out.u32(block.uncompressedSize, "be");
    out.u32(block.compressedSize, "be");
    out.u16(block.flags, "be");
  }
  out.i32(nodes.length, "be");
  for (const node of nodes) {
    out.i64(BigInt(node.offset), "be");
    out.i64(BigInt(node.size), "be");
    out.u32(node.flags ?? 4, "be");
    out.cstring(node.path);
  }
  return out.toBytes();
}

export interface BuildUnityFsOptions {
  blocksInfo: Uint8Array;
  /** Как blocksInfo лежит в файле (по умолчанию — как есть, без сжатия). */
  blocksInfoStored?: Uint8Array;
  blocks: Array<{ stored: Uint8Array; uncompressedSize: number; flags: number }>;
  nodes: TestNode[];
  flags?: number;
  formatVersion?: number;
  engineVersion?: string;
  blocksInfoAtEnd?: boolean;
}

/** Собрать минимальный UnityFS-контейнер. */
export function buildUnityFs(opts: BuildUnityFsOptions): Uint8Array {
  const formatVersion = opts.formatVersion ?? 8;
  const engineVersion = opts.engineVersion ?? "2022.3.62f3";
  const blocksInfoStored = opts.blocksInfoStored ?? opts.blocksInfo;
  const atEnd = opts.blocksInfoAtEnd ?? false;
  const flags = opts.flags ?? 0x40; // combined blocks+directory, без сжатия

  const header = new Buf();
  header.cstring("UnityFS");
  header.u32(formatVersion, "be");
  header.cstring("5.x.x");
  header.cstring(engineVersion);
  const sizeOffset = header.length;
  header.i64(0n, "be"); // size — заполним в конце
  header.u32(blocksInfoStored.length, "be");
  header.u32(opts.blocksInfo.length, "be");
  header.u32(flags, "be");
  if (formatVersion >= 7) header.align(16);

  const body = new Buf();
  const blockData = new Buf();
  for (const block of opts.blocks) blockData.raw(block.stored);

  if (atEnd) {
    body.raw(header.toBytes());
    body.raw(blockData.toBytes());
    body.raw(blocksInfoStored);
  } else {
    body.raw(header.toBytes());
    body.raw(blocksInfoStored);
    if (flags & 0x200) body.align(16);
    body.raw(blockData.toBytes());
  }
  const bytes = body.toBytes();
  const view = new DataView(bytes.buffer);
  view.setBigInt64(sizeOffset, BigInt(bytes.length), false);
  return bytes;
}

export interface BuildSerializedOptions {
  unityVersion?: string;
  endian?: TestEndian;
  targetPlatform?: number;
  enableTypeTree?: boolean;
  types: Array<{ classId: number; typeTree?: { nodes: Uint8Array; strings: Uint8Array } }>;
  objects: Array<{ pathId: bigint; data: Uint8Array; typeId: number }>;
  externals?: string[];
  userInformation?: string;
}

/**
 * Собрать минимальный SerializedFile версии 22.
 *
 * Заголовок (BE): legacy-префикс, флаг endian, reserved, v22-поля.
 * Метаданные и данные объектов — в выбранном порядке байт.
 */
export function buildSerializedFile(opts: BuildSerializedOptions): Uint8Array {
  const endian = opts.endian ?? "le";
  const endianFlag = endian === "be" ? 1 : 0;

  const meta = new Buf();
  meta.cstring(opts.unityVersion ?? "2022.3.62f3");
  meta.i32(opts.targetPlatform ?? 19, endian);
  meta.u8(opts.enableTypeTree ? 1 : 0);
  meta.i32(opts.types.length, endian);
  for (const type of opts.types) {
    meta.i32(type.classId, endian);
    meta.u8(0); // isStrippedType
    meta.u16(0, endian); // scriptTypeIndex
    if (type.classId === 114) meta.raw(new Uint8Array(16)); // scriptId (Hash128)
    meta.raw(new Uint8Array(16)); // oldTypeHash
    if (opts.enableTypeTree) {
      const tree = type.typeTree ?? { nodes: new Uint8Array(32), strings: new Uint8Array(1) };
      const nodeCount = tree.nodes.length / 32;
      meta.i32(nodeCount, endian);
      meta.i32(tree.strings.length, endian);
      meta.raw(tree.nodes);
      meta.raw(tree.strings);
      meta.i32(0, endian); // type_dependencies
    }
  }

  // Объекты: путь фиксирован 8+8+4+4 байт, поэтому сначала пишем нулевые
  // byteStart, запоминаем позиции и патчим после вычисления dataOffset.
  meta.i32(opts.objects.length, endian);
  const byteStartPositions: number[] = [];
  for (const object of opts.objects) {
    meta.align(4);
    meta.i64(object.pathId, endian);
    byteStartPositions.push(meta.length);
    meta.i64(0n, endian);
    meta.u32(object.data.length, endian);
    meta.i32(object.typeId, endian);
  }

  meta.i32(0, endian); // scripts
  const externals = opts.externals ?? [];
  meta.i32(externals.length, endian);
  for (const path of externals) {
    meta.cstring(""); // temp_empty
    meta.raw(new Uint8Array(16)); // guid
    meta.i32(0, endian); // type
    meta.cstring(path);
  }
  meta.i32(0, endian); // ref types
  meta.cstring(opts.userInformation ?? "");

  const metaBytes = meta.toBytes();
  const dataOffset = 48 + metaBytes.length;
  let cursor = dataOffset;
  const patched = new Buf().raw(metaBytes);
  for (let i = 0; i < opts.objects.length; i++) {
    // В object table byte_start хранится ОТНОСИТЕЛЬНО dataOffset.
    patched.patchI64(byteStartPositions[i], BigInt(cursor - dataOffset), endian);
    cursor += opts.objects[i].data.length;
  }

  const fileSize = dataOffset + opts.objects.reduce((sum, o) => sum + o.data.length, 0);
  const header = new Buf();
  header.u32(0, "be"); // legacy metadataSize
  header.u32(0, "be"); // legacy fileSize
  header.u32(22, "be"); // version
  header.u32(0, "be"); // legacy dataOffset
  header.u8(endianFlag);
  header.raw(new Uint8Array(3));
  header.u32(metaBytes.length, "be");
  header.i64(BigInt(fileSize), "be");
  header.i64(BigInt(dataOffset), "be");
  header.i64(0n, "be");

  const out = new Buf().raw(header.toBytes()).raw(patched.toBytes());
  for (const object of opts.objects) out.raw(object.data);
  return out.toBytes();
}

/** Узел type tree v22 (32 байта). */ export function testTreeNode(opts: {
  version?: number;
  level?: number;
  typeFlags?: number;
  typeOffset: number;
  nameOffset: number;
  byteSize?: number;
  index?: number;
  metaFlag?: number;
  refTypeHash?: bigint;
}): Uint8Array {
  const b = new Buf();
  b.u16(opts.version ?? 1, "le");
  b.u8(opts.level ?? 0);
  b.u8(opts.typeFlags ?? 0);
  b.u32(opts.typeOffset, "le");
  b.u32(opts.nameOffset, "le");
  b.i32(opts.byteSize ?? 4, "le");
  b.i32(opts.index ?? 0, "le");
  b.i32(opts.metaFlag ?? 0, "le");
  b.i64(opts.refTypeHash ?? 0n, "le");
  return b.toBytes();
}

/**
 * Синтетический LZMA1-блок (props + dictSize + поток), сжатый эталонным
 * xz/LZMA (lc=3, lp=0, pb=2). Текст — наш собственный, не из игры.
 */
export const LZMA_TEXT =
  "LZMA raw decoder test. Hello, hello, hello! The quick brown fox jumps over the lazy dog. 0123456789.\n".repeat(
    6,
  );

export const LZMA_VECTOR_BASE64 =
  "XQAAgAAAJhaFvEXxKMD3vJdaVM3YmZYIcuGfomC80YMctBvJLU+G8az9Ak1+IPD899S/t4cN1zZIecm7zvzpfkthpBTKC0quwsPpIIMIn/ZPx9eJco6L/F6M4dBKM1IoO1+mphP//9bu4AA=";

export function lzmaVectorBytes(): Uint8Array {
  return new Uint8Array(Buffer.from(LZMA_VECTOR_BASE64, "base64"));
}
