// "Hold to make a shape": turns a rough stroke into a clean line, circle,
// ellipse, triangle or rectangle. Works on [x, y] points in sheet units.

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function distToLine(p, a, b) {
  const len = dist(a, b);
  if (!len) return dist(p, a);
  return Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / len;
}

// Ramer-Douglas-Peucker simplification: keeps the corners of a polyline.
function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  let maxD = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToLine(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [pts[0], pts[pts.length - 1]];
  return [...simplify(pts.slice(0, idx + 1), eps).slice(0, -1), ...simplify(pts.slice(idx), eps)];
}

function interpolate(corners, closed, step) {
  const out = [];
  const list = closed ? [...corners, corners[0]] : corners;
  for (let i = 0; i < list.length - 1; i++) {
    const [a, b] = [list[i], list[i + 1]];
    const n = Math.max(1, Math.ceil(dist(a, b) / step));
    for (let j = 0; j < n; j++) out.push([a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n]);
  }
  out.push(list[list.length - 1]);
  return out;
}

// Closed shapes run a little past their start, so tapered pen ends overlap instead of leaving a gap.
const overlap = (pts) => [...pts, ...pts.slice(1, Math.max(2, Math.ceil(pts.length * 0.12)))];

function ellipsePoints(cx, cy, rx, ry) {
  const out = [];
  const n = 72;
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2 - Math.PI / 2;
    out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return out;
}

/**
 * @param pts [[x, y], ...]
 * @returns {{name: string, points: [[x, y], ...]} | null}
 */
export function recognizeShape(pts) {
  if (pts.length < 4) return null;
  let length = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    if (i) length += dist(pts[i - 1], pts[i]);
    minX = Math.min(minX, pts[i][0]); maxX = Math.max(maxX, pts[i][0]);
    minY = Math.min(minY, pts[i][1]); maxY = Math.max(maxY, pts[i][1]);
  }
  const w = maxX - minX, h = maxY - minY, diag = Math.hypot(w, h);
  if (diag < 12) return null;
  const start = pts[0], end = pts[pts.length - 1];
  const step = 4;

  // Straight line: every point close to the start-end chord.
  const chord = dist(start, end);
  if (chord > 15 && chord > length * 0.8) {
    const maxDev = Math.max(...pts.map((p) => distToLine(p, start, end)));
    if (maxDev < Math.max(5, chord * 0.07)) {
      // Snap nearly horizontal / vertical lines.
      const ang = Math.atan2(end[1] - start[1], end[0] - start[0]);
      const snapped = [...end];
      if (Math.abs(Math.sin(ang)) < 0.08) snapped[1] = start[1];
      if (Math.abs(Math.cos(ang)) < 0.08) snapped[0] = start[0];
      return { name: 'line', points: interpolate([start, snapped], false, step) };
    }
    return null;
  }

  // Closed shapes: the end comes back near the start.
  if (chord > Math.max(diag * 0.3, 25)) return null;
  const closedPts = [...pts, start];
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, rx = w / 2, ry = h / 2;
  if (rx < 4 || ry < 4) return null;

  const corners = simplify(closedPts, diag * 0.07).slice(0, -1);
  // Merge corners that are very close together.
  const merged = corners.filter((c, i) => i === 0 || dist(c, corners[i - 1]) > diag * 0.12);

  let dev = 0;
  for (const [x, y] of pts) dev += Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1);
  dev /= pts.length;

  if (merged.length === 3 && dev > 0.08) return { name: 'triangle', points: overlap(interpolate(merged, true, step)) };
  if (merged.length === 4 && dev > 0.07) {
    // Axis-aligned rectangle when the edges are roughly horizontal/vertical.
    const aligned = merged.every((c, i) => {
      const n = merged[(i + 1) % 4];
      const a = Math.atan2(n[1] - c[1], n[0] - c[0]);
      return Math.min(Math.abs(Math.sin(a)), Math.abs(Math.cos(a))) < 0.22;
    });
    const quad = aligned ? [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]] : merged;
    return { name: aligned ? 'rectangle' : 'shape', points: overlap(interpolate(quad, true, step)) };
  }
  if (dev < 0.2) {
    if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.18) {
      const r = (rx + ry) / 2;
      return { name: 'circle', points: overlap(ellipsePoints(cx, cy, r, r)) };
    }
    return { name: 'ellipse', points: overlap(ellipsePoints(cx, cy, rx, ry)) };
  }
  if (merged.length >= 3 && merged.length <= 6) return { name: 'shape', points: overlap(interpolate(merged, true, step)) };
  return null;
}
