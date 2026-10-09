# Changelog

## Unreleased

- `plasticity_export_obj` accepts optional `maxSides` (3..64), `convex`, `density`, `maxWidthMm` and `curveChordMaxMm`, passed to Plasticity only when given. `maxSides: 4` writes quad-dominant meshes (all quads at fine tolerance); larger values allow mixed quads and n-gons. The OBJ validator now also reports `triangleFaces`, `quads`, `ngons` and `sideHistogram`, and the result echoes `meshOptions`. Default output is unchanged.
- `plasticity_export_obj` new optional inputs, each passed to `OBJExportFactory` only when given (defaults unchanged): `perBody` (one OBJ per body; `path` is then an output directory and files are `<sanitised body name>_<body id>.obj`; to export a chosen subset into one file, list those ids with `perBody` false), `curveChordToleranceMm` and `surfacePlaneToleranceMm` (0..10 mm, override the shared `chordToleranceMm` per side), `curveChordAngleDegrees` and `surfacePlaneAngleDegrees` (0..90, override the shared `angleToleranceDegrees` per side), `planeAngleDegrees` (0..90), `lockPlaneTolerance` and `lockAngleTolerance` (booleans), and `simplify` (Simplify Radial Surfaces, default false). The result echoes every applied option in `meshOptions` (including `simplify`).
- OBJ export now keeps sibling files: anything the native export writes next to `geometry.obj` (an `.mtl`) is copied beside the final OBJ under the OBJ's name and `mtllib` lines are rewritten. The result reports `mtl.written`, `mtl.paths`, `mtl.mtllib` and `siblingFiles`.
- `validateObj` reports `perObject` counts and bounds when a file has several `o` groups.
- `plasticity_chamfer` accepts optional `distance2Mm` (two-distance chamfer: `lockDistances = false`, `distance1`, `distance2`) and `mode` (`offset` default, or `apex` via `ChamferMode.Apex`). They cannot be combined. The sign convention of the second distance and the Apex behaviour are unverified until a live run.
- New experimental tool `plasticity_fillet_variable`: base `radiusMm` plus `points` of `{edgeId, radiusMm, t (0..1) | pointMm}`, mapped to `FilletShellFactory.addVariationPoint`. It is a separate tool because it needs a point list and an explicit edge list. The argument order of `addVariationPoint` is inferred from its declared arity of 2 (point, radius in metres) and the call is refused if the arity differs; verify on a scratch body.

### Not exposed

- OBJ Remove Small Features, Inflect and Min Width: no native accessor with a matching name exists on `OBJExportFactory` (read from the live 26.1.3 prototype), and the factory source is obfuscated, so the field names cannot be confirmed without constructing the factory.
- OBJ `empties` (instance empties): it is an accessor, but it takes native instance-empty views filled through `addInstanceEmpty`, not a plain value.
- `lockPlaneTolerance` and `lockAngleTolerance` are exposed, but their value type could not be read; boolean is assumed.
- Variable-fillet limit points (`addLimitPoint`, arity 3): argument meaning not readable.
- Full round fillet (`fullRound`, `isFullRoundPossible`): `FilletShellFactory` has no settable flag that selects it (`mode` is a getter), so there is no verified way to trigger it. Not implemented rather than guessed.
- Fillet shape, `yBlend`, `rho` and Tension: these accessors exist only on `MultiFilletShellFactory`; the MCP uses `FilletShellFactory`.
- Studio-only tools (Square, Align Surfaces, XNurbs) are out of scope for the Indie licence.

## 0.2.1 — 2026-09-28

- Show a compact core tool catalog by default in `npm start` and the Codex plugin. All operations remain searchable and callable through `plasticity_call`; `npm run start:full` exposes every operation directly.
- First GitHub release of the local preview for Plasticity 26.1.3 on macOS Apple Silicon. See the [acceptance matrix](docs/acceptance-matrix.md) for verified operations and remaining limitations.
