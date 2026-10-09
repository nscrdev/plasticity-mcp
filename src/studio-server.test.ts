import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer, type SessionLike } from "./server.ts";
import type { PlasticityOperations } from "./plasticity/operations.ts";
import type { RuntimeState } from "./plasticity/runtime.ts";

const construction: RuntimeState["construction"] = { planes: [], activePlaneId: "standard:top", planeStateToken: "p", viewStateToken: "v" };
const newSheet = {
  id: 9, versionId: 109, type: "Sheet", name: "patch", boundsMm: { min: [0, 0, 0] as [number, number, number], max: [40, 20, 10] as [number, number, number] },
  faceIds: ["f1", "f2"], edgeIds: ["e1"], faces: [], edges: [], vertices: [],
};
const summary = (count: number) => ({ count, closedSolids: 0, sheets: count, totalFaces: 2 * count, bodies: count ? [{ id: 9, type: "Sheet", name: "patch", closure: "sheet", closed: false, faceCount: 2, edgeCount: 1, boundsMm: newSheet.boundsMm, sizeMm: [40, 20, 10] }] : [] });
const polyStudio = (partial = false) => ({ readBack: { mergePatches: false }, polySplines: summary(1), outcome: { partial, inputMeshes: 1, outputBodies: 1, sourceMeshesRemaining: [], details: partial ? "PARTIAL" : null } });
const stateWith = (bodies: RuntimeState["bodies"], revision: string): RuntimeState => ({
  targetId: "w", title: "t", documentToken: "d", revision, dbVersion: 1, undoDepth: 0, redoDepth: 0, regions: [], construction, bodies,
});

