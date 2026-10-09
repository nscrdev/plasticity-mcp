import assert from "node:assert/strict";
import { test } from "node:test";

import type { RuntimeState } from "./runtime.ts";
import {
  checkClosedBoundary,
  judgePolySplinesOutcome,
  judgeXSidedOutcome,
  normalizePolySplinesOptions,
  normalizeXSidedOptions,
  requirePolySplinesSourceMeshes,
  SHADER_MODES,
  shaderModeForImage,
  summarizeNewBodies,
} from "./studio-surfacing.ts";

const construction: RuntimeState["construction"] = { planes: [], activePlaneId: "standard:top", planeStateToken: "p", viewStateToken: "v" };
const body = (id: number, type: string, extra: Partial<RuntimeState["bodies"][number]> = {}): RuntimeState["bodies"][number] => ({
  id, versionId: id + 100, type, name: `b${id}`, boundsMm: { min: [0, 0, 0], max: [10, 20, 30] },
  faceIds: ["f1", "f2", "f3"], edgeIds: ["e1"], faces: [], edges: [], vertices: [], ...extra,
});
const state = (bodies: RuntimeState["bodies"], referenceMeshes: RuntimeState["referenceMeshes"] = []): RuntimeState => ({
  targetId: "w", title: "t", documentToken: "d", revision: "r", dbVersion: 1, undoDepth: 0, redoDepth: 0,
  regions: [], construction, bodies, referenceMeshes,
});
const mesh = (id: number, sourceFormat: "stl" | "obj" | "3mf" | "fbx" | "unknown") => ({
  id, type: "ReferenceMesh" as const, name: "m", sourcePath: `/tmp/m.${sourceFormat}`, sourceFormat, measurementSource: "reference-mesh" as const,
  boundsMm: null, translationMm: [0, 0, 0] as [number, number, number], rotationQuaternion: [0, 0, 0, 1] as [number, number, number, number],
  sceneScaleToMeters: [1, 1, 1] as [number, number, number], vertexEntries: 0, triangles: 0, visible: true, hidden: false, locked: false,
});

test("summarizeNewBodies reports only new bodies with face counts, size and closed or sheet kind", () => {
  const summary = summarizeNewBodies(state([body(1, "Solid")]), state([body(1, "Solid"), body(2, "Sheet"), body(3, "Solid", { boundsMm: null })]));
  assert.equal(summary.count, 2);
  assert.equal(summary.closedSolids, 1);
  assert.equal(summary.sheets, 1);
  assert.equal(summary.totalFaces, 6);
  assert.deepEqual(summary.bodies.map((entry) => [entry.id, entry.closure, entry.closed, entry.faceCount]), [[2, "sheet", false, 3], [3, "solid", true, 3]]);
  assert.deepEqual(summary.bodies[0]?.sizeMm, [10, 20, 30]);
  assert.equal(summary.bodies[1]?.sizeMm, null);
  assert.equal(summarizeNewBodies(state([body(1, "Sheet")]), state([body(1, "Sheet")])).count, 0);
});

test("PolySplines options are forwarded only when set and must be booleans", () => {
  assert.deepEqual(normalizePolySplinesOptions(undefined), {});
  assert.deepEqual(normalizePolySplinesOptions({ mergePatches: false }), { mergePatches: false });
  assert.deepEqual(normalizePolySplinesOptions({ roundedCorners: true, interpolateBoundary: true }), { roundedCorners: true, interpolateBoundary: true });
  assert.throws(() => normalizePolySplinesOptions({ roundedCorners: "yes" as unknown as boolean }), /roundedCorners must be a boolean/u);
});

test("PolySplines refuses STL and 3MF reference meshes and unknown IDs", () => {
  const scene = state([], [mesh(1, "obj"), mesh(2, "stl"), mesh(3, "3mf"), mesh(4, "unknown"), mesh(5, "fbx")]);
  requirePolySplinesSourceMeshes(scene, [1, 5]);
  assert.throws(() => requirePolySplinesSourceMeshes(scene, [4]), /unknown source/u);
  assert.throws(() => requirePolySplinesSourceMeshes(scene, [2]), /OBJ and FBX meshes only/u);
  assert.throws(() => requirePolySplinesSourceMeshes(scene, [3]), /3MF/u);
  assert.throws(() => requirePolySplinesSourceMeshes(scene, [9]), /Unknown current reference mesh ID: 9/u);
});

test("X-sided options validate ranges and the quad-sided edge count", () => {
  const edges = (count: number) => Array.from({ length: count }, (_, index) => ({ bodyId: 1, edgeId: `e${index}` }));
  assert.deepEqual(normalizeXSidedOptions(edges(4), { uDegree: 5, quadSided: true, toleranceMm: 0.01 }), { uDegree: 5, quadSided: true, toleranceMm: 0.01 });
  assert.throws(() => normalizeXSidedOptions(edges(2), {}), /3\.\.64 boundary edges/u);
  assert.throws(() => normalizeXSidedOptions(edges(65), {}), /3\.\.64 boundary edges/u);
  assert.throws(() => normalizeXSidedOptions([{ bodyId: 1, edgeId: "a" }, { bodyId: 1, edgeId: "a" }, { bodyId: 1, edgeId: "b" }], {}), /unique/u);
  assert.throws(() => normalizeXSidedOptions(edges(3), { quadSided: true }), /exactly 4/u);
  assert.throws(() => normalizeXSidedOptions(edges(4), { uDegree: 1 }), /uDegree/u);
  assert.throws(() => normalizeXSidedOptions(edges(4), { vDegree: 12 }), /vDegree/u);
  assert.throws(() => normalizeXSidedOptions(edges(4), { uSpans: 0 }), /uSpans/u);
  assert.throws(() => normalizeXSidedOptions(edges(4), { vSpans: 2.5 }), /vSpans/u);
  assert.throws(() => normalizeXSidedOptions(edges(4), { toleranceMm: 0 }), /toleranceMm/u);
  assert.throws(() => normalizeXSidedOptions(edges(4), { toleranceMm: 11 }), /toleranceMm/u);
  assert.throws(() => normalizeXSidedOptions(edges(4), { continuity: "G4" as "G3" }), /Continuity must be/u);
});

