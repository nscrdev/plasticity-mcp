export const MAX_OBJ_BYTES = 1024 * 1024 * 1024;

export interface ObjValidation {
  objects: number;
  vertices: number;
  textureCoordinates: number;
  normals: number;
  faces: number;
  /** Triangle-equivalent count: each polygon face counts as (sides - 2) triangles. */
  triangles: number;
  /** Faces with exactly three sides. */
  triangleFaces: number;
  /** Faces with exactly four sides. */
  quads: number;
  /** Faces with more than four sides. */
  ngons: number;
  /** Face count keyed by side count, e.g. { "4": 1440 }. */
  sideHistogram: Record<string, number>;
  boundsMm: {
    min: [number, number, number];
    max: [number, number, number];
    size: [number, number, number];
  };
  /** Per `o` group counts. Present only when the file declares more than one object. */
  perObject?: ObjObjectSummary[];
}

export interface ObjObjectSummary {
  name: string;
  /** `v` lines declared while this object was active. */
  vertices: number;
  faces: number;
  triangles: number;
  triangleFaces: number;
  quads: number;
  ngons: number;
  /** Bounds of the vertices referenced by this object's faces. */
  boundsMm: ObjValidation["boundsMm"] | null;
}

interface ObjectAccumulator {
  name: string;
  vertices: number;
  faces: number;
  triangles: number;
  triangleFaces: number;
  quads: number;
  ngons: number;
  min: [number, number, number] | null;
  max: [number, number, number] | null;
}

/** Names referenced by `mtllib` lines (the rest of each line, trimmed). */
export function objMaterialLibraries(data: Buffer): string[] {
  const names: string[] = [];
  for (const rawLine of data.toString("utf8").split(/\r?\n/u)) {
    const match = /^\s*mtllib\s+(.+?)\s*$/u.exec(rawLine);
    if (match) names.push(match[1]!);
  }
  return names;
}

/**
 * Rewrites `mtllib` references whose basename appears in `renames` (old basename -> new basename).
 * Everything else, including line endings, is preserved byte for byte.
 */
export function rewriteObjMaterialLibraries(data: Buffer, renames: Map<string, string>): Buffer {
  const text = data.toString("utf8");
  let changed = false;
  const rewritten = text.replace(/^(\s*mtllib\s+)(.+?)(\s*)$/gmu, (whole, prefix: string, name: string, suffix: string) => {
    const base = name.split(/[\\/]/u).pop()!;
    const replacement = renames.get(base);
    if (replacement === undefined) return whole;
    if (/\s/u.test(replacement)) throw new Error(`mtllib name ${JSON.stringify(replacement)} contains whitespace, which OBJ readers split into several libraries`);
    changed = true;
    return `${prefix}${replacement}${suffix}`;
  });
  return changed ? Buffer.from(rewritten, "utf8") : data;
}

/**
 * Rewrites texture references (map_*, bump, disp, decal, refl) in MTL text when their basename appears in `renames`
 * (old basename -> new basename). References to other files are left alone. Returns the input unchanged when nothing matched.
 */
export function rewriteMtlTextureReferences(data: Buffer, renames: Map<string, string>): Buffer {
  const text = data.toString("utf8");
  let changed = false;
  const rewritten = text.replace(/^(\s*(?:map_[A-Za-z0-9_]+|bump|disp|decal|refl)\b[^\r\n]*?)(\S+)(\s*)$/gmu, (whole, prefix: string, name: string, suffix: string) => {
    const base = name.split(/[\\/]/u).pop()!;
    const replacement = renames.get(base);
    if (replacement === undefined) return whole;
    changed = true;
    return `${prefix}${name.slice(0, name.length - base.length)}${replacement}${suffix}`;
  });
  return changed ? Buffer.from(rewritten, "utf8") : data;
}

/** Replaces whitespace runs so the name is a single token in `mtllib` lines. */
export function objSiblingStem(stem: string): string {
  const cleaned = stem.replace(/\s+/gu, "_");
  return cleaned.length > 0 ? cleaned : "geometry";
}

