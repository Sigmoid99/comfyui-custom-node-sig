import { app } from "../../scripts/app.js";

// ############################################################
// ################## Novel AI 전용 함수 #######################
// ############################################################

// gzip 해제
async function gunzip(bytes) {

    const ds = new DecompressionStream("gzip");

    const writer = ds.writable.getWriter();

    writer.write(bytes);

    writer.close();

    const result =
        await new Response(ds.readable).arrayBuffer();

    return new Uint8Array(result);
}

// Uint8Array -> 문자열
function bytesToString(bytes) {

    return new TextDecoder().decode(bytes);
}

// bits -> Uint8Array
function bitsToBytes(bits) {

    const out = new Uint8Array(bits.length >> 3);

    for (let i = 0; i < out.length; i++) {

        out[i] = parseInt(
            bits.substr(i * 8, 8),
            2
        );
    }

    return out;
}

// 비트 -> 문자열
function bitsToString(bits) {

    let s = "";

    for (let i = 0; i + 8 <= bits.length; i += 8) {

        s += String.fromCharCode(
            parseInt(bits.slice(i, i + 8), 2)
        );
    }

    return s;
}

function getPNGInfo(buffer) {

    const data = new Uint8Array(buffer);

    return {
        width: readUint32BE(data,16),
        height: readUint32BE(data,20),
        bitDepth: data[24],
        colorType: data[25]
    };
}

// order: "row" (y바깥,x안쪽) 또는 "col" (x바깥,y안쪽)
function extractBits(pixelData, width, height, bppSource, mode, order) {
    const stride = width * bppSource;
    let bits = "";

    const pushBitsForPixel = (x, y) => {
        const base = y * stride + x * bppSource;
        if (mode === "alpha") {
            bits += (pixelData[base + 3] & 1);
        } else {
            bits += pixelData[base] & 1;
            bits += pixelData[base + 1] & 1;
            bits += pixelData[base + 2] & 1;
        }
    };

    if (order === "row") {
        for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++)
                pushBitsForPixel(x, y);
    } else {
        for (let x = 0; x < width; x++)
            for (let y = 0; y < height; y++)
                pushBitsForPixel(x, y);
    }
    return bits;
}

// unfilterPNG가 쓰는 Paeth 예측 알고리즘
function paethPredictor(a, b, c) {

    const p = a + b - c;

    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);

    if (pa <= pb && pa <= pc)
        return a;

    if (pb <= pc)
        return b;

    return c;
}

// RGB 정렬
function unfilterPNG(raw, width, height, colorType) {

    let bpp;

    if (colorType === 6) {
        bpp = 4; // RGBA
    }
    else if (colorType === 2) {
        bpp = 3; // RGB
    }
    else {
        throw new Error(
            "Unsupported PNG color type: " + colorType
        );
    }


    const stride = width * bpp;

    const out = new Uint8Array(height * stride);

    let inPos = 0;
    let outPos = 0;


    for (let y = 0; y < height; y++) {

        const filter = raw[inPos++];

        for (let x = 0; x < stride; x++) {

            const val = raw[inPos++];

            const left =
                x >= bpp
                    ? out[outPos+x-bpp]
                    : 0;

            const up =
                y > 0
                    ? out[outPos-stride+x]
                    : 0;

            const upLeft =
                (y>0 && x>=bpp)
                    ? out[outPos-stride+x-bpp]
                    : 0;


            switch(filter){

                case 0:
                    out[outPos+x]=val;
                    break;

                case 1:
                    out[outPos+x]=(val+left)&255;
                    break;

                case 2:
                    out[outPos+x]=(val+up)&255;
                    break;

                case 3:
                    out[outPos+x]=(val+((left+up)>>1))&255;
                    break;

                case 4:
                    out[outPos+x]=
                        (val+paethPredictor(left,up,upLeft))&255;
                    break;
            }
        }

        outPos += stride;
    }

    return out;
}

function summarizeNovelAIPrompt(text) {

    try {
        const outer = JSON.parse(text);
        const info = JSON.parse(outer.Comment);

        // ===== 디버그용: 전체 프롬프트 구조 확인 =====
        console.log("[NovelAI] outer(raw) =", outer);
        console.log("[NovelAI] info(Comment 파싱결과) =", info);
        console.log("[NovelAI] info(JSON, 트리로 보기) =\n" + JSON.stringify(info, null, 2));

        if (info.v4_prompt) {
            console.log("[NovelAI] v4_prompt =", JSON.stringify(info.v4_prompt, null, 2));
        }
        if (info.v4_negative_prompt) {
            console.log("[NovelAI] v4_negative_prompt =", JSON.stringify(info.v4_negative_prompt, null, 2));
        }

        const result = [];
        result.push("========== SUMMARY ==========");
        result.push("");
        result.push(`Software : ${outer.Software || ""}`);
        result.push(`Model    : ${outer.Source || ""}`);
        result.push(`Time     : ${outer["Generation time"] || ""}`);
        result.push("");

        const fields = [
            ["Seed", "seed"],
            ["Steps", "steps"],
            ["CFG", "scale"],
            ["Sampler", "sampler"],
            ["Scheduler", "noise_schedule"],
            ["Width", "width"],
            ["Height", "height"]
        ];

        for (const [title, key] of fields) {
            if (info[key] !== undefined) {
                result.push(`${title}: ${info[key]}`);
            }
        }
        result.push("");

        // v4_prompt / v4_negative_prompt 안의 base_caption + char_captions를 합쳐줌
        const buildV4Text = (v4) => {
            const caption = v4 && v4.caption;
            if (!caption) return null;

            const parts = [];

            if (caption.base_caption && caption.base_caption.trim()) {
                parts.push(caption.base_caption.trim());
            }

            if (Array.isArray(caption.char_captions)) {
                for (const c of caption.char_captions) {
                    if (c && c.char_caption && c.char_caption.trim()) {
                        parts.push(c.char_caption.trim());
                    }
                }
            }

            return parts.length ? parts.join('\n\n') : null;
        };

        const positiveFromV4 = buildV4Text(info.v4_prompt);
        const negativeFromV4 = buildV4Text(info.v4_negative_prompt);

        return {
            summary: result.join("\n"),
            positive:
                positiveFromV4 ||
                info.prompt ||
                outer.Description ||
                "",

            negative:
                negativeFromV4 ||
                info.uc ||
                ""
        };
    }
    catch (err) {
        return {
            summary: "NovelAI Parse Error\n\n" + err,
            positive: "",
            negative: ""
        };
    }
}

// Stealth PNG 읽기
async function decodeStealth(bits) {

    const signatures = [
        "stealth_pnginfo",
        "stealth_pngcomp",
        "stealth_rgbinfo",
        "stealth_rgbcomp"
    ];

    for (const sig of signatures) {

        const sigBits = sig.length * 8;

        if (bits.length < sigBits + 32) {
            continue;
        }

        const sigText = bitsToString(bits.substr(0, sigBits));

        if (sigText !== sig)
            continue;

        const lenBits = bits.substr(sigBits, 32);
        const bitLength = parseInt(lenBits, 2);

        const payloadBits = bits.substr(sigBits + 32, bitLength);

        const payload = bitsToBytes(payloadBits);

        let data = payload;

        if (sig.endsWith("comp")) {
            try {
                data = await gunzip(payload);
            } catch (e) {
                console.error(`[gunzip] FAILED:`, e);
                continue; // 실패시 다음 시그니처로
            }
        }

        return {
            signature: sig,
            compressed: sig.endsWith("comp"),
            rgb: sig.includes("_rgb"),
            alpha: sig.includes("_png"),
            bitLength,
            text: bytesToString(data)
        };
    }
    return null;
}

// IDAT 데이터모으기
function collectIDAT(buffer) {

    const data = new Uint8Array(buffer);

    let pos = 8;

    const chunks = [];

    while (pos + 8 < data.length) {

        const len = readUint32BE(data, pos);
        pos += 4;

        const type = decodeText(data.slice(pos, pos + 4));
        pos += 4;

        if (type === "IDAT") {

            chunks.push(data.slice(pos, pos + len));
        }

        pos += len + 4;

        if (type === "IEND")
            break;
    }

    let total = 0;

    for (const c of chunks)
        total += c.length;

    const merged = new Uint8Array(total);

    let off = 0;

    for (const c of chunks) {

        merged.set(c, off);

        off += c.length;
    }

    return merged;
}

// ############################################################
// ################## Novel AI 함수 끝 ########################
// ############################################################