const loopBody = (id: number, positions: Array<[number, number, number]>, edgeVertices: number[][]) => body(id, "Sheet", {
  edgeIds: edgeVertices.map((_, index) => `e${index}`),
  edges: edgeVertices.map((vertexIds, index) => ({
    id: `e${index}`, curveType: "Line", line: true, circle: false, lengthMm: 1, centerMm: [0, 0, 0], tangent: [1, 0, 0],
    boundsMm: { min: [0, 0, 0], max: [1, 1, 1] }, faceIds: [], vertexIds,
  })),
  vertices: positions.map((positionMm, index) => ({ id: index + 1, positionMm, edgeIds: [], faceIds: [] })),
});

test("checkClosedBoundary accepts a closed loop and names the open endpoint otherwise", () => {
  const positions: Array<[number, number, number]> = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]];
  const closed = state([loopBody(1, positions, [[1, 2], [2, 3], [3, 4], [4, 1]])]);
  const refs = (count: number) => Array.from({ length: count }, (_, index) => ({ bodyId: 1, edgeId: `e${index}` }));
  assert.deepEqual(checkClosedBoundary(closed, refs(4)), { checked: true, loops: 1, toleranceMm: 0.01 });
  assert.throws(() => checkClosedBoundary(closed, refs(3)), /do not form a closed loop.*0, 10, 0 mm|do not form a closed loop/u);
  const { vertices: _dropped, ...noVertices } = loopBody(1, positions, [[1, 2], [2, 3], [3, 4], [4, 1]]);
  const missing = state([noVertices]);
  assert.throws(() => checkClosedBoundary(missing, refs(4)), /Cannot verify.*closed loop/u);
  const eight: Array<[number, number, number]> = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [50, 0, 0], [51, 0, 0], [51, 1, 0]];
  const twoLoops = state([loopBody(4, eight, [[1, 2], [2, 3], [3, 1], [4, 5], [5, 6], [6, 4]])]);
  assert.throws(() => checkClosedBoundary(twoLoops, Array.from({ length: 6 }, (_, index) => ({ bodyId: 4, edgeId: `e${index}` }))), /2 separate loops/u);
  assert.throws(() => checkClosedBoundary(closed, [{ bodyId: 1, edgeId: "nope" }]), /Unknown current edge/u);
  const wire = state([{ ...loopBody(2, positions, [[1, 2]]), type: "Wire" }]);
  assert.throws(() => checkClosedBoundary(wire, [{ bodyId: 2, edgeId: "e0" }]), /Solid or Sheet/u);
  const single = state([loopBody(3, [[0, 0, 0]], [[1]])]);
  assert.equal(checkClosedBoundary(single, [{ bodyId: 3, edgeId: "e0" }]).checked, true);
});

test("shader modes map to the panel thumbnail names read from Plasticity 26.1.3", () => {
  assert.equal(Object.keys(SHADER_MODES).length, 14);
  assert.equal(shaderModeForImage("reflection_check_horizontal"), "zebra_horizontal");
  assert.equal(shaderModeForImage("reflection_check_vertical"), "zebra_vertical");
  assert.equal(shaderModeForImage("face-direction"), "face_direction");
  assert.equal(shaderModeForImage("isophotes"), "isophotes");
  assert.equal(shaderModeForImage("custom_matcap"), null);
});

test("judgeXSidedOutcome needs a new surface or a grown owner body, not just a revision change", () => {
  const before = state([body(1, "Sheet")]);
  const created = judgeXSidedOutcome(before, { ...state([body(1, "Sheet"), body(2, "Sheet")]), revision: "r2" }, [{ bodyId: 1 }]);
  assert.equal(created.kind, "created");
  const extended = judgeXSidedOutcome(before, { ...state([body(1, "Sheet", { versionId: 999, faceIds: ["f1", "f2", "f3", "f4"] })]), revision: "r2" }, [{ bodyId: 1 }]);
  assert.equal(extended.kind, "extended");
  assert.deepEqual(extended.extendedBodies, [{ id: 1, faceCountBefore: 3, faceCountAfter: 4, versionChanged: true }]);
  const historyOnly = { ...state([body(1, "Sheet")]), revision: "r2", undoDepth: 1 };
  assert.throws(() => judgeXSidedOutcome(before, historyOnly, [{ bodyId: 1 }]), /did not create or extend a surface.*undo depth 0 -> 1/u);
  assert.throws(() => judgeXSidedOutcome(before, { ...state([body(1, "Sheet"), body(3, "Wire")]), revision: "r2" }, [{ bodyId: 1 }]), /did not create or extend/u);
});

test("judgePolySplinesOutcome flags fewer output bodies than input meshes as partial", () => {
  const after = state([], [mesh(4, "obj")]);
  const full = judgePolySplinesOutcome(after, [4, 5], 2);
  assert.equal(full.partial, false);
  const partial = judgePolySplinesOutcome(after, [4, 5], 1);
  assert.equal(partial.partial, true);
  assert.deepEqual(partial.sourceMeshesRemaining, [4]);
  assert.match(partial.details ?? "", /PARTIAL/u);
});
