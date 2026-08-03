// Minimal PDF content-stream tokenizer and text-run remover.
//
// Redaction here means two things, applied together per rect:
//   1. Any Tj/TJ/'/'' text-show operator whose conservatively-estimated
//      bounding box overlaps the rect is dropped from the content stream
//      entirely — the underlying text bytes no longer exist in the file.
//   2. A solid black rectangle is drawn over the same area, so non-text
//      content (images, vector art, scanned pages) is visually covered too.
//
// The width estimate for (2) uses a fixed 0.65×fontSize-per-character
// average. That's a deliberate overestimate for most fonts, so redaction
// errs toward removing slightly more text than the rect strictly covers
// rather than leaving a partial word behind.
//
// Known limits (surfaced in the UI, not hidden):
//   - Only axis-aligned (non-rotated) text is handled correctly, since bbox
//     estimation assumes a roughly horizontal text matrix.
//   - Only true text removal for text drawn with Tj/TJ. Image/vector content
//     is covered visually, not removed from the file.

function tokenize(text) {
  const tokens = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "%") { while (i < n && text[i] !== "\n") i++; continue; }
    if (c === "(") {
      let depth = 1, start = i; i++;
      while (i < n && depth > 0) {
        if (text[i] === "\\") { i += 2; continue; }
        if (text[i] === "(") depth++;
        else if (text[i] === ")") depth--;
        i++;
      }
      tokens.push({ type: "string", raw: text.slice(start, i) });
      continue;
    }
    if (c === "<" && text[i + 1] === "<") {
      let depth = 1, start = i; i += 2;
      while (i < n && depth > 0) {
        if (text[i] === "<" && text[i + 1] === "<") { depth++; i += 2; continue; }
        if (text[i] === ">" && text[i + 1] === ">") { depth--; i += 2; continue; }
        i++;
      }
      tokens.push({ type: "dict", raw: text.slice(start, i) });
      continue;
    }
    if (c === "<") {
      let start = i; i++;
      while (i < n && text[i] !== ">") i++;
      i++;
      tokens.push({ type: "hexstring", raw: text.slice(start, i) });
      continue;
    }
    if (c === "[") {
      let depth = 1, start = i; i++;
      while (i < n && depth > 0) {
        if (text[i] === "[") depth++;
        else if (text[i] === "]") depth--;
        else if (text[i] === "(") {
          let d2 = 1; i++;
          while (i < n && d2 > 0) {
            if (text[i] === "\\") { i += 2; continue; }
            if (text[i] === "(") d2++;
            else if (text[i] === ")") d2--;
            i++;
          }
          continue;
        }
        i++;
      }
      tokens.push({ type: "array", raw: text.slice(start, i) });
      continue;
    }
    if (c === "/") {
      let start = i; i++;
      while (i < n && !/[\s/[\]<>()]/.test(text[i])) i++;
      tokens.push({ type: "name", raw: text.slice(start, i) });
      continue;
    }
    if (/[-+.\d]/.test(c)) {
      let start = i; i++;
      while (i < n && /[-+.\d]/.test(text[i])) i++;
      tokens.push({ type: "num", raw: text.slice(start, i), value: parseFloat(text.slice(start, i)) });
      continue;
    }
    let start = i;
    while (i < n && !/[\s/[\]<>()]/.test(text[i])) i++;
    if (i === start) { i++; continue; }
    const rawOp = text.slice(start, i);
    tokens.push({ type: "op", raw: rawOp });
    if (rawOp === "ID") {
      // Inline image: exactly one whitespace byte separates ID from the raw
      // (often binary) image data, which runs until whitespace+"EI"+delimiter.
      // That data is arbitrary bytes, not PDF syntax, so it must be captured
      // verbatim rather than re-tokenized (binary can contain "(", ")", etc.
      // that would otherwise desync the parser for the rest of the stream).
      const dataStart = i + 1;
      let j = dataStart;
      while (j < n) {
        if (
          /\s/.test(text[j]) &&
          text[j + 1] === "E" &&
          text[j + 2] === "I" &&
          (j + 3 >= n || /[\s/[\]<>()]/.test(text[j + 3]))
        ) {
          break;
        }
        j++;
      }
      tokens.push({ type: "raw", raw: text.slice(dataStart, j) });
      tokens.push({ type: "op", raw: "EI" });
      i = j + 3;
    }
  }
  return tokens;
}

