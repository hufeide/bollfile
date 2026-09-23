/**
 * framing.ts — 长度前缀帧封装
 *
 * hyperswarm 的 conn 是裸字节流，多段消息会"粘包"。
 * 帧格式: [4 字节大端长度][payload]，收端按长度切分。
 */
export function encodeFrame(payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(payload.length, 0);
  return Buffer.concat([head, payload]);
}

export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const frames: Buffer[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + len) break;
      const frame = Buffer.from(this.buf.subarray(4, 4 + len));
      frames.push(frame);
      this.buf = this.buf.subarray(4 + len);
    }
    return frames;
  }

  reset(): void {
    this.buf = Buffer.alloc(0);
  }
}