function removeStableDiffusionPositivePrompt(text) {
    if (!text || typeof text !== "string")
        return text;

    const start = text.indexOf("parameters:");
    const end = text.indexOf("Negative prompt:");

    // 둘 다 존재하지 않으면 원본 유지
    if (start === -1 || end === -1)
        return text;

    // parameters 시작부터 Negative prompt 직전까지 제거
    return (
        text.substring(0, start) +
        text.substring(end)
    ).trim();
}

function summarizeStableDiffusionExif(text) {

    if (!text)
        return null;


    // Python dict → parameters 추출
    const match = text.match(
        /['"]parameters['"]\s*:\s*['"]([\s\S]*?)['"]\s*[,}]/
    );


    if (!match)
        return null;


    let parameters = match[1];


    // escape 복원
    parameters = parameters
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");


    const info =
        summarizeWebUIreforgePrompt(parameters);


    const result = [];

    result.push("========== SUMMARY ==========");
    result.push("");

    if(info.summary)
        result.push(info.summary);

    let summary = result.join("\n");

    summary = removeStableDiffusionPositivePrompt(summary);

    return {

        summary: summary,

        positive: info.positive,

        negative: info.negative
    };
}

function decodeAnyUserComment(bytes) {

    if (!bytes || bytes.length === 0)
        return "";


    let data = bytes;


    // EXIF charset header 제거
    if (data.length >= 8) {

        const header =
            String.fromCharCode(...data.slice(0,8));


        if (
            header.startsWith("ASCII") ||
            header.startsWith("UNICODE") ||
            header.startsWith("JIS")
        ) {
            data = data.slice(8);
        }
    }


    // UTF-16LE + 00 padding 제거
    let cleaned = [];

    for(let i=0;i<data.length;i++){

        // 4바이트마다 뒤쪽 2 NULL 제거
        if(
            i % 2 === 1 &&
            data[i] === 0 &&
            data[i+1] === 0
        ){
            continue;
        }

        cleaned.push(data[i]);
    }


    data = new Uint8Array(cleaned);



    // BOM UTF-16
    if(data[0]===0xff && data[1]===0xfe){

        return new TextDecoder("utf-16le")
            .decode(data.slice(2))
            .replace(/\0/g,"")
            .trim();
    }


    // 일반 UTF-16LE
    if(data.length>=2){

        let zeroCount=0;

        for(let i=1;i<data.length;i+=2){

            if(data[i]===0)
                zeroCount++;
        }


        if(zeroCount > data.length/8){

            return new TextDecoder("utf-16le")
                .decode(data)
                .replace(/\0/g,"")
                .trim();
        }
    }


    return new TextDecoder("utf-8")
        .decode(data)
        .replace(/\0/g,"")
        .trim();
}

function extractWebPUserComment(tiff) {

    if(!tiff)
        return "";


    const little =
        tiff[0] === 0x49 &&
        tiff[1] === 0x49;


    if(!little &&
       !(tiff[0]===0x4d && tiff[1]===0x4d))
        return "";


    const rd16 = (o)=>{

        if(little)
            return tiff[o] | (tiff[o+1]<<8);

        return (tiff[o]<<8)|tiff[o+1];
    };


    const rd32 = (o)=>{

        if(little)
            return (
                tiff[o] |
                (tiff[o+1]<<8) |
                (tiff[o+2]<<16) |
                (tiff[o+3]<<24)
            )>>>0;


        return (
            (tiff[o]<<24) |
            (tiff[o+1]<<16) |
            (tiff[o+2]<<8) |
            tiff[o+3]
        )>>>0;
    };


    function scanIFD(offset){

        if(offset <=0 || offset+2 > tiff.length)
            return "";


        const count=rd16(offset);


        for(let i=0;i<count;i++){

            const p=offset+2+i*12;

            if(p+12>tiff.length)
                break;


            const tag=rd16(p);
            const type=rd16(p+2);
            const num=rd32(p+4);


            const typeSize={
                1:1,
                2:1,
                3:2,
                4:4,
                7:1
            }[type] || 1;


            const size=num*typeSize;


            let valueOffset;


            if(size<=4)
                valueOffset=p+8;
            else
                valueOffset=rd32(p+8);



            // UserComment
            if(tag===0x9286){

                return decodeAnyUserComment(
                    tiff.slice(
                        valueOffset,
                        valueOffset+size
                    )
                );
            }


            // ExifIFD pointer
            if(tag===0x8769){

                const result =
                    scanIFD(rd32(p+8));

                if(result)
                    return result;
            }
        }


        return "";
    }


    return scanIFD(rd32(4));
}

function readUint32BE(data, offset) {
    return (
        (data[offset] << 24) |
        (data[offset + 1] << 16) |
        (data[offset + 2] << 8) |
        data[offset + 3]
    ) >>> 0;
}

function readUint16BE(data, offset) {
    return (data[offset] << 8) | data[offset + 1];
}

function readUint32LE(data, offset) {
    return (
        data[offset] |
        (data[offset + 1] << 8) |
        (data[offset + 2] << 16) |
        (data[offset + 3] << 24)
    ) >>> 0;
}

function decodeText(bytes) {
    return new TextDecoder("utf-8").decode(bytes);
}

async function parsePNGChunks(buffer) {

    const data = new Uint8Array(buffer);
    const result = [];
    let pos = 8;

    while (pos + 8 < data.length) {

        const length = readUint32BE(data, pos);
        pos += 4;

        const type = decodeText(data.slice(pos, pos + 4));
        pos += 4;

        const chunkData = data.slice(pos, pos + length);
        pos += length;
        pos += 4;

        try {

            if (type === "tEXt") {

                const zero = chunkData.indexOf(0);
                if (zero !== -1) {
                    const key = decodeText(chunkData.slice(0, zero));
                    const value = decodeText(chunkData.slice(zero + 1));
                    result.push(`[tEXt] ${key}`);
                    result.push(value);
                    result.push("");
                }
            }

            else if (type === "iTXt") {

                const zero = chunkData.indexOf(0);

                if (zero !== -1) {

                    const key = decodeText(chunkData.slice(0, zero));

                    let p = zero + 1;

                    const compressionFlag = chunkData[p];
                    p += 1;
                    p += 1; // compression method (항상 0 = zlib/deflate)

                    const langEnd = chunkData.indexOf(0, p);
                    if (langEnd === -1) continue;
                    p = langEnd + 1;

                    const translatedEnd = chunkData.indexOf(0, p);
                    if (translatedEnd === -1) continue;
                    p = translatedEnd + 1;

                    const textBytes = chunkData.slice(p);

                    let value;
                    if (compressionFlag === 1) {
                        // zlib 압축된 iTXt → 압축 해제 필요
                        const inflated = await inflateIDAT(textBytes);
                        value = decodeText(inflated);
                    } else {
                        value = decodeText(textBytes);
                    }

                    result.push(`[iTXt] ${key}`);
                    result.push(value);
                    result.push("");
                }
            }

        } catch (e) {
            result.push(`ERROR parsing ${type}: ${e}`);
        }

        if (type === "IEND")
            break;
    }

    return result.join("\n");
}

function extractTextChunkMap(metadataText) {
    const map = {};
    const regex = /\[(?:iTXt|tEXt)\]\s*([^\n]+)\n([\s\S]*?)(?=\n\[(?:iTXt|tEXt)\]|$)/g;
    let m;
    while ((m = regex.exec(metadataText)) !== null) {
        const key = m[1].trim();
        const value = m[2].replace(/\n+$/, "").trim();
        map[key] = value;
    }
    return map;
}

// IDAT 압축해제
async function inflateIDAT(idatBytes) {

    const ds = new DecompressionStream("deflate");

    const writer = ds.writable.getWriter();
    writer.write(idatBytes);
    writer.close();

    const buffer =
        await new Response(ds.readable).arrayBuffer();

    return new Uint8Array(buffer);
}

// JPEG APP1(Exif) 세그먼트에서 TIFF 블록만 잘라냄
function findJPEGExifTiff(buffer) {

    const data = new Uint8Array(buffer);

    if (data[0] !== 0xFF || data[1] !== 0xD8)
        return null; // JPEG 시그니처 아님

    let pos = 2;

    while (pos + 4 <= data.length) {

        if (data[pos] !== 0xFF)
            break;

        const marker = data[pos + 1];

        if (marker === 0xDA) // SOS(스캔 시작) → 여기부터 이미지 데이터
            break;

        if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD7)) {
            pos += 2;
            continue;
        }

        const segLen = readUint16BE(data, pos + 2);
        const segStart = pos + 4;

        if (marker === 0xE1) { // APP1

            const isExif =
                data[segStart] === 0x45 && data[segStart + 1] === 0x78 &&
                data[segStart + 2] === 0x69 && data[segStart + 3] === 0x66 &&
                data[segStart + 4] === 0x00 && data[segStart + 5] === 0x00;

            if (isExif) {
                return data.slice(segStart + 6, segStart + segLen - 2);
            }
        }

        pos = segStart + segLen - 2;
    }

    return null;
}

