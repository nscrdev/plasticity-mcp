import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PlasticityOperations } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";

const construction: RuntimeState["construction"] = { planes: [], activePlaneId: "standard:top", planeStateToken: "p", viewStateToken: "v" };
const mesh = (id: number, sourceFormat: "stl" | "obj") => ({
  id, type: "ReferenceMesh" as const, name: "m", sourcePath: `/tmp/m.${sourceFormat}`, sourceFormat, measurementSource: "reference-mesh" as const,
  boundsMm: null, translationMm: [0, 0, 0] as [number, number, number], rotationQuaternion: [0, 0, 0, 1] as [number, number, number, number],
  sceneScaleToMeters: [1, 1, 1] as [number, number, number], vertexEntries: 0, triangles: 0, visible: true, hidden: false, locked: false,
});
const sheet = (id: number, edges: number) => ({
  id, versionId: id + 100, type: "Sheet", name: `s${id}`, boundsMm: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] },
  faceIds: ["f1"], edgeIds: Array.from({ length: edges }, (_, i) => `e${i}`), faces: [],
  edges: Array.from({ length: edges }, (_, i) => ({
    id: `e${i}`, curveType: "Line", line: true, circle: false, lengthMm: 10, centerMm: [0, 0, 0] as [number, number, number], tangent: [1, 0, 0] as [number, number, number],
    boundsMm: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] }, faceIds: [], vertexIds: [i + 1, ((i + 1) % edges) + 1],
  })),
  vertices: Array.from({ length: edges }, (_, i) => {
    const angle = (i / edges) * Math.PI * 2;
    return { id: i + 1, positionMm: [Math.cos(angle) * 10, Math.sin(angle) * 10, 0] as [number, number, number], edgeIds: [], faceIds: [] };
  }),
});
const baseState = (over: Partial<RuntimeState> = {}): RuntimeState => ({
  targetId: "w", title: "t", documentToken: "d", revision: "r1", dbVersion: 1, undoDepth: 0, redoDepth: 0,
  regions: [], construction, bodies: [], ...over,
});
type Call = { source: string; bindings: string[]; values: unknown[]; timeout?: number };
function harness(states: RuntimeState[], reads: unknown[] = []) {
  const calls: Call[] = [];
  const readCalls: Array<{ source: string; values: unknown[] }> = [];
  let index = 0;
  const runtime = {
    async getState() { return states[Math.min(index++, states.length - 1)]!; },
    async mutate(source: string, bindings: string[], values: unknown[], timeout?: number) { calls.push({ source, bindings, values, ...(timeout !== undefined ? { timeout } : {}) }); return {}; },
    async read(source: string, values: unknown[]) { readCalls.push({ source, values }); return reads.shift(); },
  } as unknown as PlasticityRuntime;
  return { operations: new PlasticityOperations(runtime), calls, readCalls };
}

