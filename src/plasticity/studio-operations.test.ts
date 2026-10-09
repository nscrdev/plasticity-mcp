import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PlasticityOperations } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";
import { runInjectedScript } from "./script-harness.ts";
import { SHADER_MODES } from "./studio-surfacing.ts";

// ---------------------------------------------------------------- scene fixtures

const construction: RuntimeState["construction"] = { planes: [], activePlaneId: "standard:top", planeStateToken: "p", viewStateToken: "v" };
const mesh = (id: number, sourceFormat: "stl" | "obj") => ({
  id, type: "ReferenceMesh" as const, name: "m", sourcePath: `/tmp/m.${sourceFormat}`, sourceFormat, measurementSource: "reference-mesh" as const,
  boundsMm: null, translationMm: [0, 0, 0] as [number, number, number], rotationQuaternion: [0, 0, 0, 1] as [number, number, number, number],
  sceneScaleToMeters: [1, 1, 1] as [number, number, number], vertexEntries: 0, triangles: 0, visible: true, hidden: false, locked: false,
});
const sheet = (id: number, edges: number, extra: Record<string, unknown> = {}) => ({
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
  ...extra,
});
const baseState = (over: Partial<RuntimeState> = {}): RuntimeState => ({
  targetId: "w", title: "t", documentToken: "d", revision: "r1", dbVersion: 1, undoDepth: 0, redoDepth: 0,
  regions: [], construction, bodies: [], ...over,
});

// ---------------------------------------------------------------- harness runtime

/** mutate() and read() execute the generated script against fake native objects. */
function harness(states: RuntimeState[], options: { bindings?: Record<string, unknown>; editor?: () => object } = {}) {
  let index = 0;
  const sources: string[] = [];
  const runtime = {
    async getState() { return states[Math.min(index++, states.length - 1)]!; },
    async mutate(source: string, bindingNames: string[], values: unknown[]) {
      sources.push(source);
      return await runInjectedScript(source, bindingNames, values, { isStudioLicense: () => true, hasXNurbs: () => true, ...options.bindings }, options.editor?.() ?? {});
    },
    async read(source: string, values: unknown[]) {
      sources.push(source);
      return await runInjectedScript(source, [], values, {}, options.editor?.() ?? {});
    },
  } as unknown as PlasticityRuntime;
  return { operations: new PlasticityOperations(runtime), sources };
}

class FakeCommand {
  remember = true;
  constructor(_editor: unknown) {}
  execute: () => Promise<unknown> = async () => undefined;
}
const execOnly = { exec: async (command: { execute: () => Promise<unknown> }) => { await command.execute(); } };

// ---------------------------------------------------------------- PolySplines from reference mesh

type Hooks = { onCommit?: (factory: any) => void };
function polySplinesFactory(created: any[], shape: "ok" | "no-merge-field" | "mapping" | "reset-by-option" | "no-empties" = "ok", hooks: Hooks = {}) {
  class Factory {
    committed = 0;
    roundedCorners = false;
    interpolateBoundary = false;
    _merge = false;
    _empties: unknown[] = [];
    constructor(_editor: unknown) {
      created.push(this);
      if (shape === "reset-by-option") {
        Object.defineProperty(this, "roundedCorners", { get() { return this._rc ?? false; }, set(value: boolean) { this._rc = value; this._empties = []; }, configurable: true });
      }
    }
    get empties() { return this._empties; }
    set empties(value: unknown[]) { this._empties = value; }
    get mergePatches() { return this._merge; }
    set mergePatches(value: boolean) { this._merge = shape === "mapping" ? !value : value; }
    resource(_command: unknown) { return this; }
    async commit() { this.committed += 1; hooks.onCommit?.(this); return []; }
  }
  if (shape === "no-merge-field") {
    delete (Factory.prototype as any).mergePatches;
    delete (Factory.prototype as any).mergePatches;
  }
  if (shape === "no-empties") {
    delete (Factory.prototype as any).empties;
    delete (Factory.prototype as any).empties;
  }
  return Factory;
}
function polySplinesEditor(ids: number[]) {
  return () => ({
    executor: { isBusy: false },
    db: { lookupEmptyById: (id: number) => (ids.includes(id) ? new (class Empties_ObjectEmpty {})() : undefined) },
    ...execOnly,
  });
}
function polySplinesRun(shape: Parameters<typeof polySplinesFactory>[1], states: RuntimeState[]) {
  const created: any[] = [];
  const Factory = polySplinesFactory(created, shape);
  const h = harness(states, { bindings: { ConvertMeshToPolySplinesFactory: Factory, PolySplinesCommand: FakeCommand }, editor: polySplinesEditor([5, 6]) });
  return { created, ...h };
}

