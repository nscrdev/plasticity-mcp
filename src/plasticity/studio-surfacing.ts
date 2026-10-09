import type { RuntimeState } from "./runtime.ts";

type Vector3 = [number, number, number];

/**
 * Helpers for the Plasticity Studio surfacing tools (PolySplines, X-sided fill, shader mode).
 * Everything here is pure so the generated native scripts and the result summaries can be tested
 * without a live Plasticity.
 */

export type PolySplinesBodySummary = {
  id: number;
  type: string;
  name: string | null;
  /** "solid" = closed Solid body, "sheet" = open Sheet body, otherwise the native type name lower-cased. */
  closure: "solid" | "sheet" | string;
  closed: boolean;
  faceCount: number;
  edgeCount: number;
  boundsMm: { min: Vector3; max: Vector3 } | null;
  sizeMm: Vector3 | null;
};

export type NewBodySummary = {
  count: number;
  closedSolids: number;
  sheets: number;
  totalFaces: number;
  bodies: PolySplinesBodySummary[];
};

/** Bodies present in `after` whose ID was not present in `before`, with face counts, bounds and closed/open kind. */
export function summarizeNewBodies(before: RuntimeState, after: RuntimeState): NewBodySummary {
  const previous = new Set(before.bodies.map((body) => body.id));
  const bodies = after.bodies.filter((body) => !previous.has(body.id)).map((body): PolySplinesBodySummary => {
    const bounds = body.boundsMm;
    return {
      id: body.id,
      type: body.type,
      name: body.name,
      closure: body.type === "Solid" ? "solid" : body.type === "Sheet" ? "sheet" : body.type.toLowerCase(),
      closed: body.type === "Solid",
      faceCount: body.faceIds.length,
      edgeCount: body.edgeIds.length,
      boundsMm: bounds,
      sizeMm: bounds ? [0, 1, 2].map((axis) => round6(bounds.max[axis]! - bounds.min[axis]!)) as Vector3 : null,
    };
  });
  return {
    count: bodies.length,
    closedSolids: bodies.filter((body) => body.closed).length,
    sheets: bodies.filter((body) => body.type === "Sheet").length,
    totalFaces: bodies.reduce((sum, body) => sum + body.faceCount, 0),
    bodies,
  };
}

export function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export interface PolySplinesOptions {
  /** Native "Rounded corners" switch. */
  roundedCorners?: boolean | undefined;
  /** Native "Merge patches" switch. */
  mergePatches?: boolean | undefined;
  /** Native "Interpolate boundary exactly" switch. */
  interpolateBoundary?: boolean | undefined;
}

const POLYSPLINES_OPTION_KEYS = ["roundedCorners", "mergePatches", "interpolateBoundary"] as const;

