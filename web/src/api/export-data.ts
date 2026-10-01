// exportData(view): the numbers behind a plot / slice, computed with the same
// geometry as the view's shader (see public/shaderTemplates/*) and evaluated
// through BrdfEvaluator. r/g/b are the raw BRDF values; `value` is what the
// plot draws before the log mapping (channel mask, optional N.L, clamped >= 0)
// and `plotted` applies the log mapping when "Log plot" is on.

import type { Store } from '../state/store.js';
import type { BrdfEvaluator, EvalSample, Vec3 } from './evaluate.js';
import type { ViewKey } from '../views/base-view.js';
import type { ImageSliceView } from '../views/image-slice.js';
import type { PlotCartesianView } from '../views/plot-cartesian.js';
import type { ViewMap } from './state.js';

export interface ExportOptions {
  format?: 'json' | 'csv';
  /** Samples per axis (slice: 91, polar: 361, cartesian: 513, plot3d: 19 thetaV x 73 phiV). */
  resolution?: number;
}

export interface DataSeries {
  /** Index into state.brdfs. */
  brdf: number;
  name: string;
  rows: number[][];
}

export interface DataExport {
  view: ViewKey;
  columns: string[];
  meta: Record<string, unknown>;
  series: DataSeries[];
}

const DEG = Math.PI / 180;
const LOG10E = 0.434294482;

export const DATA_VIEWS: readonly ViewKey[] = ['slice', 'polar', 'cartesian', 'plot3d'];

export async function exportData(
  view: ViewKey,
  store: Store,
  views: ViewMap,
  evaluator: BrdfEvaluator,
  opts: ExportOptions = {},
): Promise<DataExport | string> {
  const s = store.state;
  const mask = channelMask(s.channel);
  const nDotL = s.useNDotL;
  const log = s.useLogPlot;
  const incident: Vec3 = sph(s.incidentTheta, s.incidentPhi);

  let geometry: { columns: string[]; points: { coords: number[]; L: Vec3; V: Vec3 }[]; meta: Record<string, unknown> };
  let packages = store.packages();
  let plotValues = true;

  switch (view) {
    case 'slice': {
      const slice = views.slice as ImageSliceView | undefined;
      const phiD = slice ? slice.phiD() : 90 * DEG;
      const res = clampRes(opts.resolution ?? 91);
      const points = [];
      for (let j = 0; j < res; j++) {
        const thetaD = (j / (res - 1)) * 90 * DEG;
        for (let i = 0; i < res; i++) {
          const thetaH = (i / (res - 1)) * 90 * DEG;
          const { L, V } = sliceLV(thetaH, thetaD, s.incidentPhi, phiD);
          points.push({ coords: [thetaH / DEG, thetaD / DEG], L, V });
        }
      }
      geometry = {
        columns: ['thetaH_deg', 'thetaD_deg'],
        points,
        meta: { phiD_deg: round9(phiD / DEG), phiH_deg: round9(s.incidentPhi / DEG), note: 'Image Slice uses the topmost visible BRDF' },
      };
      const top = store.topmostEnabled();
      packages = top ? [top] : [];
      plotValues = false;
      break;
    }
    case 'polar': {
      const res = clampRes(opts.resolution ?? 361);
      const points = [];
      for (let i = 0; i < res; i++) {
        const thetaV = -90 + (i / (res - 1)) * 180;
        const y = thetaV * DEG;
        const V: Vec3 = [Math.sin(y) * Math.cos(s.incidentPhi), Math.sin(y) * Math.sin(s.incidentPhi), Math.cos(y)];
        points.push({ coords: [thetaV], L: incident, V });
      }
      geometry = {
        columns: ['thetaV_deg'],
        points,
        meta: { note: 'V sweeps the plane of the incident azimuth; negative thetaV is the side opposite the light (mirror reflection side)' },
      };
      break;
    }
    case 'cartesian': {
      const cart = views.cartesian as PlotCartesianView | undefined;
      const set = cart ? cart.plotSettings() : { mode: 'thetaV' as const, phiV: s.incidentPhi, angleParam: 0 };
      const res = clampRes(opts.resolution ?? 513);
      const N: Vec3 = [0, 0, 1];
      const X: Vec3 = [1, 0, 0];
      const Y: Vec3 = [0, 1, 0];
      const points = [];
      for (let i = 0; i < res; i++) {
        const t = (-90 + (i / (res - 1)) * 180) * DEG;
        let L: Vec3 = incident;
        let V: Vec3;
        if (set.mode === 'thetaV') {
          const y = -t;
          V = [Math.sin(y) * Math.cos(set.phiV), Math.sin(y) * Math.sin(set.phiV), Math.cos(y)];
        } else {
          const thetaH = set.mode === 'thetaH' ? t : set.angleParam;
          const thetaD = set.mode === 'thetaH' ? set.angleParam : t;
          L = rotate(rotate(N, X, thetaD), Y, thetaH);
          const H = rotate(N, Y, thetaH);
          const d = 2 * dot(L, H);
          V = [d * H[0] - L[0], d * H[1] - L[1], d * H[2] - L[2]];
        }
        points.push({ coords: [t / DEG], L, V });
      }
      const fixed =
        set.mode === 'thetaH'
          ? { thetaD_deg: round9(set.angleParam / DEG) }
          : set.mode === 'thetaD'
            ? { thetaH_deg: round9(set.angleParam / DEG) }
            : { phiV_deg: round9(set.phiV / DEG) };
      geometry = { columns: [`${set.mode}_deg`], points, meta: { mode: set.mode, ...fixed } };
      break;
    }
    case 'plot3d': {
      const nTheta = clampRes(opts.resolution ?? 19);
      const nPhi = (nTheta - 1) * 4 + 1;
      const points = [];
      for (let j = 0; j < nTheta; j++) {
        const thetaV = (j / (nTheta - 1)) * 90;
        for (let i = 0; i < nPhi; i++) {
          const phiV = (i / (nPhi - 1)) * 360;
          points.push({ coords: [thetaV, phiV], L: incident, V: sph(thetaV * DEG, phiV * DEG) });
        }
      }
      geometry = { columns: ['thetaV_deg', 'phiV_deg'], points, meta: {} };
      break;
    }
    default:
      throw new Error(`exportData: view "${view}" has no numeric export (use one of ${DATA_VIEWS.join(', ')}; render() for images)`);
  }

  const samples: EvalSample[] = geometry.points.map((p) => ({ L: p.L, V: p.V }));
  const columns = [
    ...geometry.columns,
    'Lx', 'Ly', 'Lz', 'Vx', 'Vy', 'Vz',
    'r', 'g', 'b',
    ...(plotValues ? ['value', 'plotted'] : []),
  ];
  const series: DataSeries[] = [];
  for (const pkg of packages) {
    const rgb = await evaluator.evaluate(pkg.instance, samples);
    const rows = geometry.points.map((p, i) => {
      const r = rgb[i * 3];
      const g = rgb[i * 3 + 1];
      const b = rgb[i * 3 + 2];
      const row = [...p.coords.map(round9), ...p.L.map(round9), ...p.V.map(round9), r, g, b];
      if (plotValues) {
        let value = r * pkg.colorMask[0] + g * pkg.colorMask[1] + b * pkg.colorMask[2];
        if (nDotL) value *= Math.max(p.L[2], 0);
        value = Math.max(value, 0);
        row.push(value, log ? Math.log(value + 1) * LOG10E : value);
      }
      return row;
    });
    series.push({ brdf: store.state.brdfs.indexOf(pkg.instance), name: pkg.instance.def.name, rows });
  }

  const result: DataExport = {
    view,
    columns,
    meta: {
      ...geometry.meta,
      light: { theta_deg: round9(s.incidentTheta / DEG), phi_deg: round9(s.incidentPhi / DEG) },
      channel: s.channel,
      channelMask: mask,
      nDotL,
      logPlot: log,
      frame: 'N=(0,0,1) X=(1,0,0) Y=(0,1,0)',
    },
    series,
  };
  return opts.format === 'csv' ? toCsv(result) : result;
}