test("polySplines script runs: sets empties before options and returns the values read back", async () => {
  const before = baseState({ referenceMeshes: [mesh(5, "obj")] });
  const after = baseState({ revision: "r2", referenceMeshes: [mesh(5, "obj")], bodies: [sheet(9, 4)] });
  const { operations, created } = polySplinesRun("ok", [before, after]);
  const result = await operations.polySplinesFromReferenceMeshes([5], { mergePatches: true, roundedCorners: true }, "r1");
  assert.equal(created.length, 1);
  assert.equal(created[0].committed, 1);
  assert.equal(created[0].mergePatches, true);
  assert.deepEqual(result.studio.readBack, { mergePatches: true, roundedCorners: true, empties: 1 });
  assert.equal(result.studio.outcome.partial, false);
  assert.equal(result.studio.polySplines.count, 1);
});

test("polySplines script refuses before commit when a field is missing, maps the value, or is reset by a later setter", async () => {
  const before = baseState({ referenceMeshes: [mesh(5, "obj")] });
  const after = baseState({ revision: "r2", referenceMeshes: [mesh(5, "obj")], bodies: [sheet(9, 4)] });

  const missing = polySplinesRun("no-merge-field", [before, after]);
  await assert.rejects(missing.operations.polySplinesFromReferenceMeshes([5], { mergePatches: true }, "r1"), /has no mergePatches field/u);
  assert.equal(missing.created[0].committed, 0);

  const mapping = polySplinesRun("mapping", [before, after]);
  await assert.rejects(mapping.operations.polySplinesFromReferenceMeshes([5], { mergePatches: true }, "r1"), /mergePatches did not accept true \(read back false\)/u);
  assert.equal(mapping.created[0].committed, 0);

  const reset = polySplinesRun("reset-by-option", [before, after]);
  await assert.rejects(reset.operations.polySplinesFromReferenceMeshes([5], { roundedCorners: true }, "r1"), /lost the reference meshes/u);
  assert.equal(reset.created[0].committed, 0);

  const noEmpties = polySplinesRun("no-empties", [before, after]);
  await assert.rejects(noEmpties.operations.polySplinesFromReferenceMeshes([5], {}, "r1"), /has no empties field/u);
  assert.equal(noEmpties.created[0].committed, 0);
});

test("polySplines reports a no-op commit as failure and a partial conversion explicitly", async () => {
  const meshes = [mesh(5, "obj"), mesh(6, "obj")];
  const before = baseState({ referenceMeshes: meshes });
  const noop = polySplinesRun("ok", [before, { ...before, revision: "r2", undoDepth: 1 }]);
  await assert.rejects(noop.operations.polySplinesFromReferenceMeshes([5, 6], {}, "r1"), /without creating any body/u);
  assert.equal(noop.created[0].committed, 1);

  const partial = polySplinesRun("ok", [before, baseState({ revision: "r2", referenceMeshes: meshes, bodies: [sheet(9, 4)] })]);
  const result = await partial.operations.polySplinesFromReferenceMeshes([5, 6], {}, "r1");
  assert.equal(result.studio.outcome.partial, true);
  assert.equal(result.studio.outcome.inputMeshes, 2);
  assert.equal(result.studio.outcome.outputBodies, 1);
  assert.match(result.studio.outcome.details ?? "", /PARTIAL/u);
});