// WebP RIFF 컨테이너의 EXIF 청크에서 TIFF 블록만 잘라냄
function findWebPExifTiff(buffer) {

    const data = new Uint8Array(buffer);

    const isRIFF = decodeText(data.slice(0, 4)) === "RIFF";
    const isWEBP = decodeText(data.slice(8, 12)) === "WEBP";

    if (!isRIFF || !isWEBP)
        return null;

    let pos = 12;

    while (pos + 8 <= data.length) {

        const fourcc = decodeText(data.slice(pos, pos + 4));
        const size = readUint32LE(data, pos + 4);
        const chunkStart = pos + 8;

        if (fourcc === "EXIF") {

            let chunk = data.slice(chunkStart, chunkStart + size);

            // 일부 인코더는 "Exif\0\0" 프리픽스를 포함, 일부는 TIFF부터 바로 시작
            const hasPrefix =
                chunk.length > 6 &&
                chunk[0] === 0x45 && chunk[1] === 0x78 && chunk[2] === 0x69 &&
                chunk[3] === 0x66 && chunk[4] === 0x00 && chunk[5] === 0x00;

            return hasPrefix ? chunk.slice(6) : chunk;
        }

        pos = chunkStart + size + (size % 2); // 청크는 짝수 바이트로 패딩됨
    }

    return null;
}

// TIFF 구조 파싱 (JPEG APP1, WebP EXIF 청크 공용)
function parseTIFF(tiff) {

    const b0 = tiff[0], b1 = tiff[1];

    let little;
    if (b0 === 0x49 && b1 === 0x49) little = true;       // "II"
    else if (b0 === 0x4D && b1 === 0x4D) little = false; // "MM"
    else return null;

    const rd16 = (off) => little
        ? (tiff[off] | (tiff[off + 1] << 8))
        : ((tiff[off] << 8) | tiff[off + 1]);

    const rd32 = (off) => little
        ? ((tiff[off]) | (tiff[off + 1] << 8) | (tiff[off + 2] << 16) | (tiff[off + 3] << 24)) >>> 0
        : ((tiff[off] << 24) | (tiff[off + 1] << 16) | (tiff[off + 2] << 8) | tiff[off + 3]) >>> 0;

    const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

    function readIFD(offset) {

        const count = rd16(offset);
        const entries = [];

        for (let i = 0; i < count; i++) {

            const entryOff = offset + 2 + i * 12;
            const tag = rd16(entryOff);
            const type = rd16(entryOff + 2);
            const num = rd32(entryOff + 4);
            const size = (TYPE_SIZE[type] || 1) * num;

            const valueOffset = size > 4
                ? rd32(entryOff + 8)
                : entryOff + 8;

            entries.push({ tag, type, num, size, valueOffset });
        }

        return entries;
    }

    const ifd0Entries = readIFD(rd32(4));
    const tagMap = {};
    ifd0Entries.forEach(e => tagMap[e.tag] = e);

    // ExifIFD 서브 포인터(0x8769)가 있으면 그 안에서도 읽음 (UserComment는 보통 여기 있음)
    let exifIFDEntries = [];
    const exifPtr = tagMap[0x8769];
    if (exifPtr) {
        exifIFDEntries = readIFD(rd32(exifPtr.valueOffset));
    }

    const readValueBytes = (entry) => tiff.slice(entry.valueOffset, entry.valueOffset + entry.size);

    return { ifd0Entries, exifIFDEntries, readValueBytes };
}

// 문자열에서 첫 '[' 부터 짝이 맞는 ']' 까지만 잘라냄
// (배열 뒤에 "1536 * 1024 (3:2)" 같은 부가 텍스트가 붙어있어도 안전하게 자름)
function extractJsonArraySubstring(text) {

    const start = text.indexOf("[");
    if (start === -1) return null;

    let depth = 0;

    for (let i = start; i < text.length; i++) {

        const c = text[i];

        if (c === "[") depth++;
        else if (c === "]") {
            depth--;
            if (depth === 0) {
                return text.slice(start, i + 1);
            }
        }
    }

    return null;
}

// "pane": "positive"/"negative" 필드를 가진 블록 배열 형태를 감지해서
// 해당 pane에 속하는 text들만 골라 이어붙임.
// 이런 배열 형태가 아니면 원본 텍스트를 그대로 반환(다른 케이스에 영향 없음)
function extractPromptPaneText(rawText, pane) {

    if (!rawText || typeof rawText !== "string")
        return rawText;

    const trimmed = rawText.trim();

    if (!trimmed.startsWith("[") || !trimmed.includes('"pane"'))
        return rawText;

    const jsonSlice = extractJsonArraySubstring(trimmed);
    if (!jsonSlice) return rawText;

    try {

        const arr = JSON.parse(jsonSlice);
        if (!Array.isArray(arr)) return rawText;

        const parts = arr
            .filter(b =>
                b && b.pane === pane &&
                b.enabled !== false &&
                typeof b.text === "string" &&
                b.text.trim()
            )
            .map(b => b.text.trim());

        if (parts.length) {
            return parts.join(", ");
        }

    } catch (e) {
        // 파싱 실패 시 원본 그대로 반환 (폴백)
    }

    return rawText;
}

// UserComment(0x9286)는 앞 8바이트가 인코딩 지시자
function decodeUserComment(bytes) {

    if (!bytes || bytes.length < 8)
        return "";

    const code = Array.from(bytes.slice(0, 8)).map(b => String.fromCharCode(b)).join("");
    const rest = bytes.slice(8);

    if (code.startsWith("ASCII")) {
        return new TextDecoder("ascii").decode(rest).replace(/\0+$/, "");
    }

    if (code.startsWith("UNICODE")) {
        const len = rest.length - (rest.length % 2);
        const units = [];
        for (let i = 0; i < len; i += 2) {
            units.push(rest[i] | (rest[i + 1] << 8));
        }
        return String.fromCharCode(...units).replace(/\0+$/, "");
    }

    // 인코딩 지시자가 없거나 알 수 없으면 UTF-8로 시도
    return decodeText(rest).replace(/\0+$/, "");
}

// EXIF에서 얻을 수 있는 텍스트 필드들을 뽑음
// ComfyUI의 SaveAnimatedWEBP는 UserComment가 아니라
// Make(0x010F)/Model(0x0110) 같은 임의 ASCII 태그에 "workflow:{...}", "prompt:{...}" 형태로 저장함
// → 태그 번호에 의존하지 않고 모든 ASCII 필드를 훑어서 prefix로 판별
function extractExifTextFields(tiff) {

    const parsed = parseTIFF(tiff);
    if (!parsed) return {};

    const fields = {};
    let promptText = null;
    let workflowText = null;

    const allEntries = [...parsed.ifd0Entries, ...parsed.exifIFDEntries];

    for (const entry of allEntries) {


        let text;


        try {

            const bytes = parsed.readValueBytes(entry);


            if (entry.tag === 0x9286) {

                fields.UserComment =
                    decodeUserComment(bytes);

                continue;
            }


            if (entry.type !== 2)
                continue;


            text = decodeText(bytes).replace(/\0+$/, "");


        } catch(e) {
            continue;
        }

        if (!text)
            continue;

        // ComfyUI 관례: "workflow:{...}", "prompt:{...}"
        if (text.startsWith("workflow:")) {
            workflowText = text.slice("workflow:".length);
            continue;
        }

        if (text.startsWith("prompt:")) {
            promptText = text.slice("prompt:".length);
            continue;
        }

        // 표준 태그도 별도로 보관 (UserComment는 8바이트 인코딩 헤더가 있어 별도 처리)
        if (entry.tag === 0x9286) {
            fields.UserComment = decodeUserComment(parsed.readValueBytes(entry));
        } else if (entry.tag === 0x010E) {
            fields.ImageDescription = text;
        } else if (entry.tag === 0x0131) {
            fields.Software = text;
        } else {
            // 알 수 없는 태그도 혹시 모르니 보관 (raw 폴백용)
            fields[`tag_${entry.tag.toString(16)}`] = text;
        }
    }

    if (promptText) fields.__prompt = promptText;
    if (workflowText) fields.__workflow = workflowText;

    return fields;
}

