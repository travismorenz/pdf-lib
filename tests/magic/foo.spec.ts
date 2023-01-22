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
import { assertIs, assertOfType, breakTextIntoLines, canBeConvertedToUint8Array, cleanText, isOfType, isStandardFont, lineSplit, requireOfType, toUint8Array } from 'src/utils';
import { Fontkit } from 'src/types/fontkit';
import ByteStream, { FileByteStream, IByteStream } from 'src/core/parser/ByteStream';

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
        const testPath = './assets/pdfs/test.pdf';
        const session = startSession(testPath);

        if (!session.ctx.trailerInfo.Root) {
            throw new Error('document has no root');
        }

        const catalog = requireResolvedType(PDFCatalog, resolve(session, session.ctx.trailerInfo.Root));

        // spec: Pages *must* be an indirect object.
        const pageTreeRef = requireOfType(PDFRef, catalog.obj.get(PDFName.of('Pages')));
        const pageTree = requireResolvedType(PDFDict, resolve(session, pageTreeRef));

        const kids = requireResolvedType(PDFArray, resolve(session, dictGetStrict(pageTree.obj, PDFName.of('Kids')), pageTree))
        const page = requireResolvedType(PDFPageLeaf, resolve(session, kids.obj.get(0), pageTree));

        // BREAK(append-new-content-stream)
        // FIXME: Contents can probably be null/absent.
        const contents = resolve(session, dictGetStrict(page.obj, PDFName.of('Contents')), page);
        if (!isResolvedType(PDFStream, contents) && !isResolvedType(PDFArray, contents)) {
            throw new Error();
        }

        let nextContents: ResolvedObject<PDFArray>;
        let contentStream = makeIndirect(session.ctx.nextRef(), PDFContentStream.of(session.ctx.obj({}), []));
        markDirty(session, contentStream);
        if (isResolvedType(PDFArray, contents)) {
            nextContents = contents;
            contents.obj.push(contentStream.ref);
            markDirty(session, contents);
        } else if (isResolvedType(PDFStream, contents)) {
            switch (contents.type) {
                case 'direct':
                    throw new Error('appending to inline streams is not implemented');
                case 'indirect':
                    nextContents = makeIndirect(session.ctx.nextRef(), session.ctx.obj([contents.ref, contentStream.ref]));
                    markDirty(session, nextContents);
                    break;
                default: unreachable(contents);
            }
        } else {
            unreachable(contents);
        }

        dictSet(page.obj, PDFName.Contents, nextContents);
        // END(append-new-content-stream)

        const fontData = readFileSync('./assets/fonts/ubuntu/Ubuntu-R.ttf');
        const font = await makeFont(session.ctx, fontkit, fontData);
        // const font = await makeFont(ctx, fontkit, StandardFonts.Courier);

        // TODO: Any reason to wait until later?  That's how it happens in
        // PDFDocument (during save), but I'm not sure we need to wait.
        await font.embed(session.ctx);

        // PDFPage.newFontDictionary call doesn't work because it depends on the
        // whole PDF being unpacked into memory. So, the lines below replicate
        // this behavior (not including any kind of object inheritance, which I
        // think is a thing).
        // FIXME: Page.Resources could legitimately return null/undefined.  In
        // which case, we need to create it.
        // BREAK(font-on-page)
        const resources = requireResolvedType(PDFDict, resolve(session, dictGetStrict(page.obj, PDFName.Resources), page));

        // FIXME: Page.Resources.Font could legitimately return null/undefined.
        // In which case, we need to create it.
        const pageFonts = requireResolvedType(PDFDict, resolve(session, dictGetStrict(resources.obj, PDFName.Font), resources));
        const fontKey = pageFonts.obj.uniqueKey(font.name);
        pageFonts.obj.set(fontKey, font.ref);

        markDirty(session, pageFonts);
        // END(font-on-page)

        // NOTE: These ctx.assign of things that seem to already exist are so
        // they exist in the indirect object list in PDFContext, and will then
        // be written when serializing.  It might be good to have some kind of
        // `markDirty` helper that communicates the intent more clearly.
        markDirty(session, page);

        contentStream.obj.push(
            ...drawText('hello\nfriend', {
                font,
                fontKey,
                lineHeight: 20,
                size: 14,
                x: 10,
                y: 100,
            })
        );

        const outbuf = await PDFWriter.forContext(session.ctx, 50, false).serializeToBuffer(statSync(testPath).size);

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

