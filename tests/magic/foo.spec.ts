//import { FileByteStream } from "src/core/parser/ByteStream";

import {
  appendFileSync,
  copyFileSync,
  openSync,
  readFileSync,
  writeFileSync,
  readSync,
  fstatSync,
  statSync,
  PathLike,
  constants,
} from 'fs';
import { degrees, drawLinesOfText, EmbedFontOptions, grayscale, PDFFont, PDFPageDrawTextOptions, StandardFonts } from 'src/api';
// import { PageSizes, PDFDocument } from 'src/api';
import {
    CustomFontEmbedder, CustomFontSubsetEmbedder, PDFArray, PDFCatalog, PDFContentStream, PDFContext,
    PDFDict,
    // PDFDict,
    PDFHexString, PDFName, PDFNumber, PDFObject, PDFObjectParser, PDFPageLeaf,
    PDFParser,
    PDFRawStream,
    PDFRef,
    PDFStream,
    // PDFRef,
    PDFWriter, StandardFontEmbedder } from 'src/core';
import BaseParser from 'src/core/parser/BaseParser';
import { Keywords } from 'src/core/syntax/Keywords';

import { inspect } from 'util';

import fontkit from '@pdf-lib/fontkit';
import { breakTextIntoLines, canBeConvertedToUint8Array, cleanText, isStandardFont, lineSplit, toUint8Array } from 'src/utils';
import { Fontkit } from 'src/types/fontkit';
import { FileByteStream } from 'src/core/parser/ByteStream';

interface ParserHack {
  matchKeyword(keyword: number[]): boolean;
}

function hackParser(parser: BaseParser) {
    return parser as unknown as ParserHack;
}

type LineExtents = {
    start: number;
    end: number;
};

type Block = {
    buffer: Uint8Array;
    atBof?: boolean;
    atEof?: boolean;
};

class LastQuestionError extends Error {
    constructor() {
        super('THERE IS INSUFFICIENT DATA FOR A MEANINGFUL ANSWER');
    }
}

function readFinalBlock(path: PathLike, buffer: Uint8Array): Block {
    const fd = openSync(path, constants.O_RDONLY);
    const filesize = fstatSync(fd).size;
    const count = Math.min(buffer.length, filesize);
    readSync(fd, buffer, 0, count, filesize - count);

    return {
        buffer: buffer.slice(0, count),
        atEof: true,
        atBof: filesize <= buffer.length,
    }
}

function precedingLineExtents(block: Block, position?: number) : LineExtents {
    let pos = position ?? block.buffer.length;
    if (pos > block.buffer.length || pos < 0) {
        throw new Error('position out of bounds');
    }

    function match(c: string): boolean {
        if (pos < 0) {
            if (block.atBof) {
                return false;
            }
            throw new LastQuestionError();
        }

        if (block.buffer[pos] === c.charCodeAt(0)) {
            pos--;
            return true;
        }
        return false;
    }

    function matchNoneOf(chars: string): boolean {
        if (pos < 0) {
            if (block.atBof) {
                return true;
            }
            throw new LastQuestionError();
        }

        const c = block.buffer[pos];
        for (let x of chars) {
            // TODO: Precompute charCodeAts
            if (c === x.charCodeAt(0)) {
                return false;
            }
        }
        pos--;
        return true;
    }

    // NOTE: Users pass us the index of "one past" the end.  (See what Djikstra
    // has to say about this kind of thing.)
    pos--;

    if (match('\n')) {
        // LF and CRLF
        match('\r');
    } else if (match('\r')) {
        // CR-only (like a classic Mac)
    } else if (block.atEof && pos === block.buffer.length - 1) {
        // No trailing line ending at all.
    }  else {
        throw new Error("must start and the end of a line");
    }

    const end = pos + 1;
    while (matchNoneOf('\r\n') && pos >= 0) { }
    if (pos < 0 && !block.atBof) {
        throw new LastQuestionError();
    }

    return { start: pos + 1, end };
}

