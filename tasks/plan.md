# Implementation Plan: Hydros System — IFC reader and 3D preview

## Overview

First vertical slice of the approved hydraulic dimensioner: start a new Windows desktop app, open the supplied IFC4 files, show their hydraulic elements in a 3D viewport derived from the Dimensionador Tipo Grelha viewer, and report recognized items and import warnings. No hydraulic sizing is calculated in this slice.

## Architecture decisions

- Use .NET 10 WinForms + WebView2 to match the reference desktop host.
- Copy only the licensed viewer libraries needed (Three.js, camera-controls, web-ifc and geometry utilities); create a new hydraulic UI instead of copying the sprinkler-specific application wholesale.
- A Web Worker uses the existing WebIFC parser to extract IFC product meshes and sends transferable geometry batches to Three.js; GlobalId/type metadata are preserved. A narrow WebView2 host endpoint streams only the pending or accepted IFC file; large contents never travel through JSON.
- IFC classification is populated only from explicit IFC properties/relations. This slice may display "Sistema não identificado" where absent; topology inference and hydraulic calculation are separate tasks.
- Original Dimensionador Tipo Grelha and input IFC/catalog/norm PDFs are read-only reference assets, not source files to modify or commit.
- No calculation logic or memorial-derived criteria are included in this slice.

## Work order

1. Build shell + secure IFC selection/streaming + 3D hydraulic geometry preview.
2. Complete metadata extraction (units, spatial hierarchy, property sets, explicit system labels, warning inventory) and validate each fixture.
3. Define `network-topology` contract and review inferred joins in UI.
4. Implement hydraulic core and separately specify/implement cold water, hot water, and utility supply boundary conditions.
5. Parse pump catalogs and rank pump candidates against calculated system curves.
6. Complete reports/memorial and refine project/element/pump panels to the approved visual direction.

## Risks

- IFC parsing runs in a Web Worker and reports download/geometry progress; measure the largest model before deciding if an additional memory optimization is needed.
- Streaming raw IFC through WebView2 must be restricted to the selected file and GET/HEAD; never accept an arbitrary filesystem path from page JavaScript.
- Copying viewer dependencies requires preserving their licenses.
- IFC authoring tools differ; classification/system names may be absent or inconsistent. Never convert guesses into facts.

## Checkpoints

- After Task 1: build succeeds; each supplied IFC can be selected and hydraulically relevant geometry appears; 3D orbit, pan, zoom, top view, framing, and element selection work.
- After Task 2: verify counts and explicit system metadata against IFC classes/property sets and list ambiguities without silently dropping them.
- Before hydraulic core: settle and document the intermediate network contract and normative inputs.