function summarizeExifImage(fields) {

    // 0) ComfyUI 관례: workflow:/prompt: prefix로 저장된 경우 (PNG의 tEXt prompt/workflow와 동일 취급)
    if (fields.__prompt) {
        return summarizeComfyPrompt(fields.__prompt, fields.__workflow || null);
    }

    const raw = fields.UserComment || fields.ImageDescription || "";

    if (!raw) {
        return {
            summary: "EXIF 메타데이터에서 생성 정보를 찾지 못했습니다.",
            positive: "",
            negative: ""
        };
    }

    const trimmed = raw.trim();

    // Stable Diffusion WebUI / Forge EXIF
    const sdInfo = summarizeStableDiffusionExif(raw);

    if(sdInfo){
        return sdInfo;
    }

    if (trimmed.startsWith("{")) {

        try {
            const asJson = JSON.parse(trimmed);

            if (typeof asJson.prompt === "string") {
                return summarizeComfyPrompt(asJson.prompt, asJson.workflow || null);
            }

            const looksLikePromptGraph =
                Object.values(asJson).some(v => v && typeof v === "object" && "class_type" in v);

            if (looksLikePromptGraph) {
                return summarizeComfyPrompt(trimmed, null);
            }

            if (asJson.Comment) {
                return summarizeNovelAIPrompt(trimmed);
            }

        } catch (e) {
            // 폴백
        }
    }

    if (raw.includes("Negative prompt:")) {

        if (raw.includes("Version: neo-")) {
            return summarizeForgeNeoPrompt(raw);
        }

        return summarizeWebUIreforgePrompt(raw);
    }

    return {
        summary: "========== SUMMARY ==========\n\n(알 수 없는 형식, 원문 표시)\n\n" + raw,
        positive: raw,
        negative: ""
    };
}

// =====================컴피===================

const FLAT_POSITIVE_KEYS = ["positive_prompt", "positive", "prompt", "pos_prompt"];
const FLAT_NEGATIVE_KEYS = ["negative_prompt", "negative", "neg_prompt"];

function pickFirstString(obj, candidates) {
    for (const k of candidates) {
        if (typeof obj[k] === "string" && obj[k].trim())
            return obj[k];
    }
    return "";
}

function summarizeFlatPromptDict(obj) {

    const result = [];
    result.push("========== SUMMARY ==========");
    result.push("");

    const fields = [
        ["Model (unet)", "unet_name"],
        ["CLIP", "clip_name"],
        ["VAE", "vae_name"],
        ["Seed", "seed"],
        ["Steps", "steps"],
        ["CFG", "cfg"],
        ["Sampler", "sampler"],
        ["Scheduler", "scheduler"],
        ["Denoise", "denoise"],
        ["Width", "width"],
        ["Height", "height"],
        ["LoRA", "lora_stack"]
    ];

    for (const [label, key] of fields) {
        if (obj[key] !== undefined && obj[key] !== "") {
            result.push(`${label} : ${obj[key]}`);
        }
    }

    return {
        summary: result.join("\n"),
        positive: pickFirstString(obj, FLAT_POSITIVE_KEYS),
        negative: pickFirstString(obj, FLAT_NEGATIVE_KEYS)
    };
}

// 커스텀 노드가 json.dumps 대신 str(dict)로 저장한 경우 대응
// (작은따옴표 문자열, True/False/None 등 Python 문법 → JSON으로 변환)
function pythonDictLiteralToJSON(text) {

    let out = "";
    let i = 0;
    const len = text.length;

    while (i < len) {

        const ch = text[i];

        if (ch === "'") {

            out += '"';
            i++;

            while (i < len) {

                const c = text[i];

                if (c === "\\" && i + 1 < len) {
                    const next = text[i + 1];

                    if (next === "'") { out += "'"; i += 2; continue; }
                    if (next === "\\") { out += "\\\\"; i += 2; continue; }
                    if (next === "n") { out += "\\n"; i += 2; continue; }
                    if (next === "r") { out += "\\r"; i += 2; continue; }
                    if (next === "t") { out += "\\t"; i += 2; continue; }

                    // 그 외 백슬래시(예: \( )는 원본 그대로 → JSON에서는 이스케이프 필요
                    out += "\\\\" + next;
                    i += 2;
                    continue;
                }

                if (c === '"') { out += '\\"'; i++; continue; }

                if (c === "'") { out += '"'; i++; break; } // 문자열 종료

                out += c;
                i++;
            }

            continue;
        }

        out += ch;
        i++;
    }

    return out
        .replace(/\bTrue\b/g, "true")
        .replace(/\bFalse\b/g, "false")
        .replace(/\bNone\b/g, "null");
}

// 프롬프트 텍스트가 아닐 가능성이 높은 키 이름 (enum/설정값류)
const NON_TEXT_KEY_HINTS = /^(mode|method|type|blend_mode|sampler_name|scheduler|preset|format|filename|filename_prefix|extension|unit|seed_mode|control_mode)$/i;

// "프롬프트 텍스트처럼 보이는가" 휴리스틱 판별
function looksLikePromptText(key, value) {

    if (typeof value !== "string")
        return false;

    const trimmed = value.trim();
    if (!trimmed)
        return false;

    if (NON_TEXT_KEY_HINTS.test(key))
        return false;

    // 파일 경로/파일명처럼 보이면 제외 (확장자, 슬래시 등)
    if (/^[\w\-./\\]+\.(safetensors|ckpt|pt|pth|png|jpg|webp)$/i.test(trimmed))
        return false;

    // 너무 짧은 단일 단어(옵션값 가능성 높음, 예: "exact", "auto", "default")는 제외
    // 단, 쉼표/공백이 있으면 프롬프트일 가능성이 있으니 통과
    if (trimmed.length < 8 && !/[\s,]/.test(trimmed))
        return false;

    return true;
}

function resolveNodeText(data, nodeId, visited = new Set(), depth = 0, roleKeys = null) {

    if (!nodeId || visited.has(nodeId) || depth > 20)
        return "";

    visited.add(nodeId);

    const node = data[nodeId];
    if (!node)
        return "";

    const inputs = node.inputs || {};

    // 우선순위 1: 잘 알려진 표준 키
    const directTextKeys = ["populated_text", "result_text", "text", "text_0", "string", "value", "prompt"];

    for (const key of directTextKeys) {
        const val = inputs[key];
        if (typeof val === "string" && val.trim().length > 0) {
            return val;
        }
    }

    // 우선순위 2: 이어붙이기 노드 (text1, text2 ...)
    const concatKeys = Object.keys(inputs)
        .filter(k => /^text\d*$/.test(k))
        .sort();

    if (concatKeys.length) {
        const parts = [];
        for (const key of concatKeys) {
            const val = inputs[key];
            let resolved = "";
            if (Array.isArray(val)) {
                resolved = resolveNodeText(data, val[0], visited, depth + 1, roleKeys);
            } else if (typeof val === "string") {
                resolved = val;
            }
            if (resolved) parts.push(resolved);
        }
        if (parts.length) return parts.join(", ");
    }

    if (roleKeys) {
        for (const key of roleKeys) {
            const val = inputs[key];
            if (typeof val === "string" && val.trim()) {
                return val;
            }
            if (Array.isArray(val)) {
                const resolved = resolveNodeText(data, val[0], visited, depth + 1, roleKeys);
                if (resolved) return resolved;
            }
        }
    }

    for (const key of directTextKeys) {
        const val = inputs[key];
        if (Array.isArray(val)) {
            const resolved = resolveNodeText(data, val[0], visited, depth + 1, roleKeys);
            if (resolved) return resolved;
        }
    }

    // ★ 우선순위 5 (신규): 이름 모르는 커스텀 노드 범용 폴백
    // "프롬프트처럼 보이는" 문자열 input들을 전부 모아 이어붙임
    // 키 이름 알파벳순 정렬 대신, "길이가 긴 것부터"가 보통 본문(base_prompt)이 먼저 오게 함
    const leftover = Object.entries(inputs)
        .filter(([k, v]) => looksLikePromptText(k, v))
        .sort((a, b) => b[1].length - a[1].length) // 긴 텍스트(본문) 먼저
        .map(([, v]) => v.trim());

    if (leftover.length) {
        return leftover.join(", ");
    }

    return "";
}