test("polySplines rejects bad input before any native call", async () => {
  const before = baseState({ referenceMeshes: [mesh(5, "obj"), mesh(6, "stl")] });
  const guard = polySplinesRun("ok", [before]);
  await assert.rejects(guard.operations.polySplinesFromReferenceMeshes([5], {}, "stale"), /Stale reference/u);
  await assert.rejects(guard.operations.polySplinesFromReferenceMeshes([6], {}, "r1"), /OBJ and FBX meshes only/u);
  await assert.rejects(guard.operations.polySplinesFromReferenceMeshes([99], {}, "r1"), /Unknown current reference mesh IDs: 99/u);
  await assert.rejects(guard.operations.polySplinesFromReferenceMeshes([5, 5], {}, "r1"), /nonempty unique/u);
  await assert.rejects(guard.operations.polySplinesFromReferenceMeshes([5], { roundedCorners: 1 as unknown as boolean }, "r1"), /boolean/u);
  assert.equal(guard.created.length, 0);
});

// ---------------------------------------------------------------- import PolySplines

function importFactory(created: any[], shape: "ok" | "no-filePath" | "no-unit" | "reset-filePath" | "mapping-unit") {
  class Factory {
    committed = 0;
    roundedCorners = false;
    mergePatches = false;
    interpolateBoundary = false;
    _unit = "meter";
    _path = "";
    constructor(_editor: unknown) {
      created.push(this);
      if (shape === "reset-filePath") {
        Object.defineProperty(this, "roundedCorners", { get() { return this._rc ?? false; }, set(value: boolean) { this._rc = value; this._path = ""; }, configurable: true });
      }
    }
    get unit() { return this._unit; }
    set unit(value: string) { this._unit = shape === "mapping-unit" ? "meter" : value; }
    get filePath() { return this._path; }
    set filePath(value: string) { this._path = value; }
    resource(_command: unknown) { return this; }
    async commit() { this.committed += 1; return []; }
  }
  if (shape === "no-filePath") { delete (Factory.prototype as any).filePath; delete (Factory.prototype as any).filePath; }
  if (shape === "no-unit") { delete (Factory.prototype as any).unit; }
  return Factory;
}