export function toCsv(data: DataExport): string {
  const lines = [['brdf', ...data.columns].join(',')];
  for (const s of data.series) {
    for (const row of s.rows) lines.push([s.brdf, ...row].join(','));
  }
  return `${lines.join('\n')}\n`;
}

function channelMask(channel: string): Vec3 {
  if (channel === 'red') return [1, 0, 0];
  if (channel === 'green') return [0, 1, 0];
  if (channel === 'blue') return [0, 0, 1];
  return [0.3, 0.59, 0.11];
}

function clampRes(n: number): number {
  return Math.max(2, Math.min(4096, Math.round(n)));
}

function round9(x: number): number {
  return Math.round(x * 1e9) / 1e9;
}

export function sph(theta: number, phi: number): Vec3 {
  return [Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.cos(theta)];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Rodrigues rotation, matching rotate_vector / rotateVector in the templates. */
function rotate(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const l = Math.hypot(axis[0], axis[1], axis[2]);
  const a: Vec3 = [axis[0] / l, axis[1] / l, axis[2] / l];
  const d = dot(a, v);
  const n: Vec3 = [a[0] * d, a[1] * d, a[2] * d];
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const x = cross(a, v);
  return [n[0] + c * (v[0] - n[0]) + s * x[0], n[1] + c * (v[1] - n[1]) + s * x[1], n[2] + c * (v[2] - n[2]) + s * x[2]];
}

/** L and V for an Image Slice texel (imageSliceRaw.frag). */
export function sliceLV(thetaH: number, thetaD: number, phiH: number, phiD: number): { L: Vec3; V: Vec3 } {
  const H = sph(thetaH, phiH);
  const D = sph(thetaD, phiD);
  const L = rotate(rotate(D, [0, 1, 0], thetaH), [0, 0, 1], phiH);
  const d = 2 * dot(H, L);
  return { L, V: [d * H[0] - L[0], d * H[1] - L[1], d * H[2] - L[2]] };
}
