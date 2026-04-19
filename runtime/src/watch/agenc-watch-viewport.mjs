export function applyScrollDelta(offset, delta) {
  return Math.max(0, Number(offset ?? 0) + Number(delta ?? 0));
}

export function isTranscriptFollowing({
  transcriptFollowMode,
  transcriptScrollOffset,
}) {
  return Boolean(transcriptFollowMode) || Number(transcriptScrollOffset ?? 0) === 0;
}

export function preserveManualTranscriptViewport({
  shouldFollow,
  beforeRows,
  afterRows,
  transcriptScrollOffset,
}) {
  if (shouldFollow) {
    return {
      transcriptScrollOffset: 0,
      transcriptFollowMode: true,
    };
  }
  const nextOffset = Math.max(
    0,
    Number(transcriptScrollOffset ?? 0) + (Number(afterRows ?? 0) - Number(beforeRows ?? 0)),
  );
  // CRITICAL: do NOT auto-engage follow mode just because the row-delta
  // adjustment landed at offset 0. The user actively scrolled up
  // (that's why shouldFollow was false at entry); content shrinking
  // under them — e.g. the streaming preview block disappearing on
  // chat.message commit, or events being collapsed/coalesced — must
  // not be interpreted as the user opting back into follow mode. If
  // we flip mode to true here, the very next event arrives, sees
  // shouldFollow=true via isTranscriptFollowing(), and snaps the
  // viewport to the bottom — which is exactly the "scroll works for
  // a second then breaks" symptom users see during long agent turns.
  // Mode stays false; the user must scroll back to the bottom (or
  // hit a follow shortcut) to re-engage following intentionally.
  return {
    transcriptScrollOffset: nextOffset,
    transcriptFollowMode: false,
  };
}

export function sliceRowsAroundRange(allRows, targetHeight, range, trailingPad = 6) {
  const rows = Array.isArray(allRows) ? allRows : [];
  const viewHeight = Math.max(1, Number(targetHeight) || 0);
  const maxStart = Math.max(0, rows.length - viewHeight);
  const preferredStart = Math.max(0, Number(range?.start ?? 0) - 1);
  let start = Math.min(preferredStart, maxStart);
  let end = Math.min(
    rows.length,
    Math.max(start + viewHeight, Number(range?.end ?? 0) + Number(trailingPad ?? 0)),
  );
  if (end - start > viewHeight) {
    end = start + viewHeight;
  }
  if (end > rows.length) {
    end = rows.length;
    start = Math.max(0, end - viewHeight);
  }
  return {
    rows: rows.slice(start, end),
    maxOffset: maxStart,
    normalizedOffset: 0,
    hiddenAbove: start,
    hiddenBelow: Math.max(0, rows.length - end),
  };
}

export function sliceRowsFromBottom(allRows, targetHeight, offset) {
  const rows = Array.isArray(allRows) ? allRows : [];
  const viewHeight = Math.max(1, Number(targetHeight) || 0);
  const maxOffset = Math.max(0, rows.length - viewHeight);
  const normalizedOffset = Math.max(0, Math.min(Number(offset ?? 0), maxOffset));
  const end = Math.max(0, rows.length - normalizedOffset);
  const start = Math.max(0, end - viewHeight);
  return {
    rows: rows.slice(start, end),
    maxOffset,
    normalizedOffset,
    hiddenAbove: start,
    hiddenBelow: Math.max(0, rows.length - end),
  };
}

export function bottomAlignRows(rows, targetHeight) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const padding = Math.max(0, Number(targetHeight ?? 0) - normalizedRows.length);
  return padding > 0
    ? Array.from({ length: padding }, () => "").concat(normalizedRows)
    : normalizedRows;
}
