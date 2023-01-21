import { NextByteAssertionError } from 'src/core/errors';
import PDFRawStream from 'src/core/objects/PDFRawStream';
import { decodePDFRawStream } from 'src/core/streams/decode';
import CharCodes from 'src/core/syntax/CharCodes';

import {
  openSync,
  readSync,
  fstatSync,
  PathLike,
  constants,
} from 'fs';

const { O_RDONLY } = constants;

export interface IByteStream {
  moveTo(offset: number): void;
  next(): number;
  assertNext(expected: number): number;
  peek(): number;
  peekAhead(steps: number): number;
  peekAt(offset: number): number;
  done(): boolean;
  offset(): number;
  slice(start: number, end: number): Uint8Array;
  position(): { line: number; column: number; offset: number };
}

export class FileByteStream implements IByteStream {
  private readonly fd: number;
  // FIXME: Better name.
  private pos: number;

  constructor(path: PathLike) {
    this.fd = openSync(path, O_RDONLY);
    this.pos = 0;
  }

  moveTo(offset: number): void {
    if (offset < 0) {
      // FIXME: sanity checks.
      offset = fstatSync(this.fd).size + offset;
    }
    // FIXME: stat and find out if this is legal?
    this.pos = offset;
  }

  next(): number {
    const b = this.peekAt(this.pos);
    this.pos++;
    return b;
  }

  assertNext(expected: number): number {
    // TODO: Move this to a common base class(?)
    if (this.peek() !== expected) {
      throw new NextByteAssertionError(this.position(), expected, this.peek());
    }
    return this.next();
  }

  peek(): number {
    return this.peekAt(this.pos);
  }
  peekAhead(steps: number): number {
    return this.peekAt(this.pos + steps);
  }
  peekAt(offset: number): number {
    // TODO: Share the buffer?
    const buf = Buffer.allocUnsafe(1);
    const bytesRead = readSync(this.fd, buf, 0, 1, offset);
    if (bytesRead !== 1) {
      throw new Error("life is ending");
    }
    return buf[0];
  }
  done(): boolean {
    return this.pos >= fstatSync(this.fd).size;
  }
  offset(): number {
    return this.pos;
  }
  slice(start: number, end: number): Uint8Array {
    if (start <= 0) {
      throw new Error("nope");
    }

    const count = end - start;
    if (count < 0) {
      throw new Error("also nope");
    }

    const buf = Buffer.allocUnsafe(count);
    const bytesRead = readSync(this.fd, buf, 0, count, this.pos);
    if (bytesRead !== count) {
      throw new Error("not enough file, man");
    }
    return buf;
  }
  position(): { line: number; column: number; offset: number; } {
    return { line: -1, column: -1, offset: this.pos };
  }
}

// TODO: See how line/col tracking affects performance
class ByteStream implements IByteStream {
  static of = (bytes: Uint8Array) => new ByteStream(bytes);

  static fromPDFRawStream = (rawStream: PDFRawStream) =>
    ByteStream.of(decodePDFRawStream(rawStream).decode());

  private readonly bytes: Uint8Array;
  private readonly length: number;

  private idx = 0;
  private line = 0;
  private column = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.length = this.bytes.length;
  }

  moveTo(offset: number): void {
    this.idx = offset;
  }

  next(): number {
    const byte = this.bytes[this.idx++];
    if (byte === CharCodes.Newline) {
      this.line += 1;
      this.column = 0;
    } else {
      this.column += 1;
    }
    return byte;
  }

  assertNext(expected: number): number {
    if (this.peek() !== expected) {
      throw new NextByteAssertionError(this.position(), expected, this.peek());
    }
    return this.next();
  }

  peek(): number {
    return this.bytes[this.idx];
  }

  peekAhead(steps: number) {
    return this.bytes[this.idx + steps];
  }

  peekAt(offset: number) {
    return this.bytes[offset];
  }

  done(): boolean {
    return this.idx >= this.length;
  }

  offset(): number {
    return this.idx;
  }

  slice(start: number, end: number): Uint8Array {
    return this.bytes.slice(start, end);
  }

  position(): { line: number; column: number; offset: number } {
    return { line: this.line, column: this.column, offset: this.idx };
  }
}

export default ByteStream;