// workflow(UI 원본) 그래프 파싱
function parseComfyWorkflowGraph(workflowJson) {

    const wfNodes = {};
    const linkById = {};
    const linkByTarget = {}; // "targetId:targetSlotIndex" -> linkId

    for (const n of workflowJson.nodes || []) {
        wfNodes[String(n.id)] = n;
    }

    for (const l of workflowJson.links || []) {

        const [linkId, originId, originSlot, targetId, targetSlot, type] = l;

        linkById[linkId] = {
            originId: String(originId),
            originSlot,
            targetId: String(targetId),
            targetSlot,
            type
        };

        linkByTarget[`${targetId}:${targetSlot}`] = linkId;
    }

    return { wfNodes, linkById, linkByTarget };
}

function getWFNode(wfGraph, nodeId) {
    return wfGraph?.wfNodes?.[String(nodeId)] || null;
}

// prompt json의 input 이름(예: "positive") -> workflow node.inputs 배열의 slot index
function getWFInputSlotIndex(wfNode, inputName) {

    if (!wfNode || !Array.isArray(wfNode.inputs))
        return -1;

    return wfNode.inputs.findIndex(i => i.name === inputName);
}

// nodeId의 특정 input이 "실제로 어느 노드/슬롯/타입"에서 왔는지 workflow 링크로 역추적
function traceOriginBySlotName(wfGraph, nodeId, inputName) {

    const wfNode = getWFNode(wfGraph, nodeId);
    const slotIndex = getWFInputSlotIndex(wfNode, inputName);

    if (slotIndex === -1)
        return null;

    const linkId = wfGraph.linkByTarget[`${nodeId}:${slotIndex}`];
    if (linkId === undefined)
        return null;

    const link = wfGraph.linkById[linkId];
    if (!link)
        return null;

    const originNode = getWFNode(wfGraph, link.originId);

    return {
        originId: link.originId,
        originSlot: link.originSlot,
        type: link.type,
        title: originNode?.title || originNode?.type || ""
    };
}

function collectUsedNodes(data, wfGraph) {

    const used = new Set();

    const endNodes = Object.entries(data).filter(
        ([, n]) => n && n.class_type &&
            /SaveImage|PreviewImage|SaveAnimatedWEBP|SaveAnimatedPNG|SaveAnimatedGIF|SaveVideo|VHS_VideoCombine/i.test(n.class_type)
    );
    function walk(nodeId) {

        if (!nodeId || used.has(nodeId))
            return;

        const node = data[nodeId];
        if (!node)
            return;

        if (isBypassed(node, getWFNode(wfGraph, nodeId)))
            return;

        used.add(nodeId);

        for (const val of Object.values(node.inputs || {})) {
            if (Array.isArray(val) && val.length >= 1 && data[val[0]] !== undefined) {
                walk(String(val[0]));
            }
        }
    }

    if (endNodes.length) {
        endNodes.forEach(([id]) => walk(id));
    } else {
        Object.keys(data).forEach(walk);
    }

    return used;
}

// workflow의 CONDITIONING 타입 input들을 슬롯 순서대로 뽑아옴
// (이름 매칭이 실패했을 때 폴백용 — 커스텀/비표준 노드 대응)
function findConditioningLinksByType(nodeId, wfGraph) {

    const wfNode = getWFNode(wfGraph, nodeId);
    if (!wfNode || !Array.isArray(wfNode.inputs))
        return [];

    const results = [];

    wfNode.inputs.forEach((inp, idx) => {

        if (inp.type !== "CONDITIONING")
            return;

        const linkId = wfGraph.linkByTarget[`${nodeId}:${idx}`];
        const link = linkId !== undefined ? wfGraph.linkById[linkId] : null;

        if (link) {
            results.push({
                inputName: inp.name,
                originNodeId: link.originId,
                originTitle: getWFNode(wfGraph, link.originId)?.title || ""
            });
        }
    });

    return results;
}

// bypass/mute 판별: workflow의 mode를 우선하고, 없으면 prompt json의 mode로 폴백
function isBypassed(promptNode, wfNode) {

    const mode = (wfNode && typeof wfNode.mode === "number")
        ? wfNode.mode
        : promptNode?.mode;

    return mode === 4 || mode === 2;
}

// ---------- 역할 판별 (class_type이 아니라 입력 패턴 기반) ----------

function isSamplerLike(node) {

    const keys = Object.keys(node.inputs || {});

    return ["seed", "steps", "cfg"].every(k => keys.includes(k));
}

function isCheckpointLike(node) {

    const keys = Object.keys(node.inputs || {});

    return keys.some(k => /ckpt_name|ckpt/i.test(k));
}

function isClipLoaderLike(node) {

    const keys = Object.keys(node.inputs || {});

    return keys.some(k => /^clip_name/i.test(k));
}

function isVaeLoaderLike(node) {

    const keys = Object.keys(node.inputs || {});

    return keys.some(k => /^vae_name/i.test(k));
}

// Power Lora Loader류(lora_1, lora_2 ... 객체) + 단일 LoraLoader류(lora_name+strength_model) 모두 지원
function extractLorasFromNode(node) {

    const found = [];

    const inputs = node.inputs || {};

    for (const key in inputs) {

        const val = inputs[key];

        // Power Lora Loader (rgthree) 스타일: { on, lora, strength }
        if (
            key.startsWith("lora_") &&
            val && typeof val === "object" &&
            "lora" in val
        ) {
            if (val.on) {
                found.push(`${val.lora} (${val.strength})`);
            }
            continue;
        }
    }

    // 단일 LoraLoader 스타일: lora_name + strength_model
    if (
        typeof inputs.lora_name === "string" &&
        inputs.lora_name &&
        (typeof inputs.strength_model === "number" || typeof inputs.strength === "number")
    ) {
        const strength = inputs.strength_model ?? inputs.strength;
        found.push(`${inputs.lora_name} (${strength})`);
    }

    return found;
}

// CONDITIONING 타입 링크 중 positive/negative 후보 키를 폭넓게 매칭
function findConditioningLink(inputs, candidateKeys) {

    for (const key of candidateKeys) {

        const val = inputs[key];

        if (Array.isArray(val))
            return val[0];
    }

    return null;
}

const POSITIVE_KEYS = ["positive", "pos", "cond_pos", "positive_conditioning"];
const NEGATIVE_KEYS = ["negative", "neg", "cond_neg", "negative_conditioning"];

// ---------- 키워드 기반 휴리스틱 분류 (커스텀/미지 노드용 폴백) ----------

// 부정 프롬프트에 자주 등장하는 품질/결함 태그
const NEGATIVE_HINT_WORDS = [
    "low quality", "worst quality", "bad quality", "normal quality",
    "blurry", "watermark", "signature", "username", "artist name",
    "jpeg artifacts", "bad anatomy", "bad hands", "bad feet",
    "extra fingers", "fewer fingers", "missing fingers", "fused fingers",
    "extra limbs", "missing limbs", "extra digit", "mutated hands",
    "long neck", "deformed", "disfigured", "mutation", "mutated",
    "cropped", "lowres", "error", "ugly", "duplicate",
    "logo", "unfinished", "poorly drawn", "score_1"
];

// 긍정 프롬프트에 자주 등장하는 퀄리티 태그
const POSITIVE_QUALITY_WORDS = [
    "masterpiece", "best quality", "high quality", "ultra-detailed",
    "ultra detailed", "highres", "absurdres", "amazing quality",
    "very aesthetic", "newest", "detailed", "score_9"
];

// 인물/피사체를 나타내는 태그 (보통 긍정 프롬프트에만 등장)
const SUBJECT_WORDS = [
    "1girl", "1boy", "2girls", "2boys", "girl", "boy", "woman", "man",
    "solo", "multiple girls", "multiple boys", "female", "male"
];