/** Returns only the options the caller set, rejecting non-boolean values. */
export function normalizePolySplinesOptions(options: PolySplinesOptions | undefined): Partial<Record<(typeof POLYSPLINES_OPTION_KEYS)[number], boolean>> {
  const result: Partial<Record<(typeof POLYSPLINES_OPTION_KEYS)[number], boolean>> = {};
  for (const key of POLYSPLINES_OPTION_KEYS) {
    const value = options?.[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") throw new Error(`PolySplines option ${key} must be a boolean`);
    result[key] = value;
  }
  return result;
}

/**
 * The reference meshes PolySplines accepts. The native command refuses STL ("PolySplines supports OBJ and
 * FBX meshes, but not STL") and the converter has no 3MF path, so reject those up front with the same advice.
 */
export function requirePolySplinesSourceMeshes(state: RuntimeState, ids: number[]): void {
  const meshes = state.referenceMeshes ?? [];
  for (const id of ids) {
    const mesh = meshes.find((candidate) => candidate.id === id);
    if (!mesh) throw new Error(`Unknown current reference mesh ID: ${id}`);
    if (mesh.sourceFormat === "stl" || mesh.sourceFormat === "3mf") {
      throw new Error(`Reference mesh ${id} came from a ${mesh.sourceFormat.toUpperCase()} file; PolySplines supports OBJ and FBX meshes only. Re-import the source as OBJ with plasticity_import_reference_mesh.`);
    }
  }
}

export const XSIDED_CONTINUITIES = ["G0", "G1", "G2", "G3"] as const;
export type XSidedContinuity = (typeof XSIDED_CONTINUITIES)[number];

export interface XSidedEdgeInput {
  bodyId: number;
  edgeId: string;
  continuity?: XSidedContinuity | undefined;
}

export interface XSidedOptions {
  /** Continuity applied to every boundary edge; per-edge `continuity` overrides it. */
  continuity?: XSidedContinuity | undefined;
  uDegree?: number | undefined;
  vDegree?: number | undefined;
  uSpans?: number | undefined;
  vSpans?: number | undefined;
  quadSided?: boolean | undefined;
  toleranceMm?: number | undefined;
}

export const XSIDED_LIMITS = {
  edges: { min: 3, max: 64 },
  degree: { min: 2, max: 11 },
  spans: { min: 1, max: 64 },
  toleranceMm: { min: 0, max: 10 },
} as const;

/** Validates ranges and cross-field rules for the X-sided / XNurbs fill. Returns the normalized options. */
export function normalizeXSidedOptions(edges: XSidedEdgeInput[], options: XSidedOptions): XSidedOptions {
  const { min, max } = XSIDED_LIMITS.edges;
  if (edges.length < min || edges.length > max) throw new Error(`X-sided fill needs ${min}..${max} boundary edges, got ${edges.length}`);
  const keys = edges.map((edge) => `${edge.bodyId}:${edge.edgeId}`);
  if (new Set(keys).size !== keys.length) throw new Error("Edge references must be unique");
  for (const edge of edges) {
    if (edge.continuity !== undefined && !XSIDED_CONTINUITIES.includes(edge.continuity)) throw new Error(`Edge continuity must be one of ${XSIDED_CONTINUITIES.join(", ")}`);
  }
  if (options.continuity !== undefined && !XSIDED_CONTINUITIES.includes(options.continuity)) throw new Error(`Continuity must be one of ${XSIDED_CONTINUITIES.join(", ")}`);
  for (const key of ["uDegree", "vDegree"] as const) {
    const value = options[key];
    if (value !== undefined && (!Number.isInteger(value) || value < XSIDED_LIMITS.degree.min || value > XSIDED_LIMITS.degree.max)) {
      throw new Error(`${key} must be an integer within ${XSIDED_LIMITS.degree.min}..${XSIDED_LIMITS.degree.max}`);
    }
  }
  for (const key of ["uSpans", "vSpans"] as const) {
    const value = options[key];
    if (value !== undefined && (!Number.isInteger(value) || value < XSIDED_LIMITS.spans.min || value > XSIDED_LIMITS.spans.max)) {
      throw new Error(`${key} must be an integer within ${XSIDED_LIMITS.spans.min}..${XSIDED_LIMITS.spans.max}`);
    }
  }
  if (options.toleranceMm !== undefined && (!Number.isFinite(options.toleranceMm) || options.toleranceMm <= XSIDED_LIMITS.toleranceMm.min || options.toleranceMm > XSIDED_LIMITS.toleranceMm.max)) {
    throw new Error(`toleranceMm must be greater than 0 and at most ${XSIDED_LIMITS.toleranceMm.max}`);
  }
  if (options.quadSided !== undefined && typeof options.quadSided !== "boolean") throw new Error("quadSided must be a boolean");
  if (options.quadSided === true && edges.length !== 4) throw new Error(`quadSided requires exactly 4 boundary edges, got ${edges.length}`);
  return options;
}

/**
 * Checks that the supplied edges chain into closed loops using vertex positions from the scene snapshot
 * (every endpoint cluster must be shared by exactly two edge ends). Returns a note instead of failing when
 * vertex positions are not available so a missing field never blocks a valid fill.
 */
export function checkClosedBoundary(state: RuntimeState, edges: Array<{ bodyId: number; edgeId: string }>, toleranceMm = 0.01): { checked: boolean; note?: string } {
  const ends: Vector3[] = [];
  for (const reference of edges) {
    const body = state.bodies.find((candidate) => candidate.id === reference.bodyId);
    const edge = body?.edges.find((candidate) => candidate.id === reference.edgeId);
    if (!body || !edge) throw new Error(`Unknown current edge ${reference.bodyId}:${reference.edgeId}`);
    if (body.type !== "Solid" && body.type !== "Sheet") throw new Error(`Edge ${reference.bodyId}:${reference.edgeId} must belong to a Solid or Sheet`);
    const vertexIds = edge.vertexIds.length === 1 ? [edge.vertexIds[0]!, edge.vertexIds[0]!] : edge.vertexIds;
    if (vertexIds.length !== 2 || !body.vertices) return { checked: false, note: "vertex positions unavailable; closed-loop check skipped" };
    for (const vertexId of vertexIds) {
      const vertex = body.vertices.find((candidate) => candidate.id === vertexId);
      if (!vertex) return { checked: false, note: "vertex positions unavailable; closed-loop check skipped" };
      ends.push(vertex.positionMm);
    }
  }
  const clusters: Array<{ position: Vector3; count: number }> = [];
  for (const end of ends) {
    const found = clusters.find((cluster) => Math.hypot(cluster.position[0] - end[0], cluster.position[1] - end[1], cluster.position[2] - end[2]) <= toleranceMm);
    if (found) found.count += 1;
    else clusters.push({ position: end, count: 1 });
  }
  const open = clusters.filter((cluster) => cluster.count !== 2);
  if (open.length > 0) {
    throw new Error(`Boundary edges do not form a closed loop: ${open.length} endpoint(s) are shared by ${open.map((cluster) => cluster.count).join(", ")} edge end(s) instead of exactly two (first at ${open[0]!.position.map(round6).join(", ")} mm)`);
  }
  return { checked: true };
}

/**
 * Viewport shader modes, keyed by the thumbnail image Plasticity's Shader mode panel renders for each button.
 * The image file names are the only stable identifiers for these buttons (read from the live panel DOM on 26.1.3).
 */
export const SHADER_MODES = {
  ceramic_dark: { image: "ceramic_dark", kind: "matcap" },
  metal_carpaint: { image: "metal_carpaint", kind: "matcap" },
  dark_shiny: { image: "dark_shiny", kind: "matcap" },
  gradient: { image: "gradient", kind: "matcap" },
  ceramic_lightbulb: { image: "ceramic_lightbulb", kind: "matcap" },
  color_matcap: { image: "color_matcap", kind: "matcap" },
  black_silhouette: { image: "black_silhouette", kind: "matcap" },
  color_silhouette: { image: "color_silhouette", kind: "matcap" },
  isophotes: { image: "isophotes", kind: "analysis" },
  draft: { image: "draft", kind: "analysis" },
  zebra_horizontal: { image: "reflection_check_horizontal", kind: "analysis" },
  zebra_vertical: { image: "reflection_check_vertical", kind: "analysis" },
  topo: { image: "topo", kind: "analysis" },
  face_direction: { image: "face-direction", kind: "analysis" },
} as const;

export type ShaderModeName = keyof typeof SHADER_MODES;
export const SHADER_MODE_NAMES = Object.keys(SHADER_MODES) as [ShaderModeName, ...ShaderModeName[]];

export interface ShaderModeResult {
  /** Mode that was active before the call, or null when it is a custom matcap or unrecognised. */
  previous: ShaderModeName | null;
  /** Mode active after the call. */
  current: ShaderModeName | null;
  changed: boolean;
  available: ShaderModeName[];
  revisionBefore: string;
  revisionAfter: string;
}

export function shaderModeForImage(image: string): ShaderModeName | null {
  for (const [name, entry] of Object.entries(SHADER_MODES)) if (entry.image === image) return name as ShaderModeName;
  return null;
}