export function validateObj(data: Buffer): ObjValidation {
  if (data.length === 0 || data.length > MAX_OBJ_BYTES) throw new Error("Plasticity produced an empty or excessively large OBJ file");
  const text = data.toString("utf8");
  if (text.includes("\0") || text.includes("\uFFFD")) throw new Error("Plasticity produced an invalid UTF-8 OBJ file");
  let declaredObjects = 0;
  let textureCoordinates = 0;
  let normals = 0;
  let faces = 0;
  let triangles = 0;
  const sideHistogram: Record<string, number> = {};
  const vertices: Array<[number, number, number]> = [];
  const objects: ObjectAccumulator[] = [];
  let current: ObjectAccumulator | null = null;
  const newObject = (name: string): ObjectAccumulator => {
    const created: ObjectAccumulator = { name, vertices: 0, faces: 0, triangles: 0, triangleFaces: 0, quads: 0, ngons: 0, min: null, max: null };
    objects.push(created);
    return created;
  };
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const fields = line.split(/\s+/u);
    const keyword = fields[0];
    if (keyword === "o") {
      declaredObjects += 1;
      current = newObject(fields.slice(1).join(" "));
      continue;
    }
    if (keyword === "v") {
      if (fields.length < 4 || fields.length > 5) throw new Error("Plasticity produced a malformed OBJ vertex");
      vertices.push([
        finiteNumber(fields[1], "OBJ vertex X"),
        finiteNumber(fields[2], "OBJ vertex Y"),
        finiteNumber(fields[3], "OBJ vertex Z"),
      ]);
      if (current) current.vertices += 1;
      continue;
    }
    if (keyword === "vt") {
      if (fields.length < 2 || fields.length > 4) throw new Error("Plasticity produced a malformed OBJ texture coordinate");
      fields.slice(1).forEach((field) => finiteNumber(field, "OBJ texture coordinate"));
      textureCoordinates += 1;
      continue;
    }
    if (keyword === "vn") {
      if (fields.length !== 4) throw new Error("Plasticity produced a malformed OBJ normal");
      fields.slice(1).forEach((field) => finiteNumber(field, "OBJ normal"));
      normals += 1;
      continue;
    }
    if (keyword === "f") {
      if (fields.length < 4) throw new Error("Plasticity produced an OBJ face with fewer than three vertices");
      for (const reference of fields.slice(1)) validateFaceReference(reference, vertices.length, textureCoordinates, normals);
      faces += 1;
      triangles += fields.length - 3;
      const sides = String(fields.length - 1);
      sideHistogram[sides] = (sideHistogram[sides] ?? 0) + 1;
      current ??= newObject("(unnamed)");
      current.faces += 1;
      current.triangles += fields.length - 3;
      if (fields.length === 4) current.triangleFaces += 1;
      else if (fields.length === 5) current.quads += 1;
      else current.ngons += 1;
      for (const reference of fields.slice(1)) {
        const raw = Number(reference.split("/")[0]);
        const vertex = vertices[raw > 0 ? raw - 1 : vertices.length + raw]!;
        current.min ??= [...vertex];
        current.max ??= [...vertex];
        for (let axis = 0; axis < 3; axis += 1) {
          current.min[axis] = Math.min(current.min[axis]!, vertex[axis]!);
          current.max[axis] = Math.max(current.max[axis]!, vertex[axis]!);
        }
      }
    }
  }
  if (vertices.length === 0 || faces === 0) throw new Error("Plasticity produced an OBJ file without mesh vertices and faces");
  const min: [number, number, number] = [...vertices[0]!] as [number, number, number];
  const max: [number, number, number] = [...vertices[0]!] as [number, number, number];
  for (const vertex of vertices.slice(1)) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis]!, vertex[axis]!);
      max[axis] = Math.max(max[axis]!, vertex[axis]!);
    }
  }
  return {
    objects: Math.max(1, declaredObjects),
    vertices: vertices.length,
    textureCoordinates,
    normals,
    faces,
    triangles,
    triangleFaces: sideHistogram["3"] ?? 0,
    quads: sideHistogram["4"] ?? 0,
    ngons: Object.entries(sideHistogram).reduce((sum, [sides, count]) => sum + (Number(sides) > 4 ? count : 0), 0),
    sideHistogram: Object.fromEntries(Object.entries(sideHistogram).sort((a, b) => Number(a[0]) - Number(b[0]))),
    boundsMm: { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] },
    ...(objects.length > 1
      ? {
        perObject: objects.map((object) => ({
          name: object.name,
          vertices: object.vertices,
          faces: object.faces,
          triangles: object.triangles,
          triangleFaces: object.triangleFaces,
          quads: object.quads,
          ngons: object.ngons,
          boundsMm: object.min && object.max
            ? { min: object.min, max: object.max, size: [object.max[0] - object.min[0], object.max[1] - object.min[1], object.max[2] - object.min[2]] as [number, number, number] }
            : null,
        })),
      }
      : {}),
  };
}

function finiteNumber(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (value === undefined || value.trim().length === 0 || !Number.isFinite(parsed)) throw new Error(`${label} must be finite`);
  return parsed;
}

function validateFaceReference(reference: string, vertexCount: number, textureCount: number, normalCount: number): void {
  const parts = reference.split("/");
  if (parts.length > 3 || parts[0]?.length === 0) throw new Error("Plasticity produced a malformed OBJ face reference");
  validateIndex(parts[0]!, vertexCount, "vertex");
  if (parts.length >= 2 && parts[1]?.length) validateIndex(parts[1], textureCount, "texture coordinate");
  if (parts.length === 3 && parts[2]?.length) validateIndex(parts[2], normalCount, "normal");
}

function validateIndex(value: string, count: number, label: string): void {
  const index = Number(value);
  if (!Number.isInteger(index) || index === 0) throw new Error(`OBJ ${label} index must be a nonzero integer`);
  const resolved = index > 0 ? index - 1 : count + index;
  if (resolved < 0 || resolved >= count) throw new Error(`OBJ ${label} index is out of range`);
}