describe.only(`the magic`, () => {
    it(`can find line extents in reverse`, () => {
        const buf = Buffer.allocUnsafe(1024);
        let block = readFinalBlock('./assets/pdfs/test.pdf', buf);

        let extents = precedingLineExtents(block);
        expect(
            inspect(buf.slice(extents.start, extents.end).toString('utf8'))
        ).toEqual(inspect('%%EOF'));

        extents = precedingLineExtents(block, extents.start);
        expect(
            inspect(buf.slice(extents.start, extents.end).toString('utf8'))
        ).toEqual(inspect('173'));

        extents = precedingLineExtents(block, extents.start);
        expect(
            inspect(buf.slice(extents.start, extents.end).toString('utf8'))
        ).toEqual(inspect('startxref'));
    });

    it(`round two`, () => {
        const buf = Buffer.allocUnsafe(1024);
        let block = readFinalBlock('./assets/pdfs/test.pdf', buf);

        let lastLineExt = precedingLineExtents(block);
        let xrefOffsetExt = precedingLineExtents(block, lastLineExt.start);
        let startxrefMarkerExt = precedingLineExtents(block, xrefOffsetExt.start);

        const ctx = PDFContext.create();
        const parser = PDFObjectParser.forBytes(buf.slice(startxrefMarkerExt.start), ctx);

        expect(hackParser(parser).matchKeyword(Keywords.startxref)).toBe(true);
        const xrefOffset = parser.parseObject();
        expect(xrefOffset).toBeInstanceOf(PDFNumber);
        expect((xrefOffset as PDFNumber).asNumber()).toEqual(173);
        expect(hackParser(parser).matchKeyword(Keywords.eof));
    });

    // it(`new crazy`, async () => {
    //     const doc = await PDFDocument.create();
    //     const page = doc.addPage(PageSizes.Letter);
    //     page.moveTo(10, 10);
    //     page.drawText("testing 123", { size: 36 });
    //     writeFileSync('./amazing.pdf', await doc.save());
    // });

    it(`reads a final line terminated by EOF`, () => {
        const buffer = Buffer.from('%%EOF', 'ascii');
        const block: Block = {
            buffer,
            atBof: true,
            atEof: true,
        };

        expect(precedingLineExtents(block)).toEqual({
            start: 0,
            end: 5,
        });
    });

    it(`makes my head hurt`, async () => {
        const ctx = PDFContext.create();

        // Page (PDFPageLeaf)
        // Font (via context.lookup)
        // ContentStream

        // NOTE: In the real one, we'll read the PDFPageLeaf, not create it.
        const page = PDFPageLeaf.fromMapWithContext(new Map(), ctx);
        const pageRef = ctx.nextRef();
        ctx.assign(pageRef, page);

        const stream = PDFContentStream.of(
            ctx.obj({}),
            [],
        );
        const streamRef = ctx.nextRef();
        ctx.assign(streamRef, stream);
        page.addContentStream(streamRef);

        // const fontData = readFileSync('./assets/fonts/ubuntu/Ubuntu-B.ttf');
        // const font = await makeFont(ctx, fontkit, fontData);
        // const fontKey = page.newFontDictionary(font.name, font.ref);

        // stream.push(
        //     ...drawText('hello\nfriend', {
        //         font,
        //         fontKey,
        //         lineHeight: 20,
        //         size: 14,
        //         x: 10,
        //         y: 100,
        //     })
        // );

        // await font.embed(ctx);

        const buf = await PDFWriter.forContext(ctx, 50, false).serializeToBuffer(12345);
        // expect(Buffer.from(buf).toString('ascii')).toBe('bonk');
    });

    it(`dances the tarantella`, async () => {
        const buf = Buffer.allocUnsafe(1024);
        const testPath = './assets/pdfs/test.pdf';
        let block = readFinalBlock(testPath, buf);

        let lastLineExt = precedingLineExtents(block);
        let xrefOffsetExt = precedingLineExtents(block, lastLineExt.start);
        let startxrefMarkerExt = precedingLineExtents(block, xrefOffsetExt.start);

        const ctx = PDFContext.create();
        const parser = PDFObjectParser.forBytes(buf.slice(startxrefMarkerExt.start), ctx);

        expect(hackParser(parser).matchKeyword(Keywords.startxref)).toBe(true);
        const xrefOffsetObj = parser.parseObject();
        const xrefOffset = (xrefOffsetObj as PDFNumber).asNumber();

        const stream = new FileByteStream(testPath)
        const lut: Map<PDFRef, number> = new Map();
        const trailerDict = createXrefLookupTable(ctx, stream, xrefOffset, lut);

        lut.forEach((offset_, ref) =>
            ctx.largestObjectNumber = Math.max(ctx.largestObjectNumber, ref.objectNumber)
        );
        
        function magicalRead<T = PDFObject>(s: FileByteStream, offset: number, ref: PDFRef): T {
            s.moveTo(offset);
            const p = PDFParser.forByteStreamWithOptions(s, ctx);
            expect(p.parseIndirectObjectHeader()).toEqual(ref);
            const obj = p.parseObject();
            // FIXME: I really want this.
            // if (!(obj instanceof type)) {
            //     throw new Error('wrong type')
            // }
            return obj as unknown as T;
        }

        const rootRef = trailerDict.get(PDFName.of('Root')) as PDFRef;
        expect(rootRef).toBeDefined();
        // if (!(rootRef instanceof PDFRef)) throw new Error("root ref is the wrong type (or maybe it doesn't exist?)");

        const catalogStart = lut.get(rootRef);
        expect(catalogStart).toBeDefined();
        if (catalogStart == null) throw new Error('catalog start not found in lut');

        const catalog = magicalRead<PDFCatalog>(stream, catalogStart, rootRef);
        const pageTreeRef = catalog.get(PDFName.of('Pages')) as PDFRef;
        const pageTreeStart = lut.get(pageTreeRef) as number;
        expect(pageTreeStart).toBeDefined();

        const pageTree = magicalRead<PDFDict>(stream, pageTreeStart, pageTreeRef);

        const kids = pageTree.get(PDFName.of('Kids')) as PDFArray;
        const pageRef = kids.get(0) as PDFRef;

        const pageStart = lut.get(pageRef) as number;
        expect(pageStart).toBeDefined();
        const page = magicalRead<PDFPageLeaf>(stream, pageStart, pageRef);

        const contentsRef = page.get(PDFName.of('Contents')) as PDFRef;
        expect(contentsRef).toBeDefined();

        const contentsStart = lut.get(contentsRef) as number;
        expect(contentsStart).toBeDefined();

        // FIXME: probably put this back
        // const contentsRefNextGen = contentsRef.nextGen();
        const contentsRefNextGen = contentsRef;

        const contents = magicalRead(stream, contentsStart, contentsRef);
        let nextContents: PDFArray;
        let contentStream = PDFContentStream.of(ctx.obj({}), []);
        if (contents instanceof PDFArray) {
            throw new Error('not implemented yet');
        } else if (contents instanceof PDFStream) {
            let s = contents;
            nextContents = PDFArray.withContext(ctx);
            nextContents.push(contentsRef);
            const contentStreamRef = ctx.nextRef();
            //ctx.assign(contentStreamRef, contentStream);
            nextContents.push(contentStreamRef);
        } else {
            throw new Error(`unhandled Page.Contents type: ${contents.constructor.name}`);
        }
        //ctx.assign(contentsRefNextGen, nextContents);

        // FIXME: probably put this back
        // page.set(PDFName.of('Contents'), contentsRefNextGen);
        // ctx.assign(pageRef.nextGen(), page);

        /*
        const contentStream = PDFContentStream.of(
            ctx.obj({}),
            [],
        );
        const streamRef = ctx.nextRef();
        ctx.assign(streamRef, contentStream);
        page.addContentStream(streamRef);
        */

        // const fontData = readFileSync('./assets/fonts/ubuntu/Ubuntu-B.ttf');
        // const font = await makeFont(ctx, fontkit, fontData);
        const font = await makeFont(ctx, fontkit, StandardFonts.Courier);
        const fontKey = page.newFontDictionary(font.name, font.ref);

        ctx.assign(pageRef, page);

        contentStream.push(
            ...drawText('hello\nfriend', {
                font,
                fontKey,
                lineHeight: 20,
                size: 14,
                x: 10,
                y: 100,
            })
        );

        await font.embed(ctx);

        const outbuf = await PDFWriter.forContext(ctx, 50, false).serializeToBuffer(statSync(testPath).size);

        const outPath = './yowza.pdf';
        copyFileSync(testPath, outPath);
        appendFileSync(outPath, outbuf);
        // expect(Buffer.from(buf).toString('ascii')).toBe('bonk');
    });

    // import fontkit from "@pdf-lib/fontkit";
    // doc.registerFontkit(fontkit);
    // const fontBytes = await fetch(fontUrl).then((res) => res.arrayBuffer());
    // const font = await doc.embedFont(fontBytes);

    // write derived Page object, modifying Contents
    // - read page object -> PDFPageLeaf
    // - write page object -> PDFPageLeaf
    // write Content Stream
    // - use PDFContentStream directly
    // write operations in content stream to place text (need to measure/layout)
    // - [X] need a font (add new)
    // write new xref table
    // write new trailer
});