// 쉼표/괄호 등 태그 구분자 경계를 고려해 단어(구)가 포함됐는지 확인
// (예: "man"이 "woman" 안의 부분 문자열로 오탐되는 것을 방지)
function containsTagHint(lowerText, hint) {
    const escaped = hint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[,._\\s(])${escaped}([,._\\s):]|$)`, "i");
    return re.test(lowerText);
}

// 텍스트 하나를 긍정/부정 성향으로 점수화
function scorePromptCandidate(text) {

    if (!text || typeof text !== "string")
        return { positive: 0, negative: 0 };

    const lower = text.toLowerCase();

    let positive = 0;
    let negative = 0;

    for (const w of NEGATIVE_HINT_WORDS) {
        if (containsTagHint(lower, w)) negative += 2;
    }

    for (const w of POSITIVE_QUALITY_WORDS) {
        if (containsTagHint(lower, w)) positive += 2;
    }

    for (const w of SUBJECT_WORDS) {
        if (containsTagHint(lower, w)) positive += 1;
    }

    // 작가 태그: "@이름", "artist:이름"
    if (/@[a-z0-9_]+/i.test(text)) positive += 1;
    if (/\bartist\s*:/i.test(text)) positive += 1;

    return { positive, negative };
}

// 텍스트에 부정 힌트 단어가 하나라도 있는지 (구조분석 결과 검증용)
function containsAnyNegativeHint(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    return NEGATIVE_HINT_WORDS.some(w => containsTagHint(lower, w));
}

// used 노드들의 문자열 input을 전부 모아 프롬프트 후보로 만듦
function collectPromptCandidates(data, usedNodes) {

    const candidates = [];

    for (const nodeId of usedNodes) {

        const node = data[nodeId];
        if (!node) continue;

        const inputs = node.inputs || {};

        for (const key in inputs) {

            const val = inputs[key];

            if (typeof val !== "string" || !val.trim())
                continue;

            if (!looksLikePromptText(key, val))
                continue;

            const score = scorePromptCandidate(val);

            candidates.push({
                nodeId,
                key,
                text: val.trim(),
                positive: score.positive,
                negative: score.negative
            });
        }
    }

    return candidates;
}

// 후보들 중에서 가장 그럴듯한 긍정/부정 프롬프트를 뽑음
function pickPromptsByHeuristic(candidates) {

    if (!candidates.length)
        return { positive: "", negative: "" };

    // 부정 후보: 부정 점수가 0보다 크고, 긍정 점수보다 같거나 높은 것 우선
    const negCandidates = candidates
        .filter(c => c.negative > 0 && c.negative >= c.positive)
        .sort((a, b) => b.negative - a.negative);

    const negativePick = negCandidates[0] || null;

    // 긍정 후보: 부정으로 뽑힌 것을 제외하고 긍정 점수가 가장 높은 것
    const posCandidates = candidates
        .filter(c => c !== negativePick)
        .sort((a, b) => b.positive - a.positive);

    const positivePick = posCandidates.find(c => c.positive > 0) || posCandidates[0] || null;

    return {
        positive: positivePick ? positivePick.text : "",
        negative: negativePick ? negativePick.text : ""
    };
}

// ---------- 컴피 메인 함수 ----------

function summarizeComfyPrompt(promptJson, workflowJsonText) {

    try {

        const data = parseComfyWorkflow(promptJson);

        if (!data) {
            return { summary: "Workflow parse failed", positive: "", negative: "" };
        }

        let wfGraph = null;

        if (workflowJsonText) {
            try {
                const wfJson = parseComfyWorkflow(workflowJsonText);
                if (wfJson) wfGraph = parseComfyWorkflowGraph(wfJson);
            } catch (e) {
                console.warn("workflow graph parse failed", e);
            }
        }

        const used = collectUsedNodes(data, wfGraph);

        let checkpoint = "", clip = "", vae = "";
        const loras = [];
        const samplers = [];

        for (const nodeId of used) {

            const node = data[nodeId];
            if (!node) continue;

            if (isCheckpointLike(node)) {
                const key = Object.keys(node.inputs).find(k => /ckpt_name|ckpt/i.test(k));
                if (key && node.inputs[key]) checkpoint = node.inputs[key];
            }

            if (isClipLoaderLike(node)) clip = node.inputs.clip_name || clip;
            if (isVaeLoaderLike(node)) vae = node.inputs.vae_name || vae;

            loras.push(...extractLorasFromNode(node));

            if (isSamplerLike(node)) {

                const inputs = node.inputs;

                let posNodeId = Array.isArray(inputs[POSITIVE_KEYS.find(k => Array.isArray(inputs[k]))])
                    ? inputs[POSITIVE_KEYS.find(k => Array.isArray(inputs[k]))][0] : null;
                let negNodeId = Array.isArray(inputs[NEGATIVE_KEYS.find(k => Array.isArray(inputs[k]))])
                    ? inputs[NEGATIVE_KEYS.find(k => Array.isArray(inputs[k]))][0] : null;

                let posTitle = "", negTitle = "";

                // 이름 매칭 실패 시: workflow의 CONDITIONING 링크 타입으로 폴백
                if ((!posNodeId || !negNodeId) && wfGraph) {

                    const condLinks = findConditioningLinksByType(nodeId, wfGraph);
                    const byTitle = (re) => condLinks.find(c => re.test(c.originTitle));

                    const posByTitle = byTitle(/pos|긍정/i);
                    const negByTitle = byTitle(/neg|부정/i);

                    if (!posNodeId && posByTitle) { posNodeId = posByTitle.originNodeId; posTitle = posByTitle.originTitle; }
                    if (!negNodeId && negByTitle) { negNodeId = negByTitle.originNodeId; negTitle = negByTitle.originTitle; }

                    const remaining = condLinks.filter(c =>
                        c.originNodeId !== posNodeId && c.originNodeId !== negNodeId
                    );

                    if (!posNodeId && remaining[0]) { posNodeId = remaining[0].originNodeId; posTitle = remaining[0].originTitle; }
                    if (!negNodeId && remaining[1]) { negNodeId = remaining[1].originNodeId; negTitle = remaining[1].originTitle; }
                }

                if (!posTitle) posTitle = getWFNode(wfGraph, posNodeId)?.title || "";
                if (!negTitle) negTitle = getWFNode(wfGraph, negNodeId)?.title || "";

                // ★ 원본 텍스트를 먼저 뽑고
                const positiveTextRaw = resolveNodeText(data, posNodeId, new Set(), 0, POSITIVE_KEYS);
                const negativeTextRaw = resolveNodeText(data, negNodeId, new Set(), 0, NEGATIVE_KEYS);

                // ★ pane 기반 블록 배열이면 각자의 pane만 추출, 아니면 그대로 사용
                const positiveText = extractPromptPaneText(positiveTextRaw, "positive");
                const negativeText = extractPromptPaneText(negativeTextRaw, "negative");

                samplers.push({
                    nodeId,
                    className: node.class_type || "(unknown)",

                    seed: Array.isArray(inputs.seed) ? "(연결됨)" : inputs.seed,
                    steps: inputs.steps,
                    cfg: inputs.cfg,
                    sampler: inputs.sampler_name,
                    scheduler: inputs.scheduler,
                    denoise: inputs.denoise,

                    // ★ 세 번째 인자로 POSITIVE_KEYS/NEGATIVE_KEYS를 role로 전달
                    positiveText: resolveNodeText(data, posNodeId, new Set(), 0, POSITIVE_KEYS),
                    negativeText: resolveNodeText(data, negNodeId, new Set(), 0, NEGATIVE_KEYS),

                    order: typeof node.order === "number" ? node.order : -1
                });
            }
        }

        const bySamplers = [...samplers].sort((a, b) => {
            if (a.order !== b.order) return b.order - a.order;
            return (b.positiveText?.length || 0) - (a.positiveText?.length || 0);
        });

        const chosenSampler =
            bySamplers.find(s => s.positiveText && s.negativeText) || // 둘 다 있는 샘플러 우선
            bySamplers.find(s => s.positiveText || s.negativeText) || // 없으면 하나라도 있는 것
            bySamplers[0];

        let positive = chosenSampler?.positiveText || "";
        let negative = chosenSampler?.negativeText || "";

        // ---------- 키워드 휴리스틱 폴백 ----------
        // 구조분석(그래프/이름 매칭)으로 못 찾았거나, 결과가 의심스러운 경우
        // (positive/negative가 비었거나, 둘이 같거나, negative에 부정 힌트가 전혀 없는 경우)
        // used 노드들의 문자열 input 전체를 태그 내용 기반으로 재평가해서 보정한다.
        const needsHeuristic =
            !positive || !negative ||
            positive === negative ||
            !containsAnyNegativeHint(negative);

        if (needsHeuristic) {

            const candidates = collectPromptCandidates(data, used);
            const heuristic = pickPromptsByHeuristic(candidates);

            if (!positive) positive = heuristic.positive;
            if (!negative) negative = heuristic.negative;

            // negative에 부정 힌트가 하나도 없는데 휴리스틱이 더 그럴듯한 부정 후보를 찾았다면 교체
            if (negative && !containsAnyNegativeHint(negative) && heuristic.negative) {
                negative = heuristic.negative;
            }

            // positive와 negative가 우연히 같아졌다면, 휴리스틱의 positive로 교체 시도
            if (positive && positive === negative && heuristic.positive && heuristic.positive !== negative) {
                positive = heuristic.positive;
            }
        }

        // bypass된 노드 목록 (workflow 있을 때만 정확)
        const bypassedList = [];
        if (wfGraph) {
            for (const [nid, n] of Object.entries(data)) {
                const wfNode = getWFNode(wfGraph, nid);
                if (isBypassed(n, wfNode)) {
                    bypassedList.push(`${wfNode?.title || n.class_type || nid} (#${nid})`);
                }
            }
        }

        const result = [];
        result.push("========== SUMMARY ==========");
        result.push("");
        result.push(`Checkpoint : ${checkpoint}`);
        result.push(`CLIP       : ${clip}`);
        result.push(`VAE        : ${vae}`);
        result.push("");

        samplers.sort((a, b) => a.order - b.order).forEach((s, i) => {
            const label = s.title ? `${s.title} / ${s.className}` : s.className;
            result.push(`Sampler #${i + 1} [${label}]`);
            result.push(`  Seed      : ${s.seed}`);
            result.push(`  Steps     : ${s.steps}`);
            result.push(`  CFG       : ${s.cfg}`);
            result.push(`  Sampler   : ${s.sampler}`);
            result.push(`  Scheduler : ${s.scheduler}`);
            result.push(`  Denoise   : ${s.denoise}`);
            if (s.positiveSourceTitle) result.push(`  Positive from : ${s.positiveSourceTitle}`);
            if (s.negativeSourceTitle) result.push(`  Negative from : ${s.negativeSourceTitle}`);
            result.push("");
        });

        result.push("Active LoRA");
        result.push(loras.length ? loras.join("\n") : "(none)");
        result.push("");

        if (bypassedList.length) {
            result.push("Bypassed/Muted Nodes");
            result.push(bypassedList.join("\n"));
            result.push("");
        }

        return { summary: result.join("\n"), positive, negative };

    } catch (err) {
        return { summary: "Prompt Parse Error\n\n" + err, positive: "", negative: "" };
    }
}

