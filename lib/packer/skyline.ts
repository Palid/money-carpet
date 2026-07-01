/**
 * Authoritative note packer: skyline / bottom-left placement over a square room.
 *
 * All geometry is fixed-point i32 (1/100 mm). The packer is coverage-first: it
 * keeps placing the highest-priority note that still fits anywhere and only
 * stops when NO eligible note fits (it never stops early).
 */

import type { Denomination } from '@/lib/currency/types';
import { noteDimsUnits } from '@/lib/currency/derived';
import { UNITS_PER_M } from '@/lib/config/constants';
import type { Config } from '@/lib/packer/candidates';

export interface NotePlacement {
  denomIndex: number; // index into eligibleDenoms / denomTable
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number; // 0 = as-authored orientation, 1 = swapped (w<->h)
}

export interface SkylineResult {
  placements: NotePlacement[];
  roomSide: number;
  noteArea: number; // sum of w*h over placed notes (JS number, exact for our ranges)
}

interface Seg {
  x: number;
  w: number;
  y: number; // skyline height across [x, x+w)
}

/** Square room side in fixed-point units for a given area (in 0.1 m^2 units). */
export function computeRoomSideUnits(areaTenths: number): number {
  const areaM2 = areaTenths / 10;
  return Math.round(Math.sqrt(areaM2) * UNITS_PER_M);
}

/**
 * Oriented note dimensions + rotation flag under an orient policy.
 *  0 = as-authored, 1 = rotate to landscape (w>=h), 2 = rotate to portrait (h>=w).
 */
export function orientedDims(d: Denomination, orientPolicy: number): [number, number, number] {
  const [w, h] = noteDimsUnits(d);
  if (orientPolicy === 1) {
    // landscape: long side horizontal
    return w >= h ? [w, h, 0] : [h, w, 1];
  }
  if (orientPolicy === 2) {
    // portrait: long side vertical
    return h >= w ? [w, h, 0] : [h, w, 1];
  }
  return [w, h, 0];
}

interface Candidate {
  x: number;
  y: number;
  wasted: number;
  feasible: boolean;
}

/** Evaluate placing a w x h piece with its left edge at skyline[i].x. */
function evalAt(skyline: Seg[], i: number, w: number, h: number, roomSide: number): Candidate {
  const x = skyline[i].x;
  if (x + w > roomSide) return { x, y: 0, wasted: 0, feasible: false };

  // Highest skyline height across the spanned segments.
  let acc = 0;
  let maxY = 0;
  let k = i;
  while (acc < w && k < skyline.length) {
    if (skyline[k].y > maxY) maxY = skyline[k].y;
    acc += skyline[k].w;
    k++;
  }
  if (acc < w) return { x, y: 0, wasted: 0, feasible: false };

  const y = maxY;
  if (y + h > roomSide) return { x, y: 0, wasted: 0, feasible: false };

  // Wasted area = gap trapped beneath the piece.
  let remaining = w;
  let wasted = 0;
  let s = i;
  while (remaining > 0 && s < skyline.length) {
    const ow = Math.min(skyline[s].w, remaining);
    wasted += (y - skyline[s].y) * ow;
    remaining -= ow;
    s++;
  }
  return { x, y, wasted, feasible: true };
}

/** Find the best placement for a w x h piece; returns null if none fits. */
function findPosition(
  skyline: Seg[],
  w: number,
  h: number,
  roomSide: number,
  fitHeuristic: number,
): { x: number; y: number } | null {
  let best: Candidate | null = null;
  for (let i = 0; i < skyline.length; i++) {
    const c = evalAt(skyline, i, w, h, roomSide);
    if (!c.feasible) continue;
    if (best === null) {
      best = c;
      continue;
    }
    if (fitHeuristic === 1) {
      // best-fit: minimize wasted area, then y, then x
      if (
        c.wasted < best.wasted ||
        (c.wasted === best.wasted && c.y < best.y) ||
        (c.wasted === best.wasted && c.y === best.y && c.x < best.x)
      ) {
        best = c;
      }
    } else {
      // bottom-left: minimize y, then x
      if (c.y < best.y || (c.y === best.y && c.x < best.x)) {
        best = c;
      }
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}

/** Raise the skyline over [x, x+w) to height newY, then merge equal segments. */
function raiseSkyline(skyline: Seg[], x: number, w: number, newY: number): Seg[] {
  const xr = x + w;
  const out: Seg[] = [];
  for (const seg of skyline) {
    const segEnd = seg.x + seg.w;
    if (segEnd <= x || seg.x >= xr) {
      out.push(seg);
      continue;
    }
    if (seg.x < x) out.push({ x: seg.x, w: x - seg.x, y: seg.y });
    if (segEnd > xr) out.push({ x: xr, w: segEnd - xr, y: seg.y });
  }
  out.push({ x, w, y: newY });
  out.sort((a, b) => a.x - b.x);

  // Merge contiguous segments of equal height.
  const merged: Seg[] = [];
  for (const seg of out) {
    const last = merged[merged.length - 1];
    if (last && last.x + last.w === seg.x && last.y === seg.y) {
      last.w += seg.w;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

/**
 * Pack notes for a config over the room. Iterates config.order (notes only) in
 * priority order and always places the highest-priority note that currently
 * fits, restarting the scan after each placement. Stops when nothing fits.
 */
export function packNotes(
  config: Config,
  roomSide: number,
  eligibleDenoms: Denomination[],
): SkylineResult {
  // Note denoms in priority order, with their oriented dims precomputed.
  const noteJobs: { denomIndex: number; w: number; h: number; rot: number }[] = [];
  for (let oi = 0; oi < config.order.length; oi++) {
    const denomIndex = config.order[oi];
    const d = eligibleDenoms[denomIndex];
    if (d.kind !== 'note') continue;
    const [w, h, rot] = orientedDims(d, config.orientPolicy);
    if (w <= 0 || h <= 0) continue;
    if (w > roomSide || h > roomSide) continue; // can never fit
    noteJobs.push({ denomIndex, w, h, rot });
  }

  const mirrorX = config.startCorner === 1 || config.startCorner === 3;
  const mirrorY = config.startCorner === 2 || config.startCorner === 3;

  let skyline: Seg[] = [{ x: 0, w: roomSide, y: 0 }];
  const placements: NotePlacement[] = [];
  let noteArea = 0;

  // Guard against pathological loops; each iteration places exactly one piece.
  const maxPieces = 1_000_000;
  let placedTotal = 0;

  // eslint-disable-next-line no-constant-condition
  while (placedTotal < maxPieces) {
    let placedThisRound = false;
    for (const job of noteJobs) {
      const pos = findPosition(skyline, job.w, job.h, roomSide, config.fitHeuristic);
      if (!pos) continue;

      // Normalized bottom-left coordinates, then reflect per startCorner.
      let fx = pos.x;
      let fy = pos.y;
      if (mirrorX) fx = roomSide - (pos.x + job.w);
      if (mirrorY) fy = roomSide - (pos.y + job.h);

      placements.push({
        denomIndex: job.denomIndex,
        x: fx,
        y: fy,
        w: job.w,
        h: job.h,
        rot: job.rot,
      });
      noteArea += job.w * job.h;
      skyline = raiseSkyline(skyline, pos.x, job.w, pos.y + job.h);
      placedTotal++;
      placedThisRound = true;
      break; // restart scan from highest priority
    }
    if (!placedThisRound) break;
  }

  return { placements, roomSide, noteArea };
}
