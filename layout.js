// Layout analysis: turns pdf.js text items into paragraphs in human reading order.
//
// Pipeline per page:
//   items  -> rows (same baseline)  -> lines (rows split at wide gaps, so columns
//   never merge)  -> recursive XY-cut (finds column gutters and full-width bands)
//   -> paragraphs (indent / spacing / font-size breaks).
// Then a document pass classifies blocks: headings, captions, headers/footers,
// equations & figure fragments, references.

const mul = (m1, m2) => [
  m1[0] * m2[0] + m1[2] * m2[1],
  m1[1] * m2[0] + m1[3] * m2[1],
  m1[0] * m2[2] + m1[2] * m2[3],
  m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
  m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
];

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// ---------------------------------------------------------------- items

function extractItems(textContent, viewport) {
  const vt = viewport.transform;
  const scale = viewport.scale || 1;
  const items = [];
  for (const it of textContent.items) {
    if (!it.str || !it.str.trim()) continue;
    const tx = mul(vt, it.transform);
    // Skip rotated text: arXiv side stamps, rotated axis labels, watermarks.
    if (Math.abs(Math.atan2(tx[1], tx[0])) > 0.03) continue;
    const h = Math.hypot(tx[2], tx[3]);
    if (h < 1.5) continue;
    const w = it.width * scale;
    if (w <= 0) continue;
    const str = it.str.normalize('NFKC').replace(/\s+/g, ' ');
    items.push({ str, x: tx[4], x2: tx[4] + w, w, h, base: tx[5], y: tx[5] - h * 0.8, y2: tx[5] + h * 0.2 });
  }
  return items;
}

// ---------------------------------------------------------------- lines

function buildRows(items) {
  items.sort((a, b) => a.base - b.base || a.x - b.x);
  const rows = [];
  for (const it of items) {
    let best = null;
    let bestRatio = 0.5;
    for (let k = rows.length - 1; k >= 0 && k >= rows.length - 10; k--) {
      const r = rows[k];
      const ov = Math.min(r.y2, it.y2) - Math.max(r.y, it.y);
      const ratio = ov / Math.min(r.y2 - r.y, it.y2 - it.y);
      if (ratio > bestRatio) { best = r; bestRatio = ratio; }
    }
    if (best) {
      best.items.push(it);
      if (it.h > best.h) Object.assign(best, { h: it.h, y: it.y, y2: it.y2 });
    } else {
      rows.push({ items: [it], h: it.h, y: it.y, y2: it.y2 });
    }
  }
  return rows;
}

function rowToLines(row) {
  const its = row.items.sort((a, b) => a.x - b.x);
  const lines = [];
  let seg = null;
  for (const it of its) {
    if (seg) {
      const prev = seg[seg.length - 1];
      // Fake-bold: the same string drawn twice at (almost) the same spot.
      if (prev.str === it.str && Math.abs(prev.x - it.x) < 1) continue;
      const gap = it.x - Math.max(...seg.map((s) => s.x2));
      if (gap > 1.1 * Math.max(row.h, it.h)) { lines.push(makeLine(seg, row)); seg = null; }
    }
    (seg ||= []).push(it);
  }
  if (seg) lines.push(makeLine(seg, row));
  return lines.filter((l) => l.text.length);
}

function makeLine(items, row) {
  let text = '';
  const spans = [];
  let lastX2 = -Infinity;
  // Dominant font size = size of the item carrying the most characters.
  let h = items[0].h, most = 0;
  for (const it of items) if (it.str.length > most) { most = it.str.length; h = it.h; }
  for (const it of items) {
    let str = it.str;
    if (!text) str = str.trimStart();
    if (text && it.x - lastX2 > 0.12 * h && !text.endsWith(' ') && !str.startsWith(' ')) text += ' ';
    const start = text.length;
    text += str;
    spans.push({ start, end: text.length, x: it.x, w: it.w });
    lastX2 = Math.max(lastX2, it.x2);
  }
  // Vertical extent from the dominant font only: sub/superscripts and math
  // glyphs would otherwise inflate the line box and fake paragraph gaps.
  const main = items.filter((i) => Math.abs(i.h - h) < 0.15 * h);
  const trimmed = text.replace(/\s+$/, '');
  for (const s of spans) s.end = Math.min(s.end, trimmed.length);
  return {
    text: trimmed,
    spans: spans.filter((s) => s.end > s.start),
    x: Math.min(...items.map((i) => i.x)),
    x2: Math.max(...items.map((i) => i.x2)),
    y: Math.min(...main.map((i) => i.y)),
    y2: Math.max(...main.map((i) => i.y2)),
    h,
  };
}