function parseComfyWorkflow(text) {

    try {

        const sanitized = text
            .replace(/\bNaN\b/g, "null")
            .replace(/\bInfinity\b/g, "null")
            .replace(/\b-Infinity\b/g, "null");

        return JSON.parse(sanitized);

    } catch (e) {

        console.error("workflow parse failed", e);

        return null;
    }
}

function summarizeWebUIreforgePrompt(text) {

    let positive = "";
    let negative = "";
    let summary = [];

    const negIndex = text.indexOf("Negative prompt:");

    if (negIndex >= 0) {

        positive = text.substring(0, negIndex).trim();

        const rest =
            text.substring(negIndex + "Negative prompt:".length);

        const stepIndex = rest.indexOf("Steps:");

        if (stepIndex >= 0) {

            negative = rest.substring(0, stepIndex).trim();

            const settings =
                rest.substring(stepIndex).trim();

            summary.push(settings);

        } else {

            negative = rest.trim();
        }

    } else {

        positive = text.trim();
    }

    return {
        positive,
        negative,
        summary: summary.join("\n")
    };
}

function summarizeForgeNeoPrompt(text) {

    let positive = "";
    let negative = "";
    const result = [];

    const negIndex = text.indexOf("Negative prompt:");

    if (negIndex < 0) {

        return {
            summary: "",
            positive: text.trim(),
            negative: ""
        };
    }

    positive = text.substring(0, negIndex).trim();

    const loras = [];

    positive = positive.replace(
        /<lora:([^:>]+):([^>]+)>/g,
        (_, name, strength) => {

            loras.push(`${name} (${strength})`);

            return "";
        }
    ).trim();

    const rest =
        text.substring(
            negIndex + "Negative prompt:".length
        );

    const stepIndex = rest.indexOf("Steps:");

    if (stepIndex < 0) {

        return {
            summary: "",
            positive,
            negative: rest.trim()
        };
    }

    negative =
        rest.substring(0, stepIndex).trim();

    const settings =
        rest.substring(stepIndex);

    result.push("========== SUMMARY ==========");
    result.push("");

    const fields = [

        "Steps",
        "Sampler",
        "Schedule type",
        "CFG scale",
        "Shift",
        "Seed",
        "Size",
        "Model",
        "Model hash",
        "Module 1",
        "Module 2",
        "Module 3",
        "Clip skip",
        "Denoising strength",
        "RNG",
        "Hires Module 1",
        "Hires Module 2",
        "Hires Module 3",
        "Hires upscale",
        "Hires upscaler",
        "Hires steps",
        "Hires CFG Scale",
        "Hires Shift",
        "Lora hashes",
        "Emphasis",
        "Version"
    ];

    for (const name of fields) {

        const escaped =
            name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

        const regex =
            new RegExp(
                `${escaped}:\\s*([^,\\n]+)`
            );

        const m = settings.match(regex);

        if (m) {

            result.push(
                `${name}: ${m[1].trim()}`
            );
        }
    }
    result.push("");    
    result.push("Active LoRA");

    if (loras.length) {

        result.push(...loras);

    } else {

        result.push("(none)");
    }
    return {
        summary: result.join("\n"),
        positive,
        negative
    };
}