function mul(m1, m2) {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

function applyToPoint(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function decodeStringLength(raw) {
  if (raw.startsWith("(")) {
    const inner = raw.slice(1, -1);
    let count = 0;
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === "\\") { i++; count++; continue; }
      count++;
    }
    return count;
  }
  if (raw.startsWith("<")) {
    const inner = raw.slice(1, -1).replace(/\s/g, "");
    return Math.ceil(inner.length / 2);
  }
  return 0;
}

function rectsOverlap(a, b) {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

/**
 * Rewrites a page's content stream, dropping text-show operators whose
 * estimated bounding box overlaps any rect in `rects` (PDF user-space
 * points, [x0, y0, x1, y1], origin bottom-left).
 * Returns { text, removedCount }.
 */
export function redactContentStream(source, rects) {
  const tokens = tokenize(source);
  const out = [];
  let ctmStack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  let tm = [1, 0, 0, 1, 0, 0];
  let tlm = [1, 0, 0, 1, 0, 0];
  let fontSize = 12;
  let leading = 0;
  let pending = [];
  let removedCount = 0;

  function textBBox(charCount) {
    const combined = mul(tm, ctm);
    const [x0, y0] = applyToPoint(combined, 0, -fontSize * 0.25);
    const widthEstimate = charCount * fontSize * 0.65;
    const [x1, y1] = applyToPoint(combined, widthEstimate, fontSize * 0.95);
    return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
  }

  function overlapsAny(bbox) {
    return rects.some((r) => rectsOverlap(bbox, r));
  }

  for (const tok of tokens) {
    if (tok.type !== "op") {
      pending.push(tok);
      continue;
    }
    const op = tok.raw;
    switch (op) {
      case "q":
        ctmStack.push(ctm);
        break;
      case "Q":
        ctm = ctmStack.pop() || [1, 0, 0, 1, 0, 0];
        break;
      case "cm": {
        const nums = pending.filter((t) => t.type === "num").map((t) => t.value);
        if (nums.length === 6) ctm = mul(nums, ctm);
        break;
      }
      case "BT":
        tm = [1, 0, 0, 1, 0, 0];
        tlm = [1, 0, 0, 1, 0, 0];
        break;
      case "Tf": {
        const nums = pending.filter((t) => t.type === "num").map((t) => t.value);
        if (nums.length >= 1) fontSize = nums[nums.length - 1];
        break;
      }
      case "TL": {
        const nums = pending.filter((t) => t.type === "num").map((t) => t.value);
        if (nums.length) leading = nums[0];
        break;
      }
      case "Td":
      case "TD": {
        const nums = pending.filter((t) => t.type === "num").map((t) => t.value);
        if (nums.length === 2) {
          if (op === "TD") leading = -nums[1];
          tlm = mul([1, 0, 0, 1, nums[0], nums[1]], tlm);
          tm = tlm;
        }
        break;
      }
      case "Tm": {
        const nums = pending.filter((t) => t.type === "num").map((t) => t.value);
        if (nums.length === 6) {
          tm = nums;
          tlm = nums;
        }
        break;
      }
      case "T*": {
        tlm = mul([1, 0, 0, 1, 0, -leading], tlm);
        tm = tlm;
        break;
      }
      case "Tj":
      case "'":
      case "\"": {
        if (op !== "Tj") {
          tlm = mul([1, 0, 0, 1, 0, -leading], tlm);
          tm = tlm;
        }
        const strTok = [...pending].reverse().find((t) => t.type === "string" || t.type === "hexstring");
        const len = strTok ? decodeStringLength(strTok.raw) : 0;
        const bbox = textBBox(len);
        if (overlapsAny(bbox)) {
          removedCount++;
          pending = [];
          continue;
        }
        break;
      }
      case "TJ": {
        const arrTok = pending.find((t) => t.type === "array");
        let len = 0;
        if (arrTok) {
          const inner = tokenize(arrTok.raw.slice(1, -1));
          for (const it of inner) {
            if (it.type === "string" || it.type === "hexstring") len += decodeStringLength(it.raw);
          }
        }
        const bbox = textBBox(len);
        if (overlapsAny(bbox)) {
          removedCount++;
          pending = [];
          continue;
        }
        break;
      }
      default:
        break;
    }
    out.push(...pending, tok);
    pending = [];
  }
  out.push(...pending);
  return { text: out.map((t) => t.raw).join(" "), removedCount };
}