export function pageLines(textContent, viewport) {
  const items = extractItems(textContent, viewport);
  return buildRows(items).flatMap(rowToLines);
}

// ---------------------------------------------------------------- reading order (XY-cut)

function projectionGaps(lines, lo, hi) {
  const iv = lines.map((l) => ({ a: l[lo], b: l[hi], line: l })).sort((p, q) => p.a - q.a);
  const gaps = [];
  let maxEnd = iv[0].b, maxLine = iv[0].line;
  for (let i = 1; i < iv.length; i++) {
    if (iv[i].a > maxEnd) {
      gaps.push({ size: iv[i].a - maxEnd, pos: (iv[i].a + maxEnd) / 2, before: maxLine, after: iv[i].line });
    }
    if (iv[i].b > maxEnd) { maxEnd = iv[i].b; maxLine = iv[i].line; }
  }
  return gaps;
}

const largest = (gaps) => gaps.reduce((m, g) => (!m || g.size > m.size ? g : m), null);

function xyCut(lines, medH, out) {
  if (lines.length < 2) { out.push(...lines); return; }

  const vGaps = projectionGaps(lines, 'x', 'x2');
  const hGaps = projectionGaps(lines, 'y', 'y2');
  const vg = largest(vGaps);
  const hgAll = largest(hGaps);
  const vOK = vg && vg.size >= 0.9 * medH; // a real column gutter, not a word space

  let dir = null, gap = null;
  if (vOK) {
    // A blank band across the whole region that is wider than the gutter is a
    // stronger separator (e.g. title block above two columns).
    if (hgAll && hgAll.size >= medH && hgAll.size > vg.size) { dir = 'h'; gap = hgAll; }
    else { dir = 'v'; gap = vg; }
  } else if (hGaps.length) {
    // No gutter yet: something spans the columns (title, abstract, wide caption).
    // Cut next to a line that crosses the middle, so we peel spanning content off
    // instead of slicing the columns into interleaved strips.
    const minX = Math.min(...lines.map((l) => l.x));
    const maxX = Math.max(...lines.map((l) => l.x2));
    const mid = (minX + maxX) / 2;
    const crosses = (l) => l.x < mid - medH && l.x2 > mid + medH;
    const anchored = hGaps.filter((g) => crosses(g.before) || crosses(g.after));
    dir = 'h';
    gap = largest(anchored.length ? anchored : hGaps);
  }

  if (!dir) {
    out.push(...lines.sort((a, b) => a.y - b.y || a.x - b.x));
    return;
  }
  const [lo, hi] = dir === 'v' ? ['x', 'x2'] : ['y', 'y2'];
  const first = [], second = [];
  for (const l of lines) ((l[lo] + l[hi]) / 2 < gap.pos ? first : second).push(l);
  if (!first.length || !second.length) { out.push(...lines); return; }
  xyCut(first, medH, out);
  xyCut(second, medH, out);
}

// ---------------------------------------------------------------- paragraphs

const HEADING_WORDS = /^(abstract|introduction|background|related work|method(s|ology)?|approach|experiments?|results?|discussion|conclusions?|future work|limitations|acknowledg(e)?ments?|references|bibliography|appendix|appendices|supplementary material|evaluation|preliminaries|summary)\b/i;
const NUMBERED = /^((\d+(\.\d+)*\.?)|([IVXLC]+\.)|([A-Z]\.(\d+\.?)*))\s+[A-Z][A-Za-z]/;

// colW: width of the neighbouring body lines; a heading must be clearly shorter
// than them unless it uses a bigger font (otherwise "2 Layers of the ..." in the
// middle of a paragraph would look like a numbered heading).
function headingInfo(line, bodyH, colW, gapAbove) {
  const t = line.text.trim();
  const words = t.split(/\s+/).length;
  if (t.length > 90 || words > 12) return null;
  if (/[,;.]$/.test(t) || !/^[\p{Lu}\d]/u.test(t)) return null;
  const bare = t.replace(/^[\dIVXLC]+(\.\d+)*\.?\s+|^[A-Z]\.(\d+\.?)*\s+/, '');
  const named = HEADING_WORDS.test(bare) && bare.split(/\s+/).length <= 4;
  const big = line.h > bodyH * 1.12 && (/\p{Ll}{2,}/u.test(t) || named);
  const num = NUMBERED.test(t) && words <= 10;
  if (!(big || num || named)) return null;
  // Long numbered headings are accepted when set off by space above.
  const roomy = num && gapAbove > 0.5 * line.h && line.x2 - line.x < 0.95 * colW;
  if (!big && colW && line.x2 - line.x > 0.75 * colW && !roomy) return null;
  let level = 1;
  const m = t.match(/^(\d+(?:\.\d+)*)/);
  if (m) level = m[1].split('.').filter(Boolean).length;
  else if (/^[A-Z]\.\d/.test(t)) level = t.split(' ')[0].split('.').filter(Boolean).length;
  return { level: Math.min(level, 4) };
}

