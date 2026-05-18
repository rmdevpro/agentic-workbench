'use strict';

// #651 R7: tail-parse primitives — read only the bytes that grew since the
// last parse + detect truncate/rotate. Per-CLI parsers call these to skip
// already-parsed content. Without this, every cache miss is a full readFile,
// which the §6.9 cost model says we can't afford under 283-session load.
//
// Design contract:
//   decideParseMode(cached, currentStat) → 'cached' | 'tail' | 'full'
//     'cached': the file hasn't changed; caller returns cached result
//     'tail':   the file grew at the tail; caller reads from
//               cached.last_byte_offset to currentStat.size and parses only
//               the new lines
//     'full':   the file truncated, rotated, or has no usable cursor; caller
//               does a fresh full readFile and resets the cursor
//
//   readTail(filepath, fromOffset, toOffset)
//     Reads bytes [fromOffset, toOffset) from filepath via a read stream.
//     Returns the decoded UTF-8 string of the tail region.
//
//   splitTailIntoLines(tail, priorTrailingPartial)
//     JSONL files may have a partial trailing line if the writer flushed
//     mid-record. The function returns {lines, trailingPartial} so the
//     caller can buffer the partial across parses.

const fs = require('node:fs');
const fsp = require('node:fs/promises');

function decideParseMode(cached, currentStat) {
  if (!cached || cached.file_mtime == null || cached.file_size == null) {
    return { mode: 'full', reason: 'no-cache' };
  }
  if (cached.file_mtime === currentStat.mtimeMs && cached.file_size === currentStat.size) {
    return { mode: 'cached', reason: 'mtime-and-size-match' };
  }
  // Truncate: current size is less than cached size — the writer rewrote
  // the file in place (or truncated). The cursor is stale; full-parse.
  if (currentStat.size < cached.file_size) {
    return { mode: 'full', reason: 'truncate' };
  }
  // Rotate / clock-skew: current mtime is older than cached mtime — the
  // file was replaced by a different writer (e.g. log rotation). Full-parse
  // to be safe.
  if (currentStat.mtimeMs < cached.file_mtime) {
    return { mode: 'full', reason: 'rotate' };
  }
  // Cursor must be present for tail-parse. If the migration just added
  // the column on a row that pre-dated it, last_byte_offset == 0 — that's
  // still a tail-parse from 0, which is equivalent to a full-parse but
  // routes through the same code path.
  if (cached.last_byte_offset == null || cached.last_byte_offset < 0) {
    return { mode: 'full', reason: 'no-cursor' };
  }
  // Cursor sits past the new EOF? Treat as full-parse: the file changed in
  // some way we don't model, fall back to safety.
  if (cached.last_byte_offset > currentStat.size) {
    return { mode: 'full', reason: 'cursor-beyond-eof' };
  }
  return {
    mode: 'tail',
    reason: 'size-grew',
    fromOffset: cached.last_byte_offset,
    toOffset: currentStat.size,
  };
}

async function readTail(filepath, fromOffset, toOffset) {
  if (toOffset <= fromOffset) return '';
  let handle;
  try {
    handle = await fsp.open(filepath, 'r');
    const length = toOffset - fromOffset;
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buf, 0, length, fromOffset);
    return buf.subarray(0, bytesRead).toString('utf-8');
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (_e) {
        /* close after read errors fine */
      }
    }
  }
}

function splitTailIntoLines(tail, priorTrailingPartial = '') {
  const combined = priorTrailingPartial + tail;
  const endsWithNewline = combined.length > 0 && combined.charCodeAt(combined.length - 1) === 10;
  const parts = combined.split('\n');
  let trailingPartial = '';
  if (!endsWithNewline) {
    trailingPartial = parts.pop() || '';
  } else {
    parts.pop();
  }
  return { lines: parts.filter((l) => l.length > 0), trailingPartial };
}

// Synchronous variant for parsers that call fs.readFileSync today. Same
// contract; uses fs.openSync + fs.readSync. The async variant is preferred
// for new code.
function readTailSync(filepath, fromOffset, toOffset) {
  if (toOffset <= fromOffset) return '';
  let fd;
  try {
    fd = fs.openSync(filepath, 'r');
    const length = toOffset - fromOffset;
    const buf = Buffer.allocUnsafe(length);
    const bytesRead = fs.readSync(fd, buf, 0, length, fromOffset);
    return buf.subarray(0, bytesRead).toString('utf-8');
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch (_e) {
        /* close after read errors fine */
      }
    }
  }
}

module.exports = {
  decideParseMode,
  readTail,
  readTailSync,
  splitTailIntoLines,
};
