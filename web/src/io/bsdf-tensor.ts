// RGL EPFL "tensor_file" container parser (.bsdf), as read by the reference
// loader (rgl-epfl/brdf-loader, powitacq_rgb.inl Tensor ctor):
//   char[12] "tensor_file\0", uint8 version[2] = {1,0}, uint32 n_fields,
//   then per field: uint16 name_len, name, uint16 ndim, uint8 dtype,
//   uint64 offset, uint64 shape[ndim]. Field data lives at `offset`.

export const enum TensorType {
  Invalid = 0,
  UInt8 = 1, Int8 = 2,
  UInt16 = 3, Int16 = 4,
  UInt32 = 5, Int32 = 6,
  UInt64 = 7, Int64 = 8,
  Float16 = 9, Float32 = 10, Float64 = 11,
}

export interface TensorField {
  dtype: TensorType;
  shape: number[];
  /** Raw bytes of the field (little-endian, tightly packed). */
  bytes: Uint8Array;
}

export function parseTensorFile(buf: ArrayBuffer): Map<string, TensorField> {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  if (buf.byteLength < 18 ||
      new TextDecoder().decode(u8.subarray(0, 11)) !== 'tensor_file') {
    throw new Error('not a tensor_file (.bsdf)');
  }
  if (u8[12] !== 1 || u8[13] !== 0) {
    throw new Error(`unsupported tensor_file version ${u8[12]}.${u8[13]}`);
  }
  const nFields = dv.getUint32(14, true);
  const fields = new Map<string, TensorField>();
  let p = 18;
  const typeSize = [0, 1, 1, 2, 2, 4, 4, 8, 8, 2, 4, 8];
  for (let i = 0; i < nFields; i++) {
    const nameLen = dv.getUint16(p, true); p += 2;
    const name = new TextDecoder().decode(u8.subarray(p, p + nameLen)); p += nameLen;
    const ndim = dv.getUint16(p, true); p += 2;
    const dtype = dv.getUint8(p) as TensorType; p += 1;
    const offset = Number(dv.getBigUint64(p, true)); p += 8;
    const shape: number[] = [];
    let count = 1;
    for (let j = 0; j < ndim; j++) {
      const s = Number(dv.getBigUint64(p, true)); p += 8;
      shape.push(s);
      count *= s;
    }
    if (dtype === TensorType.Invalid || dtype > TensorType.Float64) {
      throw new Error(`tensor_file: field "${name}" has unknown dtype ${dtype}`);
    }
    const byteLen = count * typeSize[dtype];
    if (offset + byteLen > buf.byteLength) {
      throw new Error(`tensor_file: field "${name}" is truncated`);
    }
    fields.set(name, { dtype, shape, bytes: u8.subarray(offset, offset + byteLen) });
  }
  return fields;
}

export function fieldAsFloat32(f: TensorField): Float32Array {
  if (f.dtype !== TensorType.Float32) throw new Error('expected Float32 field');
  // Copy to guarantee alignment (subarray offset may not be 4-byte aligned).
  const out = new Float32Array(f.bytes.length / 4);
  new Uint8Array(out.buffer).set(f.bytes);
  return out;
}
