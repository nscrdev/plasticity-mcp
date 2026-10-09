import { diffScenes } from "./change-tracker.ts";
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
    if (mesh.sourceFormat !== "obj" && mesh.sourceFormat !== "fbx") {
      const origin = mesh.sourceFormat === "unknown" ? "an unrecognised or unknown source" : `a ${mesh.sourceFormat.toUpperCase()} file`;
      throw new Error(`Reference mesh ${id} came from ${origin}; PolySplines supports OBJ and FBX meshes only. Re-import the source as OBJ with plasticity_import_reference_mesh.`);
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
 * Checks that the supplied edges chain into ONE closed loop using vertex positions from the scene snapshot:
 * every endpoint cluster must be shared by exactly two edge ends and all edges must be one connected component.
 * The check is mandatory: when vertex positions are unavailable it refuses instead of skipping silently.
 * The endpoint tolerance is a fixed 0.01 mm, which suits B-rep vertices.
 */
export function checkClosedBoundary(state: RuntimeState, edges: Array<{ bodyId: number; edgeId: string }>, toleranceMm = 0.01): { checked: true; loops: number; toleranceMm: number } {
  const unavailable = (reference: { bodyId: number; edgeId: string }) => new Error(`Cannot verify that the boundary edges form a closed loop: vertex positions are unavailable for edge ${reference.bodyId}:${reference.edgeId}. Refusing to run an unchecked X-sided fill; capture a fresh snapshot and retry`);
  const clusters: Array<{ position: Vector3; count: number }> = [];
  const clusterOf = (end: Vector3): number => {
    const index = clusters.findIndex((cluster) => Math.hypot(cluster.position[0] - end[0], cluster.position[1] - end[1], cluster.position[2] - end[2]) <= toleranceMm);
    if (index >= 0) { clusters[index]!.count += 1; return index; }
    clusters.push({ position: end, count: 1 });
    return clusters.length - 1;
  };
  const pairs: Array<[number, number]> = [];
  for (const reference of edges) {
    const body = state.bodies.find((candidate) => candidate.id === reference.bodyId);
    const edge = body?.edges.find((candidate) => candidate.id === reference.edgeId);
    if (!body || !edge) throw new Error(`Unknown current edge ${reference.bodyId}:${reference.edgeId}`);
    if (body.type !== "Solid" && body.type !== "Sheet") throw new Error(`Edge ${reference.bodyId}:${reference.edgeId} must belong to a Solid or Sheet`);
    const vertexIds = edge.vertexIds.length === 1 ? [edge.vertexIds[0]!, edge.vertexIds[0]!] : edge.vertexIds;
    if (vertexIds.length !== 2 || !body.vertices) throw unavailable(reference);
    const indices = vertexIds.map((vertexId) => {
      const vertex = body.vertices!.find((candidate) => candidate.id === vertexId);
      if (!vertex) throw unavailable(reference);
      return clusterOf(vertex.positionMm);
    });
    pairs.push([indices[0]!, indices[1]!]);
  }
  const open = clusters.filter((cluster) => cluster.count !== 2);
  if (open.length > 0) {
    throw new Error(`Boundary edges do not form a closed loop: ${open.length} endpoint(s) are shared by ${open.map((cluster) => cluster.count).join(", ")} edge end(s) instead of exactly two (first at ${open[0]!.position.map(round6).join(", ")} mm)`);
  }
  const parent = clusters.map((_, index) => index);
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index]!)));
  for (const [a, b] of pairs) parent[find(a)] = find(b);
  const loops = new Set(clusters.map((_, index) => find(index))).size;
  if (loops !== 1) throw new Error(`Boundary edges form ${loops} separate loops; X-sided fill needs exactly one closed loop`);
  return { checked: true, loops, toleranceMm };
}

