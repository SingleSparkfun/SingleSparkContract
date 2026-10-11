'use strict';

// Native bigint-buffer has an unpatched buffer overflow; unsigned conversions need no native code.
function toBigIntBE(bytes) {
  const hex = Buffer.from(bytes).toString('hex');
  return hex ? BigInt(`0x${hex}`) : 0n;
}
function toBigIntLE(bytes) { return toBigIntBE(Buffer.from(bytes).reverse()); }
function toBufferBE(value, width) {
  if (typeof value !== 'bigint' || value < 0n || !Number.isSafeInteger(width) || width < 0) {
    throw new RangeError('Expected an unsigned BigInt and a nonnegative byte width');
  }
  if (width === 0) {
    if (value !== 0n) throw new RangeError('BigInt exceeds byte width');
    return Buffer.alloc(0);
  }
  const hex = value.toString(16);
  if (hex.length > width * 2) throw new RangeError('BigInt exceeds byte width');
  return Buffer.from(hex.padStart(width * 2, '0'), 'hex');
}
function toBufferLE(value, width) { return toBufferBE(value, width).reverse(); }
module.exports = { toBigIntBE, toBigIntLE, toBufferBE, toBufferLE };
