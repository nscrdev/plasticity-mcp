import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { PlasticityOperations } from "./operations.ts";
import type { PlasticityRuntime, RuntimeState } from "./runtime.ts";
import {
  createFakeEditor,
  createFakeFactory,
  newFactoryRecord,
  runInjectedScript,
  type FakeEdge,
} from "./script-harness.ts";

const construction: RuntimeState["construction"] = { planes: [], activePlaneId: "standard:top", planeStateToken: "planes:empty", viewStateToken: "workplane:standard:top" };
const OBJ = "o Q\nv 0 0 0\nv 1 0 0\nv 1 1 0\nf 1 2 3\n";

function stateWith(bodies: Array<Record<string, unknown>>): RuntimeState {
  return { targetId: "w", title: "t", documentToken: "d", revision: "r", dbVersion: 1, undoDepth: 0, redoDepth: 0, construction, regions: [], bodies } as unknown as RuntimeState;
}
const plainBody = (id: number, name: string | null) => ({ id, versionId: id + 10, type: "Solid", name, boundsMm: null, faceIds: [], edgeIds: [], faces: [], edges: [], vertices: [] });

/** A runtime whose mutate() executes the injected script against a fake editor (the same call shape as PlasticityRuntime.call). */
function harnessRuntime(options: { state: () => RuntimeState; editor: () => object; bindings: Record<string, unknown>; onMutate?: () => void }): PlasticityRuntime {
  return {
    async getState() { return options.state(); },
    async mutate(source: string, bindingNames: string[], values: unknown[]) {
      options.onMutate?.();
      return await runInjectedScript(source, bindingNames, values, options.bindings, options.editor());
    },
    isUncertain() { return false; },
  } as unknown as PlasticityRuntime;
}

