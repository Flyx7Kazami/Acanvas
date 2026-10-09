export function gifFixture(options: { repeat?: number; frames?: { color: number; left: number; top: number; width: number; height: number; disposal: number; transparent?: boolean; delay?: number }[] } = {}): Uint8Array {
  const bytes: number[] = [...new TextEncoder().encode('GIF89a'), 3, 0, 3, 0, 0x81, 0, 0, 0, 0, 0, 240, 20, 40, 20, 210, 70, 30, 70, 235];
  if (options.repeat !== undefined) bytes.push(0x21, 0xff, 11, ...new TextEncoder().encode('NETSCAPE2.0'), 3, 1, options.repeat & 255, options.repeat >> 8, 0);
  const frames = options.frames ?? [{ color: 1, left: 0, top: 0, width: 3, height: 3, disposal: 1 }, { color: 2, left: 0, top: 0, width: 1, height: 1, disposal: 3 }, { color: 3, left: 2, top: 2, width: 1, height: 1, disposal: 2 }, { color: 0, left: 0, top: 0, width: 3, height: 3, disposal: 1, transparent: true }];
  for (const frame of frames) {
    const delay = frame.delay ?? 10;
    bytes.push(0x21, 0xf9, 4, frame.disposal << 2 | (frame.transparent ? 1 : 0), delay & 255, delay >> 8, 0, 0, 0x2c, frame.left, 0, frame.top, 0, frame.width, 0, frame.height, 0, 0);
    const codes: number[] = []; for (let index = 0; index < frame.width * frame.height; index++) codes.push(4, frame.color); codes.push(5);
    const encoded: number[] = []; let accumulator = 0, bits = 0; for (const code of codes) { accumulator |= code << bits; bits += 3; while (bits >= 8) { encoded.push(accumulator & 255); accumulator >>= 8; bits -= 8; } } if (bits) encoded.push(accumulator);
    bytes.push(2, encoded.length, ...encoded, 0);
  }
  return Uint8Array.from([...bytes, 0x3b]);
}