function makeIndirect<T extends PDFObject>(ref: PDFRef, obj: T): IndirectObject<T> {
    return {
        type: 'indirect',
        root: [ref, obj],
        ref,
        obj,
    };
}

// FIXME: This needs a better name.  It deals with the trailer *and* creates a
// cross reference lookup table.
function populateXrefLookupTable(
    ctx: PDFContext,
    stream: IByteStream,
    offset: number,
    lut: Map<PDFRef, number>,
): PDFDict {
    stream.moveTo(offset);

    const trailerParser = PDFParser.forByteStreamWithOptions(stream, ctx);
    const xrefSection = trailerParser.maybeParseCrossRefSection();
    if (!xrefSection) {
        // TODO: Throw a malformed file error (maybe an appropriate class exists
        // in one of the error.ts files).
        throw new Error('xrefSection is null');
    }

    for (let foo of xrefSection.subsections) {
        for (let entry of foo) {
            lut.set(entry.ref, entry.offset);
        }
    }

    const trailerDict = trailerParser.maybeParseTrailerPDFDict();
    if (!trailerDict) {
        // TODO: Throw a malformed file error (maybe an appropriate class exists
        // in one of the error.ts files).
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
        populateXrefLookupTable(ctx, stream, prevOffset.asNumber(), lut);
    }

    // According to the spec, the final trailer dict should already have all the
    // values copied forward from previous trailers (except the Prev attribute,
    // which is particular to each trailer).  So, return the first one encountered.
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

type IncrementalSession = {
    ctx: PDFContext,
    stream: IByteStream,
    parser: PDFParser,
    xrefs: Map<PDFRef, number>;
};

function discoverTrailerOffset(block: Block, ctx?: PDFContext): number {
    let lastLineExt = precedingLineExtents(block);
    let xrefOffsetExt = precedingLineExtents(block, lastLineExt.start);
    let startxrefMarkerExt = precedingLineExtents(block, xrefOffsetExt.start);

    const parser = PDFParser.forBytes(
        block.buffer.slice(startxrefMarkerExt.start),
        ctx ?? PDFContext.create(),
    );

    if (!hackParser(parser).matchKeyword(Keywords.startxref)) {
        // FIXME: find/make an appropriate error
        throw new Error('malformed PDF');
    }

    const xrefOffset = parser.parseObject();
    assertIs(xrefOffset, 'startxref', [[PDFNumber, 'PDFNumber']]);
    return (xrefOffset as PDFNumber).asNumber();
}

type DocumentSource = PathLike | Uint8Array;

function startSession(source: DocumentSource): IncrementalSession {
    let finalBlock: Block;
    let stream: IByteStream;
    if (source instanceof Uint8Array) {
        finalBlock = {
            buffer: source,
            atBof: true,
            atEof: true,
        };
        stream = ByteStream.of(source);
    } else {
        finalBlock = readFinalBlock(source, Buffer.allocUnsafe(1024));
        stream = new FileByteStream(source)
    }
    const xrefOffset = discoverTrailerOffset(finalBlock);

    const ctx = PDFContext.create();
    const xrefs: Map<PDFRef, number> = new Map();
    const trailerDict = populateXrefLookupTable(ctx, stream, xrefOffset, xrefs);
    updateTrailerInfo(ctx, trailerDict);

    // Update ctx.largestObjectNumber to reflect the objects we have seen in
    // all the xref tables.
    xrefs.forEach((offset_, ref) =>
        ctx.largestObjectNumber = Math.max(ctx.largestObjectNumber, ref.objectNumber)
    );

    return {
        ctx,
        parser: PDFParser.forByteStreamWithOptions(stream, ctx),
        stream,
        xrefs,
    };
}

function markDirty(session: IncrementalSession, obj: ResolvedObject<PDFObject>) {
    session.ctx.assign(...obj.root);
}

function updateTrailerInfo(ctx: PDFContext, trailerDict: PDFDict) {
    // FIXME: pdf-lib only deals with these trailer properties, but there
    // are more possible.  The spec says that all properties except Prev
    // should be copied forward in incremental updates.
    ctx.trailerInfo.Encrypt = trailerDict.get(PDFName.of('Encrypt'));
    ctx.trailerInfo.ID = trailerDict.get(PDFName.of('ID'));
    ctx.trailerInfo.Info = trailerDict.get(PDFName.of('Info'));
    ctx.trailerInfo.Root = requireOfType(PDFRef, trailerDict.get(PDFName.of('Root')));
}

type DirectObject<T extends PDFObject> = {
    type: 'direct',
    root: [PDFRef, PDFObject],
    obj: T,
};

type IndirectObject<T extends PDFObject> = {
    type: 'indirect',
    root: [PDFRef, PDFObject],
    ref: PDFRef,
    obj: T,
};

type ResolvedObject<T extends  PDFObject> = DirectObject<T> | IndirectObject<T>;

function resolve(
    session: IncrementalSession,
    ref: PDFRef,
): ResolvedObject<PDFObject>;

function resolve(
    session: IncrementalSession,
    objOrRef: PDFObject,
    rootOrAncestor?: [PDFRef, PDFObject] | ResolvedObject<any>,
): ResolvedObject<PDFObject>;

function resolve(
    session: IncrementalSession,
    objOrRef: PDFObject,
    rootOrAncestor?: [PDFRef, PDFObject] | ResolvedObject<any>,
): ResolvedObject<PDFObject> {
    if (objOrRef instanceof PDFRef) {
        const ref = objOrRef;
        const offset = session.xrefs.get(ref);
        if (offset === undefined) {
            // FIXME: Use an existing error from one of the errors.ts, or
            // introduce a new appropriate one.
            throw new Error('unknown ref');
        }

        const { stream, parser } = session;

        stream.moveTo(offset);
        // FIXME: Need to switch to parser.parseIndirectObject, to get object stream handling.
        const readRef = parser.parseIndirectObjectHeader();
        if (readRef !== ref) {
            // FIXME: Custom/appropriate error.
            throw new Error('corrupted xref table');
        }
        const obj = parser.parseObject();
        return {
            type: 'indirect',
            root: [ref, obj],
            ref,
            obj,
        };
    }

    if (rootOrAncestor === undefined) {
        throw new Error('cannot resolve direct object without root or ancestor');
    }

    return {
        type: 'direct',
        root: Array.isArray(rootOrAncestor) ? rootOrAncestor : rootOrAncestor.root,
        obj: objOrRef,
    };
}

function clone<
    T extends ResolvedObject<U>,
    U extends PDFObject,
>(value: T, newRoot?: PDFRef, ctx?: PDFContext): T {
    return Object.assign({}, value, {
        obj: value.obj.clone(ctx),
        root: newRoot ?? value.root,
    });
}

function unreachable(_x: never): never {
    throw new Error('unreachable');
}

function isResolvedType<T extends PDFObject>(
    type: Function & { prototype: T },
    obj: ResolvedObject<PDFObject>,
): obj is ResolvedObject<T> {
    return isOfType(type, obj.obj);
}

function requireResolvedType<T extends PDFObject>(
    type: Function & { prototype: T },
    obj: ResolvedObject<PDFObject>,
): ResolvedObject<T> {
    assertOfType(type, obj.obj);
    return obj as ResolvedObject<T>;
}

function dictSet(dict: PDFDict, key: PDFName, value: ResolvedObject<PDFObject>) {
    switch (value.type) {
        case 'direct':
            dict.set(key, value.obj);
            break;
        case 'indirect':
            dict.set(key, value.ref);
            break;
        default:
            unreachable(value);
    }
}

function dictGetStrict(dict: PDFDict, key: PDFName, preservePDFNull?: boolean): PDFObject {
    const value = dict.get(key, preservePDFNull);
    if (value === undefined) {
        // TODO: Nicer message
        throw new Error('undefined')
    }
    return value;
}