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