// Bullets always start a new item; "[12] ..." / "3. ..." only after a finished
// sentence (otherwise it is just a line that begins with a citation).
function startsNewItem(text, prevEnded) {
  if (/^(•|◦|▪|●|■)/.test(text)) return true;
  return prevEnded && /^(\[\d+\]|\(\w\)\s|\d+\.\s+[A-Z]|[–-]\s)/.test(text);
}

function groupParagraphs(lines, bodyH) {
  const blocks = [];
  let cur = null;
  const flush = () => { if (cur) blocks.push(cur); cur = null; };
  const stacked = (a, b) => a && Math.min(a.x2, b.x2) - Math.max(a.x, b.x) > 0 && Math.abs(a.h - b.h) < 0.2 * b.h;
  lines.forEach((l, i) => {
    const nb = [lines[i - 1], lines[i + 1]].filter((n) => stacked(n, l));
    const above = stacked(lines[i - 1], l) ? l.y - lines[i - 1].y2 : Infinity;
    l.heading = headingInfo(l, bodyH, Math.max(0, ...nb.map((n) => n.x2 - n.x)), above);
  });
  for (const l of lines) {
    if (cur && continues(cur, l, bodyH)) {
      cur.lines.push(l);
      cur.minX = Math.min(cur.minX, l.x);
      cur.maxX = Math.max(cur.maxX, l.x2);
    } else {
      flush();
      cur = { lines: [l], minX: l.x, maxX: l.x2 };
    }
  }
  flush();
  return blocks;
}