async function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "plasticity-script-"));
  try { return await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- OBJ export script

function objRuntime(bodies: Array<Record<string, unknown>>, extra?: (path: string, factory: Record<string, unknown>) => Promise<void>) {
  const record = newFactoryRecord();
  const Factory = createFakeFactory({
    record,
    onCommit: async (factory) => {
      const path = factory.filePath as string;
      await writeFile(path, OBJ);
      await extra?.(path, factory);
    },
  });
  const state = stateWith(bodies);
  const runtime = harnessRuntime({ state: () => state, editor: () => createFakeEditor({ bodyId: 7, edges: [] }), bindings: { OBJExportFactory: Factory } });
  // findView reads this.geo.geometryModel: register every body.
  const editor = () => {
    const base = createFakeEditor({ bodyId: 7, edges: [] }) as { geo: { geometryModel: Map<number, unknown> }; db: { lookupStableId: (id: number) => number } };
    for (const body of bodies) base.geo.geometryModel.set(body.versionId as number, { view: { id: body.id } });
    base.db.lookupStableId = (versionId: number) => (bodies.find((body) => body.versionId === versionId)?.id as number | undefined) ?? -1;
    return base;
  };
  return { record, operations: new PlasticityOperations(harnessRuntime({ state: () => state, editor, bindings: { OBJExportFactory: Factory } })), runtime };
}

test("default OBJ export script writes exactly the same factory fields, values and order as main", async () => {
  await withRoot(async (root) => {
    const { record, operations } = objRuntime([plainBody(7, "Box")]);
    await operations.exportObj([7], join(root, "default.obj"), "r", 0.05, 15);
    assert.deepEqual(record.writes.map(([key]) => key), [
      "shells", "filePath", "unit", "scale", "upAxis", "showWireframe", "simplify",
      "curveChordTolerance", "surfacePlaneTolerance", "curveChordAngleDegrees", "surfacePlaneAngleDegrees",
    ]);
    const byKey = Object.fromEntries(record.writes);
    assert.equal(byKey.unit, "millimeter");
    assert.equal(byKey.scale, 1);
    assert.equal(byKey.upAxis, "z");
    assert.equal(byKey.showWireframe, false);
    assert.equal(byKey.simplify, false);
    assert.equal(byKey.curveChordTolerance, 0.00005);
    assert.equal(byKey.surfacePlaneTolerance, 0.00005);
    assert.equal(byKey.curveChordAngleDegrees, 15);
    assert.equal(byKey.surfacePlaneAngleDegrees, 15);
    assert.equal(record.committed, 1);
  });
});

test("OBJ option and lock flag writes land on the intended factory fields", async () => {
  await withRoot(async (root) => {
    const { record, operations } = objRuntime([plainBody(7, "Box")]);
    await operations.exportObj([7], join(root, "opts.obj"), "r", 0.05, 15, {
      lockPlaneTolerance: true, lockAngleTolerance: true, curveChordToleranceMm: 0.2, surfacePlaneToleranceMm: 0.2,
      curveChordAngleDegrees: 5, surfacePlaneAngleDegrees: 5, planeAngleDegrees: 3, maxSides: 4, convex: true, density: 0.5, maxWidthMm: 2, curveChordMaxMm: 0,
    });
    const byKey = Object.fromEntries(record.writes);
    assert.equal(byKey.lockPlaneTolerance, true);
    assert.equal(byKey.lockAngleTolerance, true);
    assert.equal(byKey.curveChordTolerance, 0.0002);
    assert.equal(byKey.surfacePlaneAngleDegrees, 5);
    assert.equal(byKey.planeAngleDegrees, 3);
    assert.equal(byKey.maxSides, 4);
    assert.equal(byKey.maxWidth, 0.002);
    assert.equal(byKey.curveChordMax, 0);
  });
});

test("a native throw during OBJ export publishes nothing and cleans the staging folder", async () => {
  await withRoot(async (root) => {
    const record = newFactoryRecord();
    const Factory = createFakeFactory({ record, onCommit: () => { throw new Error("native exporter exploded"); } });
    const bodies = [plainBody(7, "Box")];
    const editor = () => createFakeEditor({ bodyId: 7, edges: [] });
    const operations = new PlasticityOperations(harnessRuntime({
      state: () => stateWith(bodies),
      editor: () => {
        const base = editor() as { geo: { geometryModel: Map<number, unknown> }; db: { lookupStableId: () => number } };
        base.geo.geometryModel.set(17, { view: {} });
        base.db.lookupStableId = () => 7;
        return base;
      },
      bindings: { OBJExportFactory: Factory },
    }));
    await assert.rejects(operations.exportObj([7], join(root, "x.obj"), "r", 0.05, 15), /exploded/u);
    assert.deepEqual(await readdir(root), []);
  });
});

test("OBJ export fails when the native binding is missing", async () => {
  await withRoot(async (root) => {
    const operations = new PlasticityOperations(harnessRuntime({ state: () => stateWith([plainBody(7, "Box")]), editor: () => createFakeEditor({ bodyId: 7, edges: [] }), bindings: {} }));
    await assert.rejects(operations.exportObj([7], join(root, "x.obj"), "r", 0.05, 15), /binding is unavailable: OBJExportFactory/u);
    assert.deepEqual(await readdir(root), []);
  });
});

// ---------------------------------------------------------------- chamfer scripts

const line = (id: string, entityId: number): FakeEdge => ({ id, entityId, at: (t) => new NativePoint(0.02 * t, 0, 0) });
class NativePoint {
  x: number; y: number; z: number;
  constructor(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; }
}

function chamferHarness(mutateBindings: Record<string, unknown>) {
  const record = newFactoryRecord();
  const Factory = createFakeFactory({ record });
  const body = { ...plainBody(7, null), faceIds: ["f1"], faces: [{ id: "f1", blendRadiusMm: null }] };
  const state = stateWith([body]);
  const operations = new PlasticityOperations(harnessRuntime({
    state: () => state,
    editor: () => createFakeEditor({ bodyId: 7, edges: [line("e1", 51)] }),
    bindings: { FilletShellFactory: Factory, ...mutateBindings },
  }));
  return { record, operations };
}

test("plain chamfer script sets shell, edges and a negative distance only", async () => {
  const { record, operations } = chamferHarness({});
  await operations.chamfer(7, ["e1"], 2, "r");
  assert.deepEqual(record.writes.map(([key]) => key), ["shell", "edges", "distance"]);
  assert.equal(Object.fromEntries(record.writes).distance, -0.002);
  assert.equal(record.committed, 1);
});

test("experimental chamfer script writes distance1 and distance2 and the mode", async () => {
  const { record, operations } = chamferHarness({ ChamferMode: { Offset: "OFFSET", Apex: "APEX" } });
  await operations.chamfer(7, ["e1"], 2, "r", { distance2Mm: 5, experimental: true });
  assert.deepEqual(record.writes.map(([key]) => key), ["shell", "edges", "distance", "lockDistances", "distance1", "distance2"]);
  const byKey = Object.fromEntries(record.writes);
  assert.deepEqual([byKey.lockDistances, byKey.distance1, byKey.distance2], [false, -0.002, -0.005]);
  record.writes.length = 0;
  await operations.chamfer(7, ["e1"], 2, "r", { mode: "apex", experimental: true });
  assert.equal(Object.fromEntries(record.writes).chamferMode, "APEX");
  record.writes.length = 0;
  await operations.chamfer(7, ["e1"], 2, "r", { mode: "offset", experimental: true });
  assert.equal(Object.fromEntries(record.writes).chamferMode, "OFFSET");
});

test("chamfer script failure paths: unknown edge and missing ChamferMode binding", async () => {
  const { operations } = chamferHarness({});
  await assert.rejects(operations.chamfer(7, ["nope"], 2, "r"), /Stale or unknown edge: nope/u);
  await assert.rejects(operations.chamfer(7, ["e1"], 2, "r", { mode: "apex", experimental: true }), /binding is unavailable: ChamferMode/u);
});

// ---------------------------------------------------------------- variable fillet script

function filletHarness(options: { members?: Record<string, (...args: any[]) => unknown>; busy?: boolean; faceGain?: boolean } = {}) {
  const record = newFactoryRecord();
  const Factory = createFakeFactory({
    record,
    members: options.members ?? { addVariationPoint(_point: unknown, _radius: unknown) { return undefined; } },
  });
  const before = { ...plainBody(7, null), faceIds: ["f1"], faces: [{ id: "f1", blendRadiusMm: null }] };
  const after = { ...before, faceIds: ["f1", "f2"], faces: [{ id: "f1", blendRadiusMm: null }, { id: "f2", blendRadiusMm: 2 }] };
  let committed = false;
  const operations = new PlasticityOperations(harnessRuntime({
    state: () => stateWith([committed && options.faceGain !== false ? after : before]),
    editor: () => createFakeEditor({ bodyId: 7, edges: [line("e1", 51)], busy: options.busy === true }),
    bindings: { FilletShellFactory: Factory },
    onMutate: () => { committed = true; },
  }));
  return { record, operations };
}

test("variable fillet script passes the same native point type for t and pointMm and reports resolved points", async () => {
  const { record, operations } = filletHarness();
  const result = await operations.filletVariable(7, ["e1"], 1, [
    { edgeId: "e1", t: 0.25, radiusMm: 2 },
    { edgeId: "e1", pointMm: [10, 0, 0], radiusMm: 3 },
  ], "r", { experimental: true });
  const calls = record.calls.filter(([name]) => name === "addVariationPoint");
  assert.equal(calls.length, 2);
  for (const [, args] of calls) assert.ok(args[0] instanceof NativePoint, "both paths pass the native position object");
  assert.deepEqual(calls.map(([, args]) => args[1]), [0.002, 0.003]);
  assert.equal((calls[1]![1][0] as NativePoint).x.toFixed(6), "0.010000");
  const resolved = result.experimental!.resolvedPoints;
  assert.equal(resolved[0]!.t, 0.25);
  assert.ok(Math.abs(resolved[1]!.t - 0.5) < 1e-6);
  assert.ok(Math.abs(resolved[1]!.pointMm[0] - 10) < 1e-4);
  assert.ok(resolved[1]!.distanceMm < 1e-6);
  assert.deepEqual(result.experimental!.newBlendFaceIds, ["f2"]);
});

test("variable fillet refuses a pointMm that is off its edge before building any factory", async () => {
  const { record, operations } = filletHarness();
  await assert.rejects(operations.filletVariable(7, ["e1"], 1, [{ edgeId: "e1", pointMm: [10, 5, 0], radiusMm: 3 }], "r", { experimental: true }), /5\.000 mm from edge e1/u);
  assert.equal(record.constructed, 0);
  // 0.04 mm off is inside the tolerance, 0.06 mm is outside.
  await filletHarness().operations.filletVariable(7, ["e1"], 1, [{ edgeId: "e1", pointMm: [10, 0.04, 0], radiusMm: 3 }], "r", { experimental: true });
  await assert.rejects(filletHarness().operations.filletVariable(7, ["e1"], 1, [{ edgeId: "e1", pointMm: [10, 0.06, 0], radiusMm: 3 }], "r", { experimental: true }), /mm from edge/u);
});

test("variable fillet script failure paths: native throw, missing member, arity mismatch, busy editor, silent no-op", async () => {
  const thrower = filletHarness({ members: { addVariationPoint(_point: unknown, _radius: unknown) { throw new Error("native rejected the variation point"); } } });
  await assert.rejects(thrower.operations.filletVariable(7, ["e1"], 1, [{ edgeId: "e1", t: 0.5, radiusMm: 2 }], "r", { experimental: true }), /native rejected the variation point/u);

  const missing = filletHarness({ members: {} });
  await assert.rejects(missing.operations.filletVariable(7, ["e1"], 1, [{ edgeId: "e1", t: 0.5, radiusMm: 2 }], "r", { experimental: true }), /two-argument signature/u);
  assert.equal(missing.record.constructed, 0, "arity is checked before a command or factory is built");

  const wide = filletHarness({ members: { addVariationPoint(_a: unknown, _b: unknown, _c: unknown) { return undefined; } } });
  await assert.rejects(wide.operations.filletVariable(7, ["e1"], 1, [{ edgeId: "e1", t: 0.5, radiusMm: 2 }], "r", { experimental: true }), /two-argument signature/u);
  assert.equal(wide.record.constructed, 0);

  const busy = filletHarness({ busy: true });
  await assert.rejects(busy.operations.filletVariable(7, ["e1"], 1, [{ edgeId: "e1", t: 0.5, radiusMm: 2 }], "r", { experimental: true }), /busy/u);

  const noop = filletHarness({ faceGain: false });
  await assert.rejects(noop.operations.filletVariable(7, ["e1"], 1, [{ edgeId: "e1", t: 0.5, radiusMm: 2 }], "r", { experimental: true }), /topology did not change/u);

  const unknownEdge = filletHarness();
  await assert.rejects(unknownEdge.operations.filletVariable(7, ["nope"], 1, [{ edgeId: "nope", t: 0.5, radiusMm: 2 }], "r", { experimental: true }), /Stale or unknown edge: nope/u);
});

// ---------------------------------------------------------------- file-system atomicity and naming

function fsRuntime(bodies: Array<Record<string, unknown>>, writeExtras: (path: string, ids: number[]) => Promise<void>): PlasticityRuntime {
  return {
    async getState() { return stateWith(bodies); },
    async mutate(_src: string, _bindings: string[], args: unknown[]) {
      const { path, ids } = args[0] as { path: string; ids: number[] };
      await writeFile(path, OBJ);
      await writeExtras(path, ids);
      return {};
    },
    isUncertain() { return false; },
  } as unknown as PlasticityRuntime;
}
const mtlNextTo = (path: string) => writeFile(path.replace(/\.obj$/u, ".mtl"), "newmtl m1\nKd 1 0 0\n");

test("perBody export with a pre-existing sibling MTL fails without leaving partial output (reviewer probe)", async () => {
  await withRoot(async (root) => {
    const directory = join(root, "parts");
    await mkdir(directory);
    await writeFile(join(directory, "B_8.mtl"), "user file\n");
    const operations = new PlasticityOperations(fsRuntime([plainBody(7, "A"), plainBody(8, "B")], async (path) => { await mtlNextTo(path); }));
    await assert.rejects(operations.exportObj([7, 8], directory, "r", 0.05, 15, {}, { perBody: true }), /overwrite/u);
    assert.deepEqual(await readdir(directory), ["B_8.mtl"]);
    assert.equal(await readFile(join(directory, "B_8.mtl"), "utf8"), "user file\n");
  });
});

test("perBody export removes what it published when a later write fails", async () => {
  await withRoot(async (root) => {
    const directory = join(root, "parts");
    const operations = new PlasticityOperations(fsRuntime([plainBody(7, "A"), plainBody(8, "B")], async (path, ids) => {
      await mtlNextTo(path);
      // Body 8 also yields a directory sibling: refused during staging, so nothing from body 7 may be published.
      if (ids[0] === 8) await mkdir(path.replace(/\.obj$/u, ".png"));
    }));
    await assert.rejects(operations.exportObj([7, 8], directory, "r", 0.05, 15, {}, { perBody: true }), /not a regular file/u);
    assert.deepEqual(await readdir(directory), []);
  });
});

test("single-file export refuses a pre-existing sibling MTL and writes nothing", async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, "part.mtl"), "user file\n");
    const operations = new PlasticityOperations(fsRuntime([plainBody(7, "A")], async (path) => { await mtlNextTo(path); }));
    await assert.rejects(operations.exportObj([7], join(root, "part.obj"), "r", 0.05, 15), /overwrite/u);
    assert.deepEqual((await readdir(root)).sort(), ["part.mtl"]);
  });
});