test("polySplinesFromReferenceMeshes builds a guarded ConvertMeshToPolySplines script and requires a new body", async () => {
  const before = baseState({ referenceMeshes: [mesh(5, "obj")] });
  const after = baseState({ revision: "r2", referenceMeshes: [mesh(5, "obj")], bodies: [sheet(9, 4)] });
  const { operations, calls } = harness([before, after]);
  const result = await operations.polySplinesFromReferenceMeshes([5], { mergePatches: true }, "r1");
  assert.equal(result.bodies[0]?.id, 9);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.bindings, ["ConvertMeshToPolySplinesFactory", "PolySplinesCommand"]);
  assert.deepEqual(calls[0]?.values, [{ ids: [5], options: { mergePatches: true } }]);
  const source = calls[0]!.source;
  assert.match(source, /factory\.empties = empties/u);
  assert.match(source, /Empties_ObjectEmpty/u);
  assert.match(source, /refusing to guess/u);
  assert.match(source, /did not accept \(read back|did not accept ' \+ String\(value\)/u);
  assert.match(source, /command\.remember = false/u);
});

test("polySplinesFromReferenceMeshes sends no option fields by default and rejects bad input before native calls", async () => {
  const before = baseState({ referenceMeshes: [mesh(5, "obj"), mesh(6, "stl")] });
  const after = baseState({ revision: "r2", referenceMeshes: before.referenceMeshes!, bodies: [sheet(9, 4)] });
  const { operations, calls } = harness([before, after]);
  await operations.polySplinesFromReferenceMeshes([5], {}, "r1");
  assert.deepEqual(calls[0]?.values, [{ ids: [5], options: {} }]);

  const guard = harness([before]);
  await assert.rejects(guard.operations.polySplinesFromReferenceMeshes([5], {}, "stale"), /Stale reference/u);
  await assert.rejects(guard.operations.polySplinesFromReferenceMeshes([6], {}, "r1"), /OBJ and FBX meshes only/u);
  await assert.rejects(guard.operations.polySplinesFromReferenceMeshes([99], {}, "r1"), /Unknown current reference mesh IDs: 99/u);
  await assert.rejects(guard.operations.polySplinesFromReferenceMeshes([], {}, "r1"), /nonempty unique/u);
  await assert.rejects(guard.operations.polySplinesFromReferenceMeshes([5, 5], {}, "r1"), /nonempty unique/u);
  await assert.rejects(guard.operations.polySplinesFromReferenceMeshes([5], { roundedCorners: 1 as unknown as boolean }, "r1"), /boolean/u);
  assert.equal(guard.calls.length, 0);
});

test("polySplinesFromReferenceMeshes fails loudly when no body was created", async () => {
  const before = baseState({ referenceMeshes: [mesh(5, "obj")] });
  const { operations } = harness([before, before]);
  await assert.rejects(operations.polySplinesFromReferenceMeshes([5], {}, "r1"), /without creating any body/u);
});

test("importPolySplines validates the file, requires a unit field and a created body", async () => {
  const root = await mkdtemp(join(tmpdir(), "polysplines-import-"));
  try {
    const obj = join(root, "cage.obj");
    await writeFile(obj, "v 0 0 0\n");
    const empty = join(root, "empty.obj");
    await writeFile(empty, "");
    const stl = join(root, "cage.stl");
    await writeFile(stl, "solid x");
    const before = baseState();
    const after = baseState({ revision: "r2", bodies: [sheet(3, 4), sheet(4, 4)] });
    const { operations, calls } = harness([before, after]);
    const result = await operations.importPolySplines(obj, "millimeter", { roundedCorners: false }, "r1");
    assert.equal(result.bodies.length, 2);
    assert.deepEqual(calls[0]?.bindings, ["ImportPolySplinesFactory", "ImportPolySplinesCommand"]);
    const values = calls[0]!.values[0] as { path: string; sourceUnit: string; options: unknown };
    assert.match(values.path, /cage\.obj$/u);
    assert.equal(values.sourceUnit, "millimeter");
    assert.deepEqual(values.options, { roundedCorners: false });
    assert.match(calls[0]!.source, /if \(!\('unit' in factory\)\)/u);
    assert.match(calls[0]!.source, /plasticity_import_reference_mesh/u);
    assert.match(calls[0]!.source, /factory\.filePath = args\.path/u);

    const guard = harness([before]);
    await assert.rejects(guard.operations.importPolySplines(stl, "millimeter", {}, "r1"), /not STL/u);
    await assert.rejects(guard.operations.importPolySplines(join(root, "x.txt"), "millimeter", {}, "r1"), /\.obj or \.fbx|ENOENT/u);
    await assert.rejects(guard.operations.importPolySplines(empty, "millimeter", {}, "r1"), /must not be empty/u);
    await assert.rejects(guard.operations.importPolySplines(obj, "millimeter", {}, "stale"), /Stale reference/u);
    assert.equal(guard.calls.length, 0);

    const none = harness([before, before]);
    await assert.rejects(none.operations.importPolySplines(obj, "meter", {}, "r1"), /without creating any body/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createXSidedSurface sends metre tolerance, edge continuity and read-back checks", async () => {
  const before = baseState({ bodies: [sheet(1, 4)] });
  const after = baseState({ revision: "r2", bodies: [sheet(1, 4), sheet(2, 1)] });
  const { operations, calls } = harness([before, after]);
  const edges = [0, 1, 2, 3].map((i) => ({ bodyId: 1, edgeId: `e${i}`, ...(i === 0 ? { continuity: "G2" as const } : {}) }));
  await operations.createXSidedSurface(edges, { continuity: "G1", uDegree: 5, vDegree: 4, uSpans: 3, vSpans: 2, quadSided: true, toleranceMm: 0.01 }, "r1");
  assert.deepEqual(calls[0]?.bindings, ["XSidedFactory", "XNurbsCommand", "ContinuityType"]);
  const args = calls[0]!.values[0] as { edges: unknown[]; continuity: string; fields: Record<string, number | boolean>; loopChecked: boolean };
  assert.deepEqual(args.fields, { uDegree: 5, vDegree: 4, uSpans: 3, vSpans: 2, quadSided: true, tolerance: 0.00001 });
  assert.equal(args.continuity, "G1");
  assert.equal(args.loopChecked, true);
  assert.deepEqual(args.edges[0], { bodyId: 1, edgeId: "e0", continuity: "G2" });
  assert.deepEqual(args.edges[1], { bodyId: 1, edgeId: "e1" });
  const source = calls[0]!.source;
  assert.match(source, /factory\.edges = edgeViews/u);
  assert.match(source, /setContinuityForEdge\.length !== 2/u);
  assert.match(source, /getContinuityForEdge\(edgeViews\[index\]\) !== wanted/u);
  assert.match(source, /did not accept the boundary edges/u);
});

test("createXSidedSurface omits unset fields and rejects invalid input before any native call", async () => {
  const before = baseState({ bodies: [sheet(1, 4)] });
  const after = baseState({ revision: "r2", bodies: [sheet(1, 4), sheet(2, 1)] });
  const ok = harness([before, after]);
  const three = [0, 1, 2].map((i) => ({ bodyId: 1, edgeId: `e${i}` }));
  const tri = baseState({ bodies: [sheet(1, 3)] });
  const triOk = harness([tri, after]);
  await triOk.operations.createXSidedSurface(three, {}, "r1");
  assert.deepEqual((triOk.calls[0]!.values[0] as { fields: unknown }).fields, {});
  assert.equal((triOk.calls[0]!.values[0] as { continuity?: unknown }).continuity, undefined);
  void ok;

  const guard = harness([before]);
  const four = [0, 1, 2, 3].map((i) => ({ bodyId: 1, edgeId: `e${i}` }));
  await assert.rejects(guard.operations.createXSidedSurface(four, {}, "stale"), /Stale reference/u);
  await assert.rejects(guard.operations.createXSidedSurface(four.slice(0, 2), {}, "r1"), /3\.\.64/u);
  await assert.rejects(guard.operations.createXSidedSurface(four.slice(0, 3), { quadSided: true }, "r1"), /exactly 4/u);
  await assert.rejects(guard.operations.createXSidedSurface(four.slice(0, 3), {}, "r1"), /closed loop/u);
  await assert.rejects(guard.operations.createXSidedSurface([...four.slice(0, 3), { bodyId: 1, edgeId: "missing" }], {}, "r1"), /Unknown current edge references/u);
  await assert.rejects(guard.operations.createXSidedSurface(four, { toleranceMm: 20 }, "r1"), /toleranceMm/u);
  assert.equal(guard.calls.length, 0);
});

test("createXSidedSurface errors when the document did not change", async () => {
  const before = baseState({ bodies: [sheet(1, 4)] });
  const { operations } = harness([before, before]);
  const four = [0, 1, 2, 3].map((i) => ({ bodyId: 1, edgeId: `e${i}` }));
  await assert.rejects(operations.createXSidedSurface(four, {}, "r1"), /without changing the document/u);
});

test("shaderMode reads and switches via the panel and refuses a changed document revision", async () => {
  const same = baseState();
  const read = harness([same, same], [{ previous: "ceramic_dark", current: "ceramic_dark", available: ["ceramic_dark", "isophotes"] }]);
  const status = await read.operations.shaderMode(undefined);
  assert.deepEqual([status.previous, status.current, status.changed], ["ceramic_dark", "ceramic_dark", false]);
  assert.equal(status.revisionBefore, status.revisionAfter);
  assert.equal((read.readCalls[0]!.values[0] as { mode?: string }).mode, undefined);

  const switched = harness([same, same], [{ previous: "ceramic_dark", current: "zebra_horizontal", available: ["zebra_horizontal"] }]);
  const result = await switched.operations.shaderMode("zebra_horizontal");
  assert.deepEqual([result.previous, result.current, result.changed], ["ceramic_dark", "zebra_horizontal", true]);
  const args = switched.readCalls[0]!.values[0] as { byImage: Record<string, string>; mode: string };
  assert.equal(args.mode, "zebra_horizontal");
  assert.equal(args.byImage.reflection_check_horizontal, "zebra_horizontal");
  assert.equal(args.byImage["face-direction"], "face_direction");
  assert.match(switched.readCalls[0]!.source, /not mounted/u);
  assert.match(switched.readCalls[0]!.source, /button\.click\(\)/u);
  assert.match(switched.readCalls[0]!.source, /did not activate shader mode/u);
  assert.equal(switched.calls.length, 0);

  const edited = harness([same, baseState({ revision: "r2", undoDepth: 1 })], [{ previous: "ceramic_dark", current: "isophotes", available: [] }]);
  await assert.rejects(edited.operations.shaderMode("isophotes"), /changed the document revision \(r1 -> r2\)/u);
  await assert.rejects(harness([same]).operations.shaderMode("sparkle" as "isophotes"), /Unknown shader mode/u);
});

test("every generated Studio script is valid JavaScript", async () => {
  const before = baseState({ referenceMeshes: [mesh(5, "obj")], bodies: [sheet(1, 4)] });
  const after = baseState({ revision: "r2", referenceMeshes: before.referenceMeshes!, bodies: [sheet(1, 4), sheet(2, 1)] });
  const root = await mkdtemp(join(tmpdir(), "studio-syntax-"));
  try {
    const obj = join(root, "a.obj");
    await writeFile(obj, "v 0 0 0\n");
    const sources: string[] = [];
    const a = harness([before, after]);
    await a.operations.polySplinesFromReferenceMeshes([5], { roundedCorners: true }, "r1");
    sources.push(a.calls[0]!.source);
    const b = harness([before, after]);
    await b.operations.importPolySplines(obj, "millimeter", {}, "r1");
    sources.push(b.calls[0]!.source);
    const c = harness([before, after]);
    await c.operations.createXSidedSurface([0, 1, 2, 3].map((i) => ({ bodyId: 1, edgeId: `e${i}` })), { continuity: "G1" }, "r1");
    sources.push(c.calls[0]!.source);
    const d = harness([before, before], [{ previous: null, current: null, available: [] }]);
    await d.operations.shaderMode(undefined);
    sources.push(d.readCalls[0]!.source);
    for (const source of sources) assert.doesNotThrow(() => new Function(`return (${source});`), source.slice(0, 80));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shader mode panel script activates the requested button, retries with pointer events and reports failures", async () => {
  const before = baseState();
  const names = ["ceramic_dark", "isophotes", "reflection_check_horizontal"];
  const build = (stubbornButton: string | null) => {
    const buttons = names.map((image) => {
      const attributes = new Map<string, string>([["data-state", image === "ceramic_dark" ? "active" : "idle"]]);
      const button = {
        image,
        getAttribute: (name: string) => attributes.get(name) ?? null,
        activate() { for (const other of buttons) other.set("idle"); attributes.set("data-state", "active"); },
        set(value: string) { attributes.set("data-state", value); },
        clicks: 0,
        events: [] as string[],
        click() { this.clicks += 1; if (image !== stubbornButton) this.activate(); },
        dispatchEvent(event: { type: string }) { this.events.push(event.type); if (event.type === "click") this.activate(); return true; },
      };
      return button;
    });
    const document = {
      querySelectorAll: () => buttons.map((button) => ({ getAttribute: () => `.././img/${button.image}.png`, closest: () => button })),
    };
    return { buttons, document };
  };
  const run = async (mode: string | undefined, stubborn: string | null, empty = false) => {
    const { buttons, document } = build(stubborn);
    const harnessed = harness([before, before], [{ previous: null, current: null, available: [] }]);
    await harnessed.operations.shaderMode(mode as never);
    const source = harnessed.readCalls[0]!.source;
    const args = harnessed.readCalls[0]!.values[0];
    const fn = new Function("document", "setTimeout", "PointerEvent", "MouseEvent", "window", `return (${source});`)(
      empty ? { querySelectorAll: () => [] } : document, (callback: () => void) => callback(), class { type: string; constructor(type: string) { this.type = type; } }, class { type: string; constructor(type: string) { this.type = type; } }, {},
    ) as (this: unknown, args: unknown) => Promise<{ previous: string | null; current: string | null; available: string[] }>;
    return { buttons, outcome: fn.call({ viewports: new Set([{ setNeedsRender() { rendered += 1; } }]) }, args) };
  };
  let rendered = 0;
  const switched = await run("zebra_horizontal", null);
  const outcome = await switched.outcome;
  assert.deepEqual(outcome, { previous: "ceramic_dark", current: "zebra_horizontal", available: ["ceramic_dark", "isophotes", "zebra_horizontal"] });
  assert.equal(switched.buttons[2]!.clicks, 1);
  assert.equal(rendered, 1);

  const readOnly = await (await run(undefined, null)).outcome;
  assert.equal(readOnly.current, "ceramic_dark");
  const already = await run("ceramic_dark", null);
  await already.outcome;
  assert.equal(already.buttons[0]!.clicks, 0);

  const fallback = await run("isophotes", "isophotes");
  assert.equal((await fallback.outcome).current, "isophotes");
  assert.deepEqual(fallback.buttons[1]!.events, ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]);

  const absent = await run(undefined, null, true);
  await assert.rejects(absent.outcome, /panel is not mounted/u);
});
