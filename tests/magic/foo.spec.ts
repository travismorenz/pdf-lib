import {
  appendFileSync,
  copyFileSync,
  openSync,
  readFileSync,
  readSync,
  fstatSync,
  statSync,
  PathLike,
  constants,
} from 'fs';
import { degrees, drawLinesOfText, EmbedFontOptions, grayscale, PDFFont, PDFPageDrawTextOptions, StandardFonts } from 'src/api';
import {
    CustomFontEmbedder,
    CustomFontSubsetEmbedder,
    PDFArray,
    PDFCatalog,
    PDFContentStream,
    PDFContext,
    PDFDict,
    PDFHexString,
    PDFName,
    PDFNumber,
    PDFObject,
    PDFObjectParser,
    PDFPageLeaf,
    PDFParser,
    PDFRef,
    PDFStream,
    PDFWriter,
    StandardFontEmbedder,
 } from 'src/core';
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

    it(`dances the tarantella`, async () => {
        const buf = Buffer.allocUnsafe(1024);
        const testPath = './assets/pdfs/test.pdf';

        // BREAK(trailer-discovery)
        let block = readFinalBlock(testPath, buf);

        let lastLineExt = precedingLineExtents(block);
        let xrefOffsetExt = precedingLineExtents(block, lastLineExt.start);
        let startxrefMarkerExt = precedingLineExtents(block, xrefOffsetExt.start);
        // END(trailer-discovery)

        const ctx = PDFContext.create();

        // BREAK(xref-parse)
        const parser = PDFObjectParser.forBytes(buf.slice(startxrefMarkerExt.start), ctx);

        expect(hackParser(parser).matchKeyword(Keywords.startxref)).toBe(true);
        const xrefOffsetObj = parser.parseObject();
        const xrefOffset = (xrefOffsetObj as PDFNumber).asNumber();

        const stream = new FileByteStream(testPath)
        const lut: Map<PDFRef, number> = new Map();
        const trailerDict = createXrefLookupTable(ctx, stream, xrefOffset, lut);

        // FIXME: pdf-lib only deals with these trailer properties, but there
        // are more possible.  The spec says that all properties except Prev
        // should be copied forward in incremental updates.
        // BREAK(trailer-info)
        ctx.trailerInfo.Encrypt = trailerDict.get(PDFName.of('Encrypt'));
        ctx.trailerInfo.ID = trailerDict.get(PDFName.of('ID'));
        ctx.trailerInfo.Info = trailerDict.get(PDFName.of('Info'));
        ctx.trailerInfo.Root = trailerDict.get(PDFName.of('Root'));
        // END(trailer-info)

        // END(xref-parse)

        // Update ctx.largestObjectNumber to reflect the objects we have seen in
        // all the xref tables.
        // BREAK(largest-object-number)
        lut.forEach((offset_, ref) =>
            ctx.largestObjectNumber = Math.max(ctx.largestObjectNumber, ref.objectNumber)
        );
        // END(largest-object-number)
        
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

        // BREAK(append-new-content-stream)
        const contentsRef = page.get(PDFName.of('Contents')) as PDFRef;
        expect(contentsRef).toBeDefined();

        const contentsStart = lut.get(contentsRef) as number;
        expect(contentsStart).toBeDefined();

        const contents = magicalRead(stream, contentsStart, contentsRef);
        let nextContents: PDFArray;
        let nextContentsRef: PDFRef;
        let contentStream = PDFContentStream.of(ctx.obj({}), []);
        const contentStreamRef = ctx.nextRef();
        ctx.assign(contentStreamRef, contentStream);
        if (contents instanceof PDFArray) {
            // FIXME: Untested.
            nextContents = contents;
            nextContentsRef = contentsRef;
            nextContents.push(contentStreamRef);
            ctx.assign(nextContentsRef, nextContents);
        } else if (contents instanceof PDFStream) {
            nextContentsRef = ctx.nextRef();
            nextContents = ctx.obj([contentsRef, contentStreamRef]);
            ctx.assign(nextContentsRef, nextContents);
        } else {
            throw new Error(`unhandled Page.Contents type: ${contents.constructor.name}`);
        }

        page.set(PDFName.Contents, nextContentsRef);
        // END(append-new-content-stream)

        const fontData = readFileSync('./assets/fonts/ubuntu/Ubuntu-R.ttf');
        const font = await makeFont(ctx, fontkit, fontData);
        // const font = await makeFont(ctx, fontkit, StandardFonts.Courier);

        // TODO: Any reason to wait until later?  That's how it happens in
        // PDFDocument (during save), but I'm not sure we need to wait.
        await font.embed(ctx);

        // PDFPage.newFontDictionary call doesn't work because it depends on the
        // whole PDF being unpacked into memory. So, the lines below replicate
        // this behavior (not including any kind of object inheritance, which I
        // think is a thing).
        // FIXME: Could be ref or inline dict (or null).
        // BREAK(font-on-page)
        const resourcesRef = page.get(PDFName.Resources) as PDFRef;
        const resources = magicalRead(stream, lut.get(resourcesRef)!, resourcesRef) as PDFDict;

        const fontDict = resources.get(PDFName.Font) as PDFDict | undefined ?? ctx.obj({});
        resources.set(PDFName.Font, fontDict);
        const fontKey = fontDict.uniqueKey(font.name);
        fontDict.set(fontKey, font.ref);

        ctx.assign(resourcesRef, resources);
        // END(font-on-page)

        // NOTE: These ctx.assign of things that seem to already exist are so
        // they exist in the indirect object list in PDFContext, and will then
        // be written when serializing.  It might be good to have some kind of
        // `markDirty` helper that communicates the intent more clearly.
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

        const outbuf = await PDFWriter.forContext(ctx, 50, false).serializeToBuffer(statSync(testPath).size);

        const outPath = './yowza.pdf';
        copyFileSync(testPath, outPath);
        appendFileSync(outPath, outbuf);
    });

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

// FIXME: Stolen from PDFDocument.embedFont. Share somehow?
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

// FIXME: Silly name.
interface MyPDFPageDrawTextOptions extends PDFPageDrawTextOptions {
    font: PDFFont;
    fontKey: PDFName;
    x: number;
    y: number;
    lineHeight: number;
}

// FIXME: Stolen from PDFPage.drawText. Share somehow?
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