function continues(b, l, bodyH) {
  const p = b.lines[b.lines.length - 1];
  const h = Math.max(p.h, l.h);
  if (Math.abs(p.h - l.h) > 0.18 * h) return false;
  const vgap = l.y - p.y2;
  if (vgap < -0.3 * h || vgap > 0.75 * h) return false; // column jump or paragraph spacing
  const ov = Math.min(p.x2, l.x2) - Math.max(p.x, l.x);
  if (ov < 0.3 * Math.min(p.x2 - p.x, l.x2 - l.x)) return false; // not stacked
  // Multi-line titles/headings in a large font stay together.
  if (p.heading || l.heading) return !!(p.heading && l.heading && p.h > bodyH * 1.12 && Math.abs(p.h - l.h) < 0.05 * h);
  const endsSentence = /[.!?:"”)]$/.test(p.text);
  if (startsNewItem(l.text, endsSentence)) return false;
  if (endsSentence && l.x > p.x + 0.8 * h) return false; // first-line indent
  if (endsSentence && b.lines.length > 1 && p.x2 < b.maxX - 3 * h) return false; // short last line
  return true;
}

function joinLines(lines) {
  let text = '';
  const spans = [];
  for (const l of lines) {
    let offset;
    if (!text) offset = 0;
    else if (/[A-Za-z]-$/.test(text) && /^[a-z]/.test(l.text)) {
      text = text.slice(0, -1); // de-hyphenate "exam-\nple"
      offset = text.length;
    } else if (/­$/.test(text)) {
      text = text.slice(0, -1);
      offset = text.length;
    } else {
      text += ' ';
      offset = text.length;
    }
    text += l.text;
    for (const s of l.spans) {
      spans.push({ start: s.start + offset, end: Math.min(s.end + offset, text.length), x: s.x, w: s.w, y: l.y, y2: l.y2 });
    }
  }
  // Clip spans whose last char was a removed hyphen.
  for (const s of spans) s.end = Math.min(s.end, text.length);
  return { text, spans: spans.filter((s) => s.end > s.start) };
}

// ---------------------------------------------------------------- document

const CAPTION = /^(fig(ure)?s?|table|tab|algorithm|alg|listing|scheme|chart)\.?\s*[\dIVX]+[a-z]?\s*[.:|—-]?/i;
const PAGE_NUM = /^\W*(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?\W*$/i;
const REFS = /^((\d+|[IVX]+)\.?\s*)?(references|bibliography|works cited|literature cited)$/i;

/**
 * @param {{lines: object[], width: number, height: number}[]} pages
 * @returns {{blocks: object[], bodyH: number}}
 */
export function buildDocument(pages) {
  // Body font size = most common line height, weighted by text length.
  const hist = new Map();
  for (const p of pages) for (const l of p.lines) {
    const k = Math.round(l.h * 2) / 2;
    hist.set(k, (hist.get(k) || 0) + l.text.length);
  }
  let bodyH = 10, bestCount = 0;
  for (const [k, c] of hist) if (c > bestCount) { bestCount = c; bodyH = k; }

  const blocks = [];
  pages.forEach((p, pageIndex) => {
    if (!p.lines.length) return;
    const ordered = [];
    xyCut([...p.lines], median(p.lines.map((l) => l.h)) || bodyH, ordered);
    for (const g of groupParagraphs(ordered, bodyH)) {
      const { text, spans } = joinLines(g.lines);
      blocks.push({
        id: blocks.length,
        page: pageIndex,
        lines: g.lines,
        text,
        spans,
        x: Math.min(...g.lines.map((l) => l.x)),
        x2: Math.max(...g.lines.map((l) => l.x2)),
        y: Math.min(...g.lines.map((l) => l.y)),
        y2: Math.max(...g.lines.map((l) => l.y2)),
        h: median(g.lines.map((l) => l.h)),
        heading: g.lines.every((l) => l.heading) ? g.lines[0].heading : null,
        kind: 'text',
        words: text.split(/\s+/).filter(Boolean).length,
      });
    }
  });

  classify(blocks, pages, bodyH);
  return { blocks, bodyH };
}

function classify(blocks, pages, bodyH) {
  // Headers & footers: short text in the top/bottom margin band that repeats
  // across pages (digits normalised) or is just a page number.
  const inMargin = (b) => {
    const H = pages[b.page].height;
    return b.y2 < H * 0.075 || b.y > H * 0.925;
  };
  const key = (b) => b.text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const seen = new Map();
  for (const b of blocks) if (inMargin(b) && b.words <= 20) {
    const k = key(b);
    if (!seen.has(k)) seen.set(k, new Set());
    seen.get(k).add(b.page);
  }

  // Title: biggest text on the first page.
  const first = blocks.filter((b) => b.page === 0 && !inMargin(b));
  const titleBlock = first.reduce((m, b) => (!m || b.h > m.h ? b : m), null);

  let inRefs = false;
  for (const b of blocks) {
    const t = b.text.trim();
    const letters = (t.match(/\p{L}/gu) || []).length;
    const visible = t.replace(/\s/g, '').length || 1;

    if (inMargin(b) && b.words <= 20 && (PAGE_NUM.test(t) || (seen.get(key(b))?.size || 0) >= 2)) {
      b.kind = 'furniture';
    } else if (b === titleBlock && b.h > bodyH * 1.3) {
      b.kind = 'title';
      b.heading = { level: 0 };
    } else if (b.heading) {
      b.kind = 'heading';
      if (REFS.test(t)) inRefs = true;
      else if (inRefs && !(/^appendix/i.test(t) || /^[A-Z](\.\d+)*\s+[A-Z]/.test(t) || b.h > bodyH * 1.12)) {
        b.kind = 'references'; b.heading = null; // a short reference line, not a heading
      } else inRefs = false;
    } else if (inRefs) {
      b.kind = 'references';
    } else if (CAPTION.test(t)) {
      b.kind = 'caption';
    } else if (letters / visible < 0.55) {
      b.kind = 'other'; // equations, tables of numbers
    } else if (b.words <= 3 && !/[.!?:]$/.test(t)) {
      b.kind = 'other'; // figure labels, table cells
    } else if (b.h < bodyH * 0.75 && b.words < 12) {
      b.kind = 'other'; // tiny figure text
    } else if (b.h <= bodyH * 0.88 && b.y > pages[b.page].height * 0.6) {
      b.kind = 'footnote';
    }
  }

  // A heading must introduce something readable; labels inside figures and
  // tables (followed by more fragments) are demoted.
  for (const b of blocks) {
    if (b.kind !== 'heading') continue;
    let j = b.id + 1;
    while (j < blocks.length && blocks[j].kind === 'furniture') j++;
    const n = blocks[j];
    if (n && (n.kind === 'other' || (n.kind === 'text' && n.words < 8 && !n.heading))) { b.kind = 'other'; b.heading = null; }
  }

  // Authors & affiliations: everything on page 1 between the title and the
  // first real section (Abstract / Introduction / numbered heading).
  if (titleBlock && titleBlock.kind === 'title') {
    for (let i = titleBlock.id + 1; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.page !== 0) break;
      const t = b.text.trim();
      if (b.kind === 'heading' && (HEADING_WORDS.test(t.replace(/^[\dIVX.]+\s+/, '')) || NUMBERED.test(t))) break;
      if (b.kind === 'text' && b.words > 40) break; // body text reached without a heading
      if (b.kind === 'furniture') continue;
      b.kind = 'front';
      b.heading = null;
    }
  }
}