app.registerExtension({
    name: "ExifViewer",

    async beforeRegisterNodeDef(nodeType, nodeData) {

        if (nodeData.name !== "ExifViewer")
            return;

        nodeType.prototype.onNodeCreated = function () {
            this.size = [900, 700];


            this.updatePromptOutputs = function(pos, neg){
                if (this.posWidget) this.posWidget.value = pos || "";
                if (this.negWidget) this.negWidget.value = neg || "";

                this.positiveBox.value = pos || "";
                this.negativeBox.value = neg || "";

                this.setDirtyCanvas(true, true);
            };

            const root = document.createElement("div");
            root.style.display = "flex";
            root.style.flexDirection = "column";
            root.style.width = "100%";
            root.style.gap = "8px";


            // 상단 영역
            const top = document.createElement("div");
            top.style.display = "flex";
            top.style.flexDirection = "row";
            top.style.gap = "10px";


            // 이미지
            this.imageElement = document.createElement("img");
            this.imageElement.style.width = "250px";
            this.imageElement.style.height = "250px";
            this.imageElement.style.objectFit = "contain";
            this.imageElement.style.border = "1px solid #555";


            // 오른쪽
            const right = document.createElement("div");
            right.style.flex = "1";
            right.style.display = "flex";
            right.style.flexDirection = "column";
            right.style.gap = "5px";


            // Positive
            this.positiveBox = document.createElement("textarea");
            this.positiveBox.readOnly = false;
            this.positiveBox.style.height = "120px";


            // Negative
            this.negativeBox = document.createElement("textarea");
            this.negativeBox.readOnly = false;
            this.negativeBox.style.height = "120px";

            right.appendChild(this.positiveBox);
            right.appendChild(this.negativeBox);

            top.appendChild(this.imageElement);
            top.appendChild(right);


            // 하단 요약
            this.summaryBox = document.createElement("textarea");
            this.summaryBox.readOnly = false;
            this.summaryBox.style.height = "250px";

            root.appendChild(top);
            root.appendChild(this.summaryBox);

            this.addDOMWidget(
                "viewer",
                "div",
                root,
                { serialize: false },
            );
            const allowDrag = (e) => {
                e.preventDefault();
                e.stopPropagation();
            };

            const forwardDrop = (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.onDragDrop(e);
            };

            root.addEventListener("dragover", allowDrag);
            root.addEventListener("drop", forwardDrop);

            // Python INPUT_TYPES(required)로 인해 이미 자동 생성된 위젯을 찾아서 숨김
            const posWidget = this.widgets.find(w => w.name === "positive");
            const negWidget = this.widgets.find(w => w.name === "negative");

            function hideWidget(w) {
                if (!w) return;
                w.draw = function () {};             // 그리지 않음
                w.computeSize = function () { return [0, -4]; }; // 공간 차지 안 함
            }
            hideWidget(posWidget);
            hideWidget(negWidget);
        };

        nodeType.prototype.onDragOver = function () {
            return true;
        };

        nodeType.prototype.onDragDrop = async function (event) {

            try {

                const file = event.dataTransfer.files?.[0];

                if (!file)
                    return false;

                if (file.type.startsWith("image/")) {

                    const url = URL.createObjectURL(file);

                    const img = new Image();

                    img.onload = () => {
                         this.imageElement.src = img.src;
                        this.setDirtyCanvas(true, true);
                    };

                    img.src = url;
                }
                const buffer = await file.arrayBuffer();

                let output = "";

                output += `FILE: ${file.name}\n`;
                output += `SIZE: ${file.size}\n`;
                output += `TYPE: ${file.type}\n\n`;

                if (file.type === "image/png") {

                    output += "========== PNG METADATA ==========\n\n";
                    const metadataText = await parsePNGChunks(buffer);
                    output += metadataText;

                    const chunkMap = extractTextChunkMap(metadataText);

                    let flatDictText = null;
                    for (const key in chunkMap) {
                        const val = chunkMap[key];
                        if (val && val.trim().startsWith("{") && /'positive_prompt'\s*:/.test(val)) {
                            flatDictText = val;
                            break;
                        }
                    }
                    // ComfyUI 표준 PNG 청크는 항상 "prompt"(API 그래프 JSON)와 "workflow"(UI 그래프 JSON) 이름을 씀.
                    // FLAT_POSITIVE_KEYS에 "prompt"가 후보로 들어있어서, 예외 처리 없이 그냥 매칭하면
                    // 모든 ComfyUI 이미지에서 이 조건이 무조건 true가 되어버림 (chunkMap["prompt"]가 항상 존재하니까).
                    // → "prompt"/"workflow" 청크는 이 플랫 딕셔너리 감지에서 제외해야 함
                    const RESERVED_CHUNK_KEYS = new Set(["prompt", "workflow"]);

                    const hasFlatChunkFields =
                        FLAT_POSITIVE_KEYS.some(k => !RESERVED_CHUNK_KEYS.has(k) && typeof chunkMap[k] === "string" && chunkMap[k].trim()) ||
                        FLAT_NEGATIVE_KEYS.some(k => !RESERVED_CHUNK_KEYS.has(k) && typeof chunkMap[k] === "string" && chunkMap[k].trim());

                    let stealthInfo = null;

                    try {

                        const idat = collectIDAT(buffer);
                        const raw = await inflateIDAT(idat);
                        const pngInfo = getPNGInfo(buffer);

                        // interlace method 추가로 읽기
                        const rawBytes = new Uint8Array(buffer);
                        const interlaceMethod = rawBytes[28];

                        const stride = pngInfo.width * 4; // colorType 6 → bpp 4
                        const expectedRawLen = pngInfo.height * (1 + stride);

                        const rgba = unfilterPNG(raw, pngInfo.width, pngInfo.height, pngInfo.colorType);

                        const bppSrc = pngInfo.colorType === 6 ? 4 : 3;

                        const aBits = extractBits(rgba, pngInfo.width, pngInfo.height, 4, "alpha", "col");

                        const sigBits = "stealth_pngcomp".length * 8; // 120
                        const lenBits = aBits.substr(sigBits, 32);
                        const bitLength = parseInt(lenBits, 2);

                        const payloadBits = aBits.substr(sigBits + 32, bitLength);

                        const payload = bitsToBytes(payloadBits);

                        try {
                            const decompressed = await gunzip(payload);
                        } catch (e) {
                            console.error("gunzip failed:", e);
                        }

                        const attempts = [];
                        if (pngInfo.colorType === 6) {
                            attempts.push(["alpha", "row"]);
                            attempts.push(["alpha", "col"]);
                        }
                        attempts.push(["rgb", "row"]);
                        attempts.push(["rgb", "col"]);

                        for (const [mode, order] of attempts) {

                            const bits = extractBits(rgba, pngInfo.width, pngInfo.height, bppSrc, mode, order);
                            const result = await decodeStealth(bits);

                            if (result) {
                                stealthInfo = result;
                                break;
                            }
                        }

                    } catch (e) {
                    }

                    const promptChunkText = chunkMap["prompt"];
                    const workflowChunkText = chunkMap["workflow"];
                    const parametersChunkText = chunkMap["parameters"];
                    // NovelAI 평문 청크 판별 (Comment가 JSON 형태인지 확인)
                    const isNovelAIPlain =
                        chunkMap["Comment"] &&
                        chunkMap["Comment"].trim().startsWith("{");
                    if (hasFlatChunkFields) {

                        // "prompt"/"workflow"는 표준 ComfyUI 그래프 청크이므로
                        // 플랫 딕셔너리 값 추출 대상에서도 제외
                        const flatCandidateMap = { ...chunkMap };
                        for (const rk of RESERVED_CHUNK_KEYS) delete flatCandidateMap[rk];

                        const info = summarizeFlatPromptDict(flatCandidateMap);

                        this.summaryBox.value = info.summary;
                        this.updatePromptOutputs(info.positive,info.negative);

                    }
                    else if (flatDictText) {

                        try {
                            const jsonText = pythonDictLiteralToJSON(flatDictText);
                            const obj = JSON.parse(jsonText);
                            const info = summarizeFlatPromptDict(obj);

                            this.summaryBox.value = info.summary;
                            this.updatePromptOutputs(info.positive,info.negative);

                        } catch (e) {
                            this.summaryBox.value = "Flat dict parse error\n\n" + e + "\n\n" + flatDictText;
                        }
                    }
                    else if (promptChunkText) {

                        const info = summarizeComfyPrompt(
                            promptChunkText,
                            workflowChunkText || null 
                        );

                        this.summaryBox.value = info.summary;
                        this.updatePromptOutputs(info.positive,info.negative);

                    }
                    else if (parametersChunkText) {

                        const text = parametersChunkText;

                        let info;

                        // Forge Neo인지 확인
                        if (text.includes("Version: neo-")) {

                            info = summarizeForgeNeoPrompt(text);

                        } else {

                            info = summarizeWebUIreforgePrompt(text);
                        }

                        this.summaryBox.value = info.summary;
                        this.updatePromptOutputs(info.positive,info.negative);

                    }
                    else if (isNovelAIPlain) {

                        const outerObj = {
                            Software: chunkMap["Software"] || "",
                            Source: chunkMap["Source"] || "",
                            "Generation time": chunkMap["Generation time"] || "",
                            Description: chunkMap["Description"] || "",
                            Comment: chunkMap["Comment"] || ""
                        };

                        const info = summarizeNovelAIPrompt(JSON.stringify(outerObj));

                        this.summaryBox.value = info.summary;
                        this.updatePromptOutputs(info.positive,info.negative);
                    }
                    else if (stealthInfo) {

                        const info = summarizeNovelAIPrompt(stealthInfo.text);

                        this.summaryBox.value = info.summary;
                        this.updatePromptOutputs(info.positive,info.negative);
                    }
                }
                else if (file.type === "image/jpeg" || file.type === "image/webp") {

                    output += `========== ${file.type === "image/webp" ? "WEBP" : "JPEG"} EXIF ==========\n\n`;

                    const tiff = file.type === "image/webp"
                        ? findWebPExifTiff(buffer)
                        : findJPEGExifTiff(buffer);

                    if (!tiff) {
                        this.summaryBox.value = "EXIF(TIFF) 블록을 찾지 못했습니다.\n" + output;
                    } else {
                        const userComment = extractWebPUserComment(tiff);

                        const fields = extractExifTextFields(tiff);
                        if(userComment){fields.UserComment = userComment;}
                        const info = summarizeExifImage(fields);

                        this.summaryBox.value = info.summary;
                        this.positiveBox.value = info.positive;
                        this.negativeBox.value = info.negative;
                    }
                }
                else {
                    this.summaryBox.value = output;
                }
                
                this.setDirtyCanvas(true, true);

                return true;

            } catch (err) {

                this.metadata = String(err);

                this.setDirtyCanvas(true, true);

                console.error(err);

                return false;
            }
        };
    },
    async nodeCreated(node) {

        if (node.comfyClass !== "ExifViewer")
            return;

        const posWidget = node.widgets.find(w => w.name === "positive");
        const negWidget = node.widgets.find(w => w.name === "negative");

        node.posWidget = posWidget;
        node.negWidget = negWidget;

        function fullyHideWidget(w) {
            if (!w) return;

            w.type = "hidden";
            w.computeSize = () => [0, -4];
            w.draw = () => {};

            // 멀티라인 위젯은 실제 <textarea> DOM(inputEl)이 별도로 떠 있음 → 이것도 숨겨야 함
            if (w.inputEl) {
                w.inputEl.style.display = "none";
            }

            // 버전에 따라 element 프로퍼티명이 다를 수 있어 폭넓게 체크
            if (w.element) {
                w.element.style.display = "none";
            }
        }

        fullyHideWidget(posWidget);
        fullyHideWidget(negWidget);

        node.setSize(node.computeSize());
        node.setDirtyCanvas(true, true);
    }
});