test("importPolySplines script runs against a fake factory and refuses missing, mapped or reset fields before commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "polysplines-import-"));
  try {
    const obj = join(root, "cage.obj");
    await writeFile(obj, "v 0 0 0\n");
    const before = baseState();
    const after = baseState({ revision: "r2", bodies: [sheet(3, 4), sheet(4, 4)] });
    const run = (shape: Parameters<typeof importFactory>[1], states = [before, after]) => {
      const created: any[] = [];
      return { created, ...harness(states, { bindings: { ImportPolySplinesFactory: importFactory(created, shape), ImportPolySplinesCommand: FakeCommand }, editor: () => ({ executor: { isBusy: false }, ...execOnly }) }) };
    };

    const ok = run("ok");
    const result = await ok.operations.importPolySplines(obj, "millimeter", { roundedCorners: true }, "r1");
    assert.equal(result.bodies.length, 2);
    assert.equal(ok.created[0].committed, 1);
    assert.match(result.studio.readBack.filePath as string, /cage\.obj$/u);
    assert.deepEqual([result.studio.readBack.unit, result.studio.readBack.roundedCorners], ["millimeter", true]);

    for (const [shape, pattern] of [["no-filePath", /has no filePath field/u], ["no-unit", /has no unit field/u], ["mapping-unit", /unit did not accept millimeter \(read back meter\)/u], ["reset-filePath", /filePath no longer holds/u]] as const) {
      const bad = run(shape);
      await assert.rejects(bad.operations.importPolySplines(obj, "millimeter", { roundedCorners: true }, "r1"), pattern);
      assert.equal(bad.created[0].committed, 0, shape);
    }

    const none = run("ok", [before, { ...before, revision: "r2", undoDepth: 1 }]);
    await assert.rejects(none.operations.importPolySplines(obj, "meter", {}, "r1"), /without creating any body/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("importPolySplines validates the file before any native call", async () => {
  const root = await mkdtemp(join(tmpdir(), "polysplines-import-"));
  try {
    const empty = join(root, "empty.obj");
    await writeFile(empty, "");
    const stl = join(root, "cage.stl");
    await writeFile(stl, "solid x");
    const guard = harness([baseState()]);
    await assert.rejects(guard.operations.importPolySplines(stl, "millimeter", {}, "r1"), /not STL/u);
    await assert.rejects(guard.operations.importPolySplines(join(root, "x.txt"), "millimeter", {}, "r1"), /\.obj or \.fbx|ENOENT/u);
    await assert.rejects(guard.operations.importPolySplines(empty, "millimeter", {}, "r1"), /must not be empty/u);
    await assert.rejects(guard.operations.importPolySplines(empty, "millimeter", {}, "stale"), /Stale reference/u);
    assert.equal(guard.sources.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- X-sided surface

const CONTINUITY = { G0: 0, G1: 1, G2: 2, G3: 3 };
function xsidedFactory(created: any[], shape: "ok" | "ignored-global" | "bad-arity" | "mm-default" | "reset-edges") {
  class Factory {
    committed = 0;
    _edges: unknown[] = [];
    uDegree = 3;
    vDegree = 3;
    uSpans = 1;
    vSpans = 1;
    quadSided = false;
    tolerance = shape === "mm-default" ? 0.1 : 1e-6;
    _continuity = 0;
    perEdge = new Map<unknown, number>();
    constructor(_editor: unknown) {
      created.push(this);
      if (shape === "reset-edges") {
        Object.defineProperty(this, "uDegree", { get() { return this._ud ?? 3; }, set(value: number) { this._ud = value; this._edges = []; }, configurable: true });
      }
    }
    get edges() { return this._edges; }
    set edges(value: unknown[]) { this._edges = value; this.perEdge = new Map(value.map((edge) => [edge, 0])); }
    get continuity() { return this._continuity; }
    set continuity(value: number) { this._continuity = value; if (shape !== "ignored-global") for (const edge of this.perEdge.keys()) this.perEdge.set(edge, value); }
    getContinuityForEdge(edge: unknown) { return this.perEdge.get(edge); }
    resource(_command: unknown) { return this; }
    async commit() { this.committed += 1; return []; }
  }
  if (shape === "bad-arity") {
    (Factory.prototype as any).setContinuityForEdge = function (edge: unknown) { this.perEdge.set(edge, 0); };
  } else {
    (Factory.prototype as any).setContinuityForEdge = function (edge: unknown, value: number) { this.perEdge.set(edge, value); };
  }
  return Factory;
}
function sheetEditor(edgeCount: number) {
  class Sheet {
    high = { edges: { versionIds: Array.from({ length: edgeCount }, (_, i) => `e${i}`), get: (index: number) => ({ edge: index }) } };
  }
  const view = new Sheet();
  return () => ({
    geo: { geometryModel: new Map([[101, { view }]]) },
    db: { lookupStableId: (id: number) => (id === 101 ? 1 : -1) },
    executor: { isBusy: false },
    ...execOnly,
  });
}
const loop = (count: number, continuity?: Record<number, "G0" | "G1" | "G2" | "G3">) =>
  Array.from({ length: count }, (_, i) => ({ bodyId: 1, edgeId: `e${i}`, ...(continuity?.[i] ? { continuity: continuity[i] } : {}) }));
function xsidedRun(shape: Parameters<typeof xsidedFactory>[1], states: RuntimeState[], edgeCount = 4) {
  const created: any[] = [];
  return { created, ...harness(states, { bindings: { XSidedFactory: xsidedFactory(created, shape), XNurbsCommand: FakeCommand, ContinuityType: CONTINUITY }, editor: sheetEditor(edgeCount) }) };
}
const xsidedBefore = () => baseState({ bodies: [sheet(1, 4)] });
const xsidedAfter = () => baseState({ revision: "r2", bodies: [sheet(1, 4), sheet(2, 1)] });

test("xsided script runs: metre tolerance, per-edge continuity and values returned are the ones read back", async () => {
  const run = xsidedRun("ok", [xsidedBefore(), xsidedAfter()]);
  const result = await run.operations.createXSidedSurface(loop(4, { 0: "G2" }), { continuity: "G1", uDegree: 5, vDegree: 4, uSpans: 3, vSpans: 2, quadSided: true, toleranceMm: 0.01 }, "r1");
  const factory = run.created[0];
  assert.equal(factory.committed, 1);
  assert.equal(factory.tolerance, 0.00001);
  assert.deepEqual([factory.uDegree, factory.vDegree, factory.uSpans, factory.vSpans, factory.quadSided], [5, 4, 3, 2, true]);
  assert.equal(result.studio.readBack.tolerance, 0.00001);
  assert.equal(result.studio.readBack.continuity, 1);
  assert.deepEqual((result.studio.readBack.perEdgeContinuity as Array<{ continuity: number }>).map((entry) => entry.continuity), [2, 1, 1, 1]);
  assert.equal(result.studio.outcome.kind, "created");
  assert.equal(result.studio.loopCheck.loops, 1);
});

test("xsided succeeds when an input body gains faces without a new body", async () => {
  const grown = baseState({ revision: "r2", bodies: [sheet(1, 4, { versionId: 777, faceIds: ["f1", "f2"] })] });
  const run = xsidedRun("ok", [xsidedBefore(), grown]);
  const result = await run.operations.createXSidedSurface(loop(4), {}, "r1");
  assert.equal(result.studio.outcome.kind, "extended");
});

test("xsided fails loudly when only the history changed (undo depth bump, no geometry)", async () => {
  const historyOnly = { ...xsidedBefore(), revision: "r2", undoDepth: 1 };
  const run = xsidedRun("ok", [xsidedBefore(), historyOnly]);
  await assert.rejects(run.operations.createXSidedSurface(loop(4), {}, "r1"), /did not create or extend a surface.*undo depth 0 -> 1/u);
  assert.equal(run.created[0].committed, 1);
  const unchanged = xsidedRun("ok", [xsidedBefore(), xsidedBefore()]);
  await assert.rejects(unchanged.operations.createXSidedSurface(loop(4), {}, "r1"), /did not create or extend a surface/u);
});

test("xsided script refuses before commit on bad tolerance unit, missing per-edge API, ignored global continuity or reset edges", async () => {
  const mm = xsidedRun("mm-default", [xsidedBefore(), xsidedAfter()]);
  await assert.rejects(mm.operations.createXSidedSurface(loop(4), { toleranceMm: 0.01 }, "r1"), /looks like millimetres/u);
  assert.equal(mm.created[0].committed, 0);

  const arity = xsidedRun("bad-arity", [xsidedBefore(), xsidedAfter()]);
  await assert.rejects(arity.operations.createXSidedSurface(loop(4, { 0: "G2" }), {}, "r1"), /expected \(edge, continuity\) signature/u);
  assert.equal(arity.created[0].committed, 0);

  const ignored = xsidedRun("ignored-global", [xsidedBefore(), xsidedAfter()]);
  await assert.rejects(ignored.operations.createXSidedSurface(loop(4), { continuity: "G2" }, "r1"), /has continuity 0 instead of G2/u);
  assert.equal(ignored.created[0].committed, 0);

  const reset = xsidedRun("reset-edges", [xsidedBefore(), xsidedAfter()]);
  await assert.rejects(reset.operations.createXSidedSurface(loop(4), { uDegree: 5 }, "r1"), /lost the boundary edges/u);
  assert.equal(reset.created[0].committed, 0);
});

test("xsided rejects invalid input before any native call, and refuses an unverifiable or split boundary", async () => {
  const guard = xsidedRun("ok", [xsidedBefore()]);
  await assert.rejects(guard.operations.createXSidedSurface(loop(4), {}, "stale"), /Stale reference/u);
  await assert.rejects(guard.operations.createXSidedSurface(loop(2), {}, "r1"), /3\.\.64/u);
  await assert.rejects(guard.operations.createXSidedSurface(loop(3), { quadSided: true }, "r1"), /exactly 4/u);
  await assert.rejects(guard.operations.createXSidedSurface(loop(3), {}, "r1"), /closed loop/u);
  await assert.rejects(guard.operations.createXSidedSurface([...loop(3), { bodyId: 1, edgeId: "missing" }], {}, "r1"), /Unknown current edge references/u);
  await assert.rejects(guard.operations.createXSidedSurface(loop(4), { toleranceMm: 20 }, "r1"), /toleranceMm/u);
  const { vertices: _vertices, ...noVertices } = sheet(1, 4);
  const unchecked = xsidedRun("ok", [baseState({ bodies: [noVertices as never] })]);
  await assert.rejects(unchecked.operations.createXSidedSurface(loop(4), {}, "r1"), /Cannot verify.*closed loop/u);
  assert.equal(guard.created.length + unchecked.created.length, 0);
});

// ---------------------------------------------------------------- shader mode (fake DOM)

class FakeNode {
  parentElement: FakeNode | null = null;
  attrs = new Map<string, string>();
  clicks = 0;
  onClick: (() => void) | null = null;
  tag: string;
  constructor(tag: string) { this.tag = tag; }
  append(child: FakeNode) { child.parentElement = this; return child; }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  contains(other: FakeNode) { for (let node: FakeNode | null = other; node; node = node.parentElement) if (node === this) return true; return false; }
  closest(tag: string) { for (let node: FakeNode | null = this; node; node = node.parentElement) if (node.tag === tag) return node; return null; }
  click() { this.clicks += 1; this.onClick?.(); }
}
const imageNames: string[] = Object.values(SHADER_MODES).map((entry) => entry.image);

function buildDom(options: { panel?: boolean; stubborn?: string; duplicate?: string; decoy?: boolean; secondPanel?: boolean; initial?: string | null }) {
  const imgs: FakeNode[] = [];
  const root = new FakeNode("div");
  const makeButton = (container: FakeNode, image: string) => {
    const button = container.append(new FakeNode("button"));
    const img = button.append(new FakeNode("img"));
    img.attrs.set("src", `./img/${image}.png`);
    button.attrs.set("data-state", "idle");
    imgs.push(img);
    return button;
  };
  const buttons = new Map<string, FakeNode>();
  const panelOf = (container: FakeNode, tracked: boolean) => {
    const grid = container.append(new FakeNode("div"));
    const group = [] as FakeNode[];
    for (const image of imageNames) {
      const button = makeButton(grid, image);
      group.push(button);
      if (tracked) buttons.set(image, button);
      button.onClick = () => {
        if (image === options.stubborn) return;
        for (const other of group) other.attrs.set("data-state", "idle");
        button.attrs.set("data-state", "active");
      };
    }
    return group;
  };
  if (options.panel !== false) {
    const group = panelOf(root.append(new FakeNode("section")), true);
    const initial = options.initial === undefined ? "ceramic_dark" : options.initial;
    if (initial) group[imageNames.indexOf(initial)]!.attrs.set("data-state", "active");
    if (options.duplicate) makeButton(buttons.get(imageNames[0]!)!.parentElement!, options.duplicate);
  }
  if (options.secondPanel) panelOf(root.append(new FakeNode("section")), false);
  const decoys: FakeNode[] = [];
  if (options.decoy) decoys.push(makeButton(root.append(new FakeNode("aside")), "gradient"));
  const document = { querySelectorAll: () => imgs };
  return { document, buttons, decoys };
}
async function withDom<T>(dom: { document: unknown }, run: () => Promise<T>): Promise<T> {
  const globals = globalThis as Record<string, unknown>;
  const saved = { document: globals.document, setTimeout: globals.setTimeout };
  globals.document = dom.document;
  globals.setTimeout = (callback: () => void) => { callback(); return 0; };
  try { return await run(); } finally { globals.document = saved.document; globals.setTimeout = saved.setTimeout; }
}
const shaderRun = (states: RuntimeState[], rendered?: { count: number }) =>
  harness(states, { editor: () => ({ executor: { isBusy: false }, viewports: new Set([{ setNeedsRender() { if (rendered) rendered.count += 1; } }]) }) });
const same = () => baseState();

test("shader mode script finds the panel, clicks once, reads the active mode back and reports it", async () => {
  const dom = buildDom({ decoy: true });
  const rendered = { count: 0 };
  const result = await withDom(dom, () => shaderRun([same(), same()], rendered).operations.shaderMode("zebra_horizontal"));
  assert.deepEqual([result.previous, result.current, result.requested, result.changed], ["ceramic_dark", "zebra_horizontal", "zebra_horizontal", true]);
  assert.equal(result.panelButtons, 14);
  assert.equal(result.available.length, 14);
  assert.equal(dom.buttons.get("reflection_check_horizontal")!.clicks, 1);
  assert.equal(dom.decoys[0]!.clicks, 0);
  assert.equal(rendered.count, 1);

  const read = await withDom(buildDom({}), () => shaderRun([same(), same()]).operations.shaderMode(undefined));
  assert.deepEqual([read.current, read.requested, read.changed], ["ceramic_dark", null, false]);

  const already = buildDom({});
  await withDom(already, () => shaderRun([same(), same()]).operations.shaderMode("ceramic_dark"));
  assert.equal(already.buttons.get("ceramic_dark")!.clicks, 0);
});

test("shader mode script refuses when the panel is not mounted even if a decoy thumbnail exists elsewhere", async () => {
  const noDom = buildDom({ panel: false });
  await assert.rejects(withDom(noDom, () => shaderRun([same(), same()]).operations.shaderMode("isophotes")), /panel is not mounted/u);
  const decoyOnly = buildDom({ panel: false, decoy: true });
  await assert.rejects(withDom(decoyOnly, () => shaderRun([same(), same()]).operations.shaderMode("gradient")), /panel is not mounted/u);
  assert.equal(decoyOnly.decoys[0]!.clicks, 0);
});

test("shader mode script refuses duplicates and ambiguous panels without clicking", async () => {
  const duplicate = buildDom({ duplicate: "isophotes" });
  await assert.rejects(withDom(duplicate, () => shaderRun([same(), same()]).operations.shaderMode("isophotes")), /matches more than one button/u);
  assert.equal(duplicate.buttons.get("isophotes")!.clicks, 0);
  const twoPanels = buildDom({ secondPanel: true });
  await assert.rejects(withDom(twoPanels, () => shaderRun([same(), same()]).operations.shaderMode("isophotes")), /More than one container/u);
  assert.equal(twoPanels.buttons.get("isophotes")!.clicks, 0);
});

test("shader mode script sends exactly one click and fails with the read-back mode when the click has no effect", async () => {
  const dom = buildDom({ stubborn: "isophotes" });
  await assert.rejects(withDom(dom, () => shaderRun([same(), same()]).operations.shaderMode("isophotes")), /did not activate shader mode isophotes after one click \(active mode read back: ceramic_dark\); no second click was sent/u);
  assert.equal(dom.buttons.get("isophotes")!.clicks, 1);
});

test("shader mode fails loudly when the document revision changed, including after a script failure", async () => {
  const changed = baseState({ revision: "r2", undoDepth: 1 });
  await assert.rejects(withDom(buildDom({}), () => shaderRun([same(), changed]).operations.shaderMode("isophotes")), /changed the document revision \(r1 -> r2\)/u);
  const stubborn = buildDom({ stubborn: "isophotes" });
  await assert.rejects(withDom(stubborn, () => shaderRun([same(), changed]).operations.shaderMode("isophotes")), /did not activate.*ALSO the document revision changed \(r1 -> r2\)/u);
  await assert.rejects(shaderRun([same()]).operations.shaderMode("sparkle" as "isophotes"), /Unknown shader mode/u);
});

test("shader mode refuses while Plasticity is busy", async () => {
  const run = harness([same(), same()], { editor: () => ({ executor: { isBusy: true } }) });
  await assert.rejects(withDom(buildDom({}), () => run.operations.shaderMode("isophotes")), /busy/u);
});

// ---------------------------------------------------------------- licence guard

test("Studio tools refuse with a clear licence error before touching the factory when the licence is not Studio", async () => {
  const obj = baseState({ referenceMeshes: [mesh(5, "obj")] });
  const root = await mkdtemp(join(tmpdir(), "polysplines-licence-"));
  try {
    const file = join(root, "cage.obj");
    await writeFile(file, "v 0 0 0\n");
    const created: any[] = [];
    // isStudioLicense false, non-boolean or throwing refuses all three tools (fails closed).
    for (const isStudioLicense of [() => false, () => undefined, () => { throw new Error("binding broke"); }]) {
      const licence = { isStudioLicense, hasXNurbs: () => true };
      const convert = harness([obj, obj], { bindings: { ...licence, ConvertMeshToPolySplinesFactory: polySplinesFactory(created, "ok"), PolySplinesCommand: FakeCommand }, editor: polySplinesEditor([5]) });
      await assert.rejects(convert.operations.polySplinesFromReferenceMeshes([5], {}, "r1"), /Plasticity Studio licence not active|binding broke/u);
      const imported = harness([baseState(), baseState()], { bindings: { ...licence, ImportPolySplinesFactory: importFactory(created, "ok"), ImportPolySplinesCommand: FakeCommand }, editor: () => ({ executor: { isBusy: false }, ...execOnly }) });
      await assert.rejects(imported.operations.importPolySplines(file, "millimeter", {}, "r1"), /Plasticity Studio licence not active|binding broke/u);
      const xsided = harness([xsidedBefore(), xsidedBefore()], { bindings: { ...licence, XSidedFactory: xsidedFactory(created, "ok"), XNurbsCommand: FakeCommand, ContinuityType: CONTINUITY }, editor: sheetEditor(4) });
      await assert.rejects(xsided.operations.createXSidedSurface(loop(4), {}, "r1"), /Plasticity Studio licence not active|binding broke/u);
    }
    // hasXNurbs false refuses only X-sided; PolySplines needs isStudioLicense alone.
    const licence = { isStudioLicense: () => true, hasXNurbs: () => false };
    const xsided = harness([xsidedBefore(), xsidedBefore()], { bindings: { ...licence, XSidedFactory: xsidedFactory(created, "ok"), XNurbsCommand: FakeCommand, ContinuityType: CONTINUITY }, editor: sheetEditor(4) });
    await assert.rejects(xsided.operations.createXSidedSurface(loop(4), {}, "r1"), /\(hasXNurbs false\)/u);
    const after = baseState({ revision: "r2", referenceMeshes: [mesh(5, "obj")], bodies: [sheet(9, 4)] });
    const convert = harness([obj, after], { bindings: { ...licence, ConvertMeshToPolySplinesFactory: polySplinesFactory(created, "ok"), PolySplinesCommand: FakeCommand }, editor: polySplinesEditor([5]) });
    await convert.operations.polySplinesFromReferenceMeshes([5], {}, "r1");
    assert.equal(created.length, 1, "only the allowed PolySplines convert built a factory");
  } finally { await rm(root, { recursive: true, force: true }); }
});
