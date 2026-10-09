import assert from "node:assert/strict";
import { test } from "node:test";

import { validateObj } from "./obj.ts";

test("validates a millimeter OBJ mesh and reports saved bounds", () => {
  const data = Buffer.from(`o box
v 0 0 0
v 20 0 0
v 0 10 5
vt 0 0
vt 1 0
vt 0 1
vn 0 0 1
f 1/1/1 2/2/1 3/3/1
`);
  assert.deepEqual(validateObj(data), {
    objects: 1,
    vertices: 3,
    textureCoordinates: 3,
    normals: 1,
    faces: 1,
    triangles: 1,
    triangleFaces: 1,
    quads: 0,
    ngons: 0,
    sideHistogram: { "3": 1 },
    boundsMm: { min: [0, 0, 0], max: [20, 10, 5], size: [20, 10, 5] },
  });
});

test("validates negative OBJ indices and triangulates polygon counts", () => {
  const result = validateObj(Buffer.from("v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf -4 -3 -2 -1\n"));
  assert.equal(result.objects, 1);
  assert.equal(result.faces, 1);
  assert.equal(result.triangles, 2);
  assert.equal(result.quads, 1);
});

test("rejects empty, malformed, nonfinite, and out-of-range OBJ geometry", () => {
  assert.throws(() => validateObj(Buffer.alloc(0)), /empty/u);
  assert.throws(() => validateObj(Buffer.from("v 0 0 NaN\nf 1 1 1\n")), /finite/u);
  assert.throws(() => validateObj(Buffer.from("v 0 0 0\nv 1 0 0\nf 1 2\n")), /fewer than three/u);
  assert.throws(() => validateObj(Buffer.from("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 4\n")), /out of range/u);
  assert.throws(() => validateObj(Buffer.from("v 0 0 0\n")), /without mesh/u);
});

test("counts quads, triangles, and n-gons with a side histogram", () => {
  const result = validateObj(Buffer.from([
    "o mixed", "v 0 0 0", "v 1 0 0", "v 1 1 0", "v 0 1 0", "v 0.5 1.5 0", "v -0.5 0.5 0", "vn 0 0 1",
    "f 1//1 2//1 3//1 4//1", "f 1//1 2//1 3//1 4//1", "f 1 2 3", "f 1 2 3 4 5", "f 1 2 3 4 5 6", "",
  ].join("\n")));
  assert.equal(result.faces, 5);
  assert.equal(result.quads, 2);
  assert.equal(result.triangleFaces, 1);
  assert.equal(result.ngons, 2);
  assert.deepEqual(result.sideHistogram, { "3": 1, "4": 2, "5": 1, "6": 1 });
  assert.equal(result.triangles, 2 + 2 + 1 + 3 + 4);
});

test("an all-quad mesh reports zero triangle faces and n-gons", () => {
  const result = validateObj(Buffer.from("v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n"));
  assert.deepEqual([result.triangleFaces, result.quads, result.ngons], [0, 1, 0]);
});

import { objMaterialLibraries, objSiblingStem, rewriteMtlTextureReferences, rewriteObjMaterialLibraries } from "./obj.ts";

test("reports per-object counts and bounds when several o groups exist", () => {
  const result = validateObj(Buffer.from(`mtllib geometry.mtl
o A
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
f 1 2 3 4
o B
v 10 0 0
v 12 0 0
v 10 5 0
f 5 6 7
f -3 -2 -1
`));
  assert.equal(result.objects, 2);
  assert.equal(result.faces, 3);
  assert.deepEqual(result.perObject, [
    { name: "A", vertices: 4, faces: 1, triangles: 2, triangleFaces: 0, quads: 1, ngons: 0, boundsMm: { min: [0, 0, 0], max: [1, 1, 0], size: [1, 1, 0] } },
    { name: "B", vertices: 3, faces: 2, triangles: 2, triangleFaces: 2, quads: 0, ngons: 0, boundsMm: { min: [10, 0, 0], max: [12, 5, 0], size: [2, 5, 0] } },
  ]);
});

test("omits perObject for a single object", () => {
  assert.equal("perObject" in validateObj(Buffer.from("o A\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n")), false);
});

test("lists and rewrites mtllib references without touching other bytes", () => {
  const data = Buffer.from("# c\r\nmtllib geometry.mtl\r\no A\r\nv 0 0 0\r\n");
  assert.deepEqual(objMaterialLibraries(data), ["geometry.mtl"]);
  const rewritten = rewriteObjMaterialLibraries(data, new Map([["geometry.mtl", "stick.mtl"]]));
  assert.equal(rewritten.toString(), "# c\r\nmtllib stick.mtl\r\no A\r\nv 0 0 0\r\n");
  assert.equal(rewriteObjMaterialLibraries(data, new Map([["other.mtl", "x.mtl"]])), data);
  assert.equal(rewriteObjMaterialLibraries(Buffer.from("mtllib /tmp/x/geometry.mtl\n"), new Map([["geometry.mtl", "a_b.mtl"]])).toString(), "mtllib a_b.mtl\n");
  // A name with whitespace would be read as two libraries; the rewriter refuses to write it.
  assert.throws(() => rewriteObjMaterialLibraries(Buffer.from("mtllib geometry.mtl\n"), new Map([["geometry.mtl", "a b.mtl"]])), /whitespace/u);
});

test("sibling stems never contain whitespace", () => {
  assert.equal(objSiblingStem("my part"), "my_part");
  assert.equal(objSiblingStem("a\tb  c"), "a_b_c");
  assert.equal(objSiblingStem("plain"), "plain");
});

test("rewrites MTL texture references only when they name a renamed staging file", () => {
  const mtl = Buffer.from("newmtl m\nmap_Kd geometry.png\nmap_Bump -bm 1 geometry.png\nmap_Ks other.png\nKd 1 0 0\n");
  const out = rewriteMtlTextureReferences(mtl, new Map([["geometry.png", "stick.png"]])).toString();
  assert.equal(out, "newmtl m\nmap_Kd stick.png\nmap_Bump -bm 1 stick.png\nmap_Ks other.png\nKd 1 0 0\n");
  assert.equal(rewriteMtlTextureReferences(mtl, new Map([["x.png", "y.png"]])), mtl);
});

test("objSiblingStem maps everything outside [A-Za-z0-9._-] to underscores (comment marker, control characters)", async () => {
  const { objSiblingStem } = await import("./obj.ts");
  assert.equal(objSiblingStem("my#part"), "my_part");
  assert.equal(objSiblingStem("a b\u0085c\u001fd"), "a_b_c_d");
  assert.equal(objSiblingStem("ok-name_1.v2"), "ok-name_1.v2");
  assert.equal(objSiblingStem(""), "geometry");
});
