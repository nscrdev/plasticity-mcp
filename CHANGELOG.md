# Changelog

## Unreleased

- `plasticity_export_obj` accepts optional `maxSides` (3..64), `convex`, `density`, `maxWidthMm` and `curveChordMaxMm`, passed to Plasticity only when given. `maxSides: 4` writes quad-dominant meshes (all quads at fine tolerance); larger values allow mixed quads and n-gons. The OBJ validator now also reports `triangleFaces`, `quads`, `ngons` and `sideHistogram`, and the result echoes `meshOptions`. Default output is unchanged.

## 0.2.1 — 2026-09-28

- Show a compact core tool catalog by default in `npm start` and the Codex plugin. All operations remain searchable and callable through `plasticity_call`; `npm run start:full` exposes every operation directly.
- First GitHub release of the local preview for Plasticity 26.1.3 on macOS Apple Silicon. See the [acceptance matrix](docs/acceptance-matrix.md) for verified operations and remaining limitations.