// FIXME: This needs a better name.  It deals with the trailer *and* creates a
// cross reference lookup table.
function createXrefLookupTable(
    ctx: PDFContext,
    stream: FileByteStream,
    offset: number,
    lut: Map<PDFRef, number>,
) {
    stream.moveTo(offset);

    const trailerParser = PDFParser.forByteStreamWithOptions(stream, ctx);
    const xref = trailerParser.maybeParseCrossRefSection();
    if (!xref) {
        throw new Error('xref is null');
    }

    for (let foo of xref.subsections) {
        for (let entry of foo) {
            lut.set(entry.ref, entry.offset);
        }
    }

    const trailerDict = trailerParser.maybeParseTrailerPDFDict();
    if (!trailerDict) {
        throw new Error('trailerDict is null');
    }

    // TODO: Start caring about this.
    // const trailer = trailerParser.maybeParseTrailer();
    // if (!trailer) {
    //     throw new Error('trailer is null');
    // }

    const prevOffset = trailerDict.get(PDFName.of('Prev'));
    if (prevOffset) {
        if (!(prevOffset instanceof PDFNumber)) {
            throw new Error('expected a number');
        }
        createXrefLookupTable(ctx, stream, prevOffset.asNumber(), lut);
    }

    // FIXME: Combine all seen trailer dictionaries.
    return trailerDict;
}

