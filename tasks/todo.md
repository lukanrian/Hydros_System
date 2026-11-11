# Hydros System — Work items

## Task 1: Desktop shell and IFC 3D preview

**Description:** Create the WinForms/WebView2 app shell and secure current-file endpoint, then build an IFC Web Worker and hydraulic-only viewer from the existing Three.js camera/selection workflow.

**Acceptance criteria:**
- [x] Open IFC4 via file picker/start argument and extract pipe/fitting/valve/pump/meter geometry in a Web Worker without changing source files.
- [x] Preserve GlobalId/class for picking and expose basic element properties.
- [x] Implement 3D orbit, pan, zoom-to-cursor, fit, top view, element selection, type filter, and pending-import transaction.
- [ ] Inspect actual rendering, selection and camera controls in the desktop window; CUA could not attach in this run.

**Verification:**
- [x] Build: `dotnet build Hydros.System.sln` (0 warnings, 0 errors).
- [x] WebIFC parser smoke check on all three IFC fixtures: 714, 2,397, 21,067 hydraulic elements; geometry extraction completed with no thrown geometry errors.
- [ ] Manual visual check for rendered output, selection and camera controls in the desktop window.

**Dependencies:** None.

**Files likely touched:** `Hydros.System.sln`, `src/Hydros.System.UI/*`, `src/Hydros.System.UI/Web/*`, `.gitignore`.

**Estimated scope:** Large (split into shell and viewer sub-slices during implementation).

## Task 2: IFC metadata and unit audit

**Description:** Extract schema, units, spatial hierarchy, explicit system labels, properties and class counts; surface missing/unknown data.

**Acceptance criteria:**
- [ ] All measured dimensions carry source units and normalized metres only when conversion is known.
- [ ] Explicit system labels retain source property/relation; missing labels remain unclassified.
- [ ] Unsupported/missing fields appear in import warnings.

**Verification:** Build and compare import summaries for the three IFC fixtures.

**Dependencies:** Task 1.

**Files likely touched:** reader code and UI summary.

**Estimated scope:** Medium.

## Task 3: Reviewable network topology

**Description:** Build nodes/edges from explicit IFC ports/relations first, show geometric connection candidates separately, and let the user confirm/reject them.

**Acceptance criteria:**
- [ ] Explicit and inferred edges are distinguishable and traceable.
- [ ] No inferred join is accepted silently for calculation.
- [ ] Review decisions survive reopening the project.

**Verification:** Build and manually inspect each supplied model's open ends and connections.

**Dependencies:** Task 2.

**Estimated scope:** Large; split candidate detection and persistence into separate items.

## Task 4: Shared hydraulic core and three modes

**Description:** Implement a unit-safe network solver, then provide separate cold-water, hot-water and supply boundary modes; utility input asks for dynamic residual pressure at design flow and destination reservoir/direct network.

**Acceptance criteria:**
- [ ] All calculation criteria cite the governing standard/manufacturer source, never memorial examples.
- [ ] Hot-water first version includes distribution and hydraulic return, excludes heater energy sizing.
- [ ] Supply result states sufficiency or remaining pressure/head requirement.

**Verification:** Build and verify calculations with independently established engineering cases after normative rules are specified.

**Dependencies:** Task 3.

**Estimated scope:** Large; write module specs before implementation.

## Task 5: Pump catalogs and reporting

**Description:** Extract pump curves from Schneider/WDM catalogs, select compatible candidates for calculated operating points, and generate traceable outputs/memorial.

**Acceptance criteria:**
- [ ] Catalog curves and candidate points are traceable to catalog pages/models.
- [ ] Memorials provide report structure only and are never a numerical calculation source.
- [ ] Export includes inputs, assumptions, warnings and results by relevant pipe/node.

**Verification:** Build and manually compare selected candidates to source curves and generated output.

**Dependencies:** Task 4.

**Estimated scope:** Large; write module specs before implementation.

## Checkpoint: IFC foundation (after Tasks 1-2)
- [ ] Desktop build succeeds.
- [ ] All three IFCs render without silent omissions (geometry parser smoke completed; viewport inspection remains pending).
- [ ] Metadata and classification warnings are visible.

## Checkpoint: Hydraulic dimensioner complete (after Tasks 3-5)
- [ ] All three hydraulic modes produce auditable outputs.
- [ ] Pump selection and memorial are traceable to authoritative sources.
- [ ] Approved desktop layout and 3D interaction work end-to-end.