async function withTools(operations: Record<string, unknown>, run: (client: Client) => Promise<void>) {
  const fake = {
    async windows() { return []; }, async connect() { return {}; }, get() { return operations as unknown as PlasticityOperations; },
    capabilities() { return { bindings: [], operations: {} as never }; },
    async captureSnapshot() { return {}; }, async changesSince() { return {}; }, async waitForChange() { return {}; },
  } satisfies SessionLike;
  const server = createServer(fake, undefined, undefined, undefined, null);
  const client = new Client({ name: "studio-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try { await run(client); } finally { await client.close(); await server.close(); }
}

const parse = (response: unknown) => {
  const content = (response as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
};

test("PolySplines tools forward only the given options and report new bodies", async () => {
  const received: Record<string, unknown[]> = {};
  let calls = 0;
  const operations = {
    async state() { calls += 1; return calls % 2 === 1 ? stateWith([], "r1") : stateWith([newSheet], "r2"); },
    async polySplinesFromReferenceMeshes(...args: unknown[]) { received.convert = args; return { ...stateWith([newSheet], "r2"), studio: polyStudio() }; },
    async importPolySplines(...args: unknown[]) { received.import = args; return { ...stateWith([newSheet], "r2"), studio: polyStudio() }; },
  };
  await withTools(operations, async (client) => {
    const converted = await client.callTool({ name: "plasticity_polysplines_from_reference_mesh", arguments: { referenceMeshIds: [4, 5], mergePatches: false, revision: "r1" } });
    assert.equal(converted.isError, undefined, JSON.stringify(converted));
    assert.deepEqual(received.convert, [[4, 5], { mergePatches: false }, "r1"]);
    const body = parse(converted);
    assert.equal(body.experimental, true);
    assert.equal(body.partial, false);
    assert.deepEqual(body.appliedOptions, { mergePatches: false });
    const summary = body.polySplines as { count: number; sheets: number; bodies: Array<{ id: number; faceCount: number; closure: string; sizeMm: number[] }> };
    assert.equal(summary.count, 1);
    assert.equal(summary.sheets, 1);
    assert.deepEqual([summary.bodies[0]?.id, summary.bodies[0]?.faceCount, summary.bodies[0]?.closure, summary.bodies[0]?.sizeMm], [9, 2, "sheet", [40, 20, 10]]);

    await client.callTool({ name: "plasticity_polysplines_from_reference_mesh", arguments: { referenceMeshIds: [4], revision: "r1" } });
    assert.deepEqual(received.convert, [[4], {}, "r1"]);

    const imported = await client.callTool({ name: "plasticity_import_polysplines", arguments: { path: "/tmp/cage.obj", sourceUnit: "millimeter", roundedCorners: true, interpolateBoundary: true, revision: "r1" } });
    assert.equal(imported.isError, undefined, JSON.stringify(imported));
    assert.deepEqual(received.import, ["/tmp/cage.obj", "millimeter", { roundedCorners: true, interpolateBoundary: true }, "r1"]);

    const before = JSON.stringify(received);
    for (const bad of [
      { name: "plasticity_polysplines_from_reference_mesh", arguments: { referenceMeshIds: [], revision: "r1" } },
      { name: "plasticity_polysplines_from_reference_mesh", arguments: { referenceMeshIds: [4], mergePatches: "yes", revision: "r1" } },
      { name: "plasticity_polysplines_from_reference_mesh", arguments: { referenceMeshIds: [4], extra: 1, revision: "r1" } },
      { name: "plasticity_polysplines_from_reference_mesh", arguments: { referenceMeshIds: [4] } },
      { name: "plasticity_import_polysplines", arguments: { path: "/tmp/cage.obj", revision: "r1" } },
      { name: "plasticity_import_polysplines", arguments: { path: "/tmp/cage.obj", sourceUnit: "parsec", revision: "r1" } },
      { name: "plasticity_import_polysplines", arguments: { path: "", sourceUnit: "meter", revision: "r1" } },
    ]) {
      const rejected = await client.callTool(bad);
      assert.equal(rejected.isError, true, JSON.stringify(bad));
    }
    assert.equal(JSON.stringify(received), before);
  });
});

test("PolySplines tool surfaces the native guard error", async () => {
  const operations = {
    async state() { return stateWith([], "r1"); },
    async polySplinesFromReferenceMeshes() { throw new Error("ConvertMeshToPolySplinesFactory has no roundedCorners field in this Plasticity build; refusing to guess"); },
  };
  await withTools(operations, async (client) => {
    const response = await client.callTool({ name: "plasticity_polysplines_from_reference_mesh", arguments: { referenceMeshIds: [4], roundedCorners: true, revision: "r1" } });
    assert.equal(response.isError, true);
    assert.match(JSON.stringify(response), /refusing to guess/u);
  });
});

test("X-sided surface tool validates edges and ranges and forwards options", async () => {
  let received: unknown[] | undefined;
  let calls = 0;
  const operations = {
    async state() { calls += 1; return calls % 2 === 1 ? stateWith([], "r1") : stateWith([newSheet], "r2"); },
    async createXSidedSurface(...args: unknown[]) { received = args; return { ...stateWith([newSheet], "r2"), studio: { readBack: {}, loopCheck: { checked: true, loops: 1, toleranceMm: 0.01 }, outcome: { kind: "created", newBodies: summary(1), extendedBodies: [], revisionChanged: true }, surface: summary(1) } }; },
  };
  const edges = [1, 2, 3, 4].map((n) => ({ bodyId: 1, edgeId: `e${n}` }));
  await withTools(operations, async (client) => {
    const ok = await client.callTool({ name: "plasticity_create_xsided_surface", arguments: {
      edges: [{ ...edges[0], continuity: "G2" }, ...edges.slice(1)], continuity: "G1", uDegree: 5, vDegree: 5, uSpans: 4, vSpans: 4, quadSided: true, toleranceMm: 0.02, revision: "r1",
    } });
    assert.equal(ok.isError, undefined, JSON.stringify(ok));
    assert.deepEqual(received, [[{ ...edges[0], continuity: "G2" }, ...edges.slice(1)], { continuity: "G1", uDegree: 5, vDegree: 5, uSpans: 4, vSpans: 4, quadSided: true, toleranceMm: 0.02 }, "r1"]);
    assert.equal((parse(ok).surface as { count: number }).count, 1);

    await client.callTool({ name: "plasticity_create_xsided_surface", arguments: { edges: edges.slice(0, 3), revision: "r1" } });
    assert.deepEqual(received, [edges.slice(0, 3), {}, "r1"]);

    const snapshot = JSON.stringify(received);
    for (const bad of [
      { edges: edges.slice(0, 2) },
      { edges: [] },
      { edges },
      { edges, continuity: "G4" },
      { edges: [{ ...edges[0], continuity: "C1" }, ...edges.slice(1)] },
      { edges, uDegree: 1 }, { edges, uDegree: 12 }, { edges, vDegree: 2.5 },
      { edges, uSpans: 0 }, { edges, vSpans: 65 },
      { edges, toleranceMm: 0 }, { edges, toleranceMm: 11 },
      { edges, quadSided: "yes" },
      { edges: [{ bodyId: 0, edgeId: "e1" }, ...edges.slice(1)] },
      { edges: [{ bodyId: 1, edgeId: "" }, ...edges.slice(1)] },
      { edges, tension: 1 },
    ]) {
      const rejected = await client.callTool({ name: "plasticity_create_xsided_surface", arguments: { revision: "r1", ...bad } });
      if (JSON.stringify(bad) === JSON.stringify({ edges })) { assert.equal(rejected.isError, undefined); continue; }
      assert.equal(rejected.isError, true, JSON.stringify(bad));
    }
    assert.notEqual(JSON.stringify(received), snapshot, "the valid control case above should have been forwarded");
  });
});

test("shader mode tool lists modes, forwards the selection and needs no revision", async () => {
  const seen: unknown[] = [];
  const operations = {
    async shaderMode(mode: unknown) { seen.push(mode); return { previous: "ceramic_dark", current: mode ?? "ceramic_dark", changed: mode !== undefined, available: ["ceramic_dark"], revisionBefore: "r1", revisionAfter: "r1" }; },
  };
  await withTools(operations, async (client) => {
    const tools = await client.listTools();
    const tool = tools.tools.find((entry) => entry.name === "plasticity_set_shader_mode");
    assert.ok(tool);
    assert.match(tool.description ?? "", /EXPERIMENTAL/u);
    assert.equal(tool.annotations?.destructiveHint, false);
    const modes = (tool.inputSchema.properties as { mode: { enum: string[] } }).mode.enum;
    assert.deepEqual(modes, ["ceramic_dark", "metal_carpaint", "dark_shiny", "gradient", "ceramic_lightbulb", "color_matcap", "black_silhouette", "color_silhouette", "isophotes", "draft", "zebra_horizontal", "zebra_vertical", "topo", "face_direction"]);
    assert.equal(tool.inputSchema.required, undefined);

    const read = await client.callTool({ name: "plasticity_set_shader_mode", arguments: {} });
    assert.equal(read.isError, undefined);
    const set = await client.callTool({ name: "plasticity_set_shader_mode", arguments: { mode: "zebra_vertical" } });
    assert.equal(parse(set).current, "zebra_vertical");
    assert.deepEqual(seen, [undefined, "zebra_vertical"]);
    for (const bad of [{ mode: "curvature" }, { mode: "zebra" }, { mode: "isophotes", revision: "r1" }]) {
      const rejected = await client.callTool({ name: "plasticity_set_shader_mode", arguments: bad });
      assert.equal(rejected.isError, true, JSON.stringify(bad));
    }
    assert.equal(seen.length, 2);
  });
});