async function makeFont(
    context: PDFContext,
    fontkit: Fontkit,
    font: StandardFonts | string | Uint8Array | ArrayBuffer,
    options: EmbedFontOptions = {},
): Promise<PDFFont> {
    const { subset = false, customName, features } = options;

    // assertIs(font, 'font', ['string', Uint8Array, ArrayBuffer]);
    // assertIs(subset, 'subset', ['boolean']);

    let embedder: CustomFontEmbedder | StandardFontEmbedder;
    if (isStandardFont(font)) {
        embedder = StandardFontEmbedder.for(font, customName);
    } else if (canBeConvertedToUint8Array(font)) {
        const bytes = toUint8Array(font);
        embedder = subset
            ? await CustomFontSubsetEmbedder.for(
                fontkit,
                bytes,
                customName,
                features,
            )
            : await CustomFontEmbedder.for(fontkit, bytes, customName, features);
    } else {
        throw new TypeError(
            '`font` must be one of `StandardFonts | string | Uint8Array | ArrayBuffer`',
        );
    }

    const ref = context.nextRef();
    const pdfFont = PDFFont.of(ref, embedder);

    return pdfFont;
}

interface MyPDFPageDrawTextOptions extends PDFPageDrawTextOptions {
    font: PDFFont;
    fontKey: PDFName;
    x: number;
    y: number;
    lineHeight: number;
}

function drawText(
    text: string,
    options: MyPDFPageDrawTextOptions,
) {
    // assertIs(text, 'text', ['string']);
    // assertOrUndefined(options.color, 'options.color', [[Object, 'Color']]);
    // assertRangeOrUndefined(options.opacity, 'opacity.opacity', 0, 1);
    // assertOrUndefined(options.font, 'options.font', [[PDFFont, 'PDFFont']]);
    // assertOrUndefined(options.size, 'options.size', ['number']);
    // assertOrUndefined(options.rotate, 'options.rotate', [[Object, 'Rotation']]);
    // assertOrUndefined(options.xSkew, 'options.xSkew', [[Object, 'Rotation']]);
    // assertOrUndefined(options.ySkew, 'options.ySkew', [[Object, 'Rotation']]);
    // assertOrUndefined(options.x, 'options.x', ['number']);
    // assertOrUndefined(options.y, 'options.y', ['number']);
    // assertOrUndefined(options.lineHeight, 'options.lineHeight', ['number']);
    // assertOrUndefined(options.maxWidth, 'options.maxWidth', ['number']);
    // assertOrUndefined(options.wordBreaks, 'options.wordBreaks', [Array]);
    // assertIsOneOfOrUndefined(options.blendMode, 'options.blendMode', BlendMode);

    const { font, fontKey } = options;
    const fontSize = options.size ?? 12; // FIXME: meh

    const wordBreaks = options.wordBreaks ?? [' '];
    const textWidth = (t: string) => font.widthOfTextAtSize(t, fontSize);
    const lines =
        options.maxWidth === undefined
            ? lineSplit(cleanText(text))
            : breakTextIntoLines(text, wordBreaks, options.maxWidth, textWidth);

    const encodedLines = new Array(lines.length) as PDFHexString[];
    for (let idx = 0, len = lines.length; idx < len; idx++) {
        encodedLines[idx] = font.encodeText(lines[idx]);
    }

    // FIXME: Support graphicsState again (only needed for opacity, border opacity and blend mode)
    // const graphicsStateKey = this.maybeEmbedGraphicsState({
    //     opacity: options.opacity,
    //     blendMode: options.blendMode,
    // });

    return drawLinesOfText(encodedLines, {
        color: options.color ?? grayscale(0),
        font: fontKey,
        size: fontSize,
        rotate: options.rotate ?? degrees(0),
        xSkew: options.xSkew ?? degrees(0),
        ySkew: options.ySkew ?? degrees(0),
        x: options.x,
        y: options.y,
        lineHeight: options.lineHeight,
        // graphicsState: graphicsStateKey,
    });
}