export interface XSidedOutcome {
  /** "created" = at least one new Sheet or Solid; "extended" = an owning body gained faces. */
  kind: "created" | "extended";
  newBodies: NewBodySummary;
  extendedBodies: Array<{ id: number; faceCountBefore: number; faceCountAfter: number; versionChanged: boolean }>;
  revisionChanged: boolean;
}

/**
 * Judges an X-sided commit from the scene diff, not from the revision (which also moves on any history
 * entry). Success needs a new Sheet or Solid, or an input edge's owner body whose version changed and whose
 * face count grew. Anything else is thrown with what did change.
 */
export function judgeXSidedOutcome(before: RuntimeState, after: RuntimeState, edges: Array<{ bodyId: number }>): XSidedOutcome {
  const diff = diffScenes(before, after);
  const newBodies = summarizeNewBodies(before, after);
  const newSurfaces = newBodies.bodies.filter((body) => body.type === "Sheet" || body.type === "Solid");
  const owners = new Set(edges.map((edge) => edge.bodyId));
  const extendedBodies = diff.modified
    .filter((entry) => owners.has(entry.id) && entry.after.versionId !== entry.before.versionId && entry.after.faceIds.length > entry.before.faceIds.length)
    .map((entry) => ({ id: entry.id, faceCountBefore: entry.before.faceIds.length, faceCountAfter: entry.after.faceIds.length, versionChanged: true }));
  const revisionChanged = after.revision !== before.revision;
  if (newSurfaces.length > 0) return { kind: "created", newBodies, extendedBodies, revisionChanged };
  if (extendedBodies.length > 0) return { kind: "extended", newBodies, extendedBodies, revisionChanged };
  const changed = [
    `revision ${revisionChanged ? `${before.revision} -> ${after.revision}` : "unchanged"}`,
    `undo depth ${before.undoDepth} -> ${after.undoDepth}`,
    `new bodies ${newBodies.count} (${newBodies.bodies.map((body) => `${body.id}:${body.type}`).join(", ") || "none"})`,
    `modified bodies ${diff.modified.map((entry) => entry.id).join(", ") || "none"}`,
    `removed bodies ${diff.removed.map((body) => body.id).join(", ") || "none"}`,
  ].join("; ");
  throw new Error(`X-sided fill did not create or extend a surface (${changed}). A history step may have been committed: check undo depth and Undo before retrying (an empty history entry may need an Undo)`);
}

export interface PolySplinesOutcome {
  /** True when fewer output bodies than input meshes appeared. */
  partial: boolean;
  inputMeshes: number;
  outputBodies: number;
  /** Source meshes that no longer exist after the conversion (consumed or hidden by the converter). */
  sourceMeshesRemaining: number[];
  details: string | null;
}

/** Compares output bodies with input meshes so a partial conversion is never reported as a clean success. */
export function judgePolySplinesOutcome(after: RuntimeState, meshIds: number[], newBodyCount: number): PolySplinesOutcome {
  const remaining = new Set((after.referenceMeshes ?? []).map((mesh) => mesh.id));
  const sourceMeshesRemaining = meshIds.filter((id) => remaining.has(id));
  const partial = newBodyCount < meshIds.length;
  return {
    partial,
    inputMeshes: meshIds.length,
    outputBodies: newBodyCount,
    sourceMeshesRemaining,
    details: partial
      ? `PARTIAL: ${newBodyCount} body(ies) from ${meshIds.length} input mesh(es); the converter may have skipped meshes with creases or non-quad topology. Inspect the result before relying on it`
      : null,
  };
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

/** Minimum number of known mode thumbnails that must share one container for it to count as the Shader mode panel. */
export const SHADER_PANEL_MIN_MODES = 10;

/** A mutation result: the post-commit scene plus the Studio tool's own report. */
export type StudioResult<T> = RuntimeState & { studio: T };

export interface ShaderModeResult {
  /** Mode the caller asked for, or null for a pure read. */
  requested: ShaderModeName | null;
  /** Number of panel buttons matched inside the Shader mode panel. */
  panelButtons: number;
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