test("single-file export with a non-file sibling publishes nothing (reviewer probe)", async () => {
  await withRoot(async (root) => {
    const operations = new PlasticityOperations(fsRuntime([plainBody(7, "A")], async (path) => {
      await mtlNextTo(path);
      await mkdir(join(path, "..", "textures"));
    }));
    await assert.rejects(operations.exportObj([7], join(root, "part.obj"), "r", 0.05, 15), /not a regular file/u);
    assert.deepEqual(await readdir(root), []);
  });
});

test("an output name with spaces gets a whitespace-free sibling MTL and a valid mtllib line", async () => {
  await withRoot(async (root) => {
    const operations = new PlasticityOperations(fsRuntime([plainBody(7, "A")], async (path) => {
      await writeFile(path, `mtllib geometry.mtl\n${OBJ}`);
      await mtlNextTo(path);
    }));
    const result = await operations.exportObj([7], join(root, "my part.obj"), "r", 0.05, 15);
    assert.match(await readFile(join(root, "my part.obj"), "utf8"), /^mtllib my_part\.mtl\n/u);
    assert.deepEqual((await readdir(root)).sort(), ["my part.obj", "my_part.mtl"]);
    assert.deepEqual(result.mtl, { written: true, paths: [join(root, "my_part.mtl")], mtllib: ["my_part.mtl"] });
  });
});

test("copied MTL keeps texture references valid when the staging name is renamed", async () => {
  await withRoot(async (root) => {
    const operations = new PlasticityOperations(fsRuntime([plainBody(7, "A")], async (path) => {
      await writeFile(path, `mtllib geometry.mtl\n${OBJ}`);
      await writeFile(path.replace(/\.obj$/u, ".mtl"), "newmtl m1\nmap_Kd geometry.png\nmap_Ks elsewhere.png\n");
      await writeFile(path.replace(/\.obj$/u, ".png"), "png");
    }));
    await operations.exportObj([7], join(root, "stick.obj"), "r", 0.05, 15);
    assert.equal(await readFile(join(root, "stick.mtl"), "utf8"), "newmtl m1\nmap_Kd stick.png\nmap_Ks elsewhere.png\n");
    assert.deepEqual((await readdir(root)).sort(), ["stick.mtl", "stick.obj", "stick.png"]);
  });
});
