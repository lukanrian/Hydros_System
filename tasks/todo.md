# Hydros System — Work items

## Task 1: Desktop shell and IFC 3D preview

**Description:** Create the WinForms/WebView2 app shell and secure current-file endpoint, then build an IFC Web Worker and hydraulic-only viewer from the existing Three.js camera/selection workflow.

**Acceptance criteria:**
- [x] Open IFC4 via file picker/start argument and extract pipe/fitting/valve/pump/meter/tank/boiler geometry in a Web Worker without changing source files.
- [x] Preserve GlobalId/class for picking and expose basic element properties.
- [x] Implement 3D orbit, pan, zoom-to-cursor, fit, top view, element selection, type filter, and pending-import transaction.
- [ ] Inspect rendering, selection and camera controls for the supplied IFCs in the desktop window.

**Verification:**
- [x] Build: `dotnet build Hydros.System.sln` (0 warnings, 0 errors).
- [x] WebIFC import smoke check completed on all three IFC fixtures; source IFCs remain unchanged.
- [ ] Manual visual check of rendering, selection and camera controls across the supplied IFCs. The 056-MARLUCI UI smoke check verified import and interface interactions, but did not complete a hydraulic calculation: Analyze stopped because no source was defined. General viewport checks remain pending.

**Dependencies:** None.

**Files likely touched:** `Hydros.System.sln`, `src/Hydros.System.UI/*`, `src/Hydros.System.UI/Web/*`, `.gitignore`.

**Estimated scope:** Large (split into shell and viewer sub-slices during implementation).

## Task 2: IFC metadata and unit audit

**Description:** Extract schema, units, spatial hierarchy, explicit system labels, properties and class counts; surface missing/unknown data.

**Acceptance criteria:**
- [x] Measured dimensions retain source units and normalize to metres only when conversion is known.
- [x] Explicit system labels retain their property/relation source; missing labels remain unclassified.
- [x] Unsupported or missing fields appear in import warnings.

**Verification:** Import smoke check on all three IFC fixtures; automated suite reports 45 passing tests.

**Dependencies:** Task 1.

**Files likely touched:** reader code and UI summary.

**Estimated scope:** Medium.

## Task 3: Reviewable network topology

**Description:** Build nodes/edges from explicit IFC ports/relations first, show geometric connection candidates separately, and let the user confirm/reject them.

**Acceptance criteria:**
- [x] IFC-port relations and geometric suggestions are distinguishable and traceable.
- [x] Geometric joins require manual confirmation before calculation.
- [x] Review decisions persist per IFC.

**Verification:** Automated topology tests pass. No end-to-end hydraulic calculation was completed on the 056-MARLUCI IFC; manual review of every model's connections remains pending.

**Dependencies:** Task 2.

**Estimated scope:** Large; split candidate detection and persistence into separate items.

## Task 4: Shared hydraulic core and three modes

**Description:** Implement a unit-safe network solver, then provide separate cold-water, hot-water and supply boundary modes; utility input asks for dynamic residual pressure at design flow and destination reservoir/direct network.

**Acceptance criteria:**
- [x] Calculation reports identify the governing standard and manufacturer data; memorial examples are not calculation inputs.
- [x] Hot-water distribution and return circulation are modeled from explicit IFC network labels; return branches are derived at confirmed distribution/return junctions and balanced by the required differential head. IFCs without return labels or closed loops remain incomplete.
- [x] Supply results report pressure sufficiency or the remaining pressure/head requirement.

**Verification:** Automated tests cover thermal flow, shared heat-loss allocation, branch head loss and incomplete IFC topology. None of the three supplied IFCs has an explicit return label, so they cannot exercise the return calculation; their results remain partial. UI rendering is not verified in a browser session.

**Dependencies:** Task 3.

**Estimated scope:** Large; write module specs before implementation.

## Task 5: Pump catalogs and reporting

**Description:** Extract pump curves from Schneider/WDM catalogs, select compatible candidates for calculated operating points, and generate traceable outputs/memorial.

**Acceptance criteria:**
- [x] The automatically evaluated WDM curve and operating point are traceable to the catalog/model. Rowa curve digitization remains pending.
- [x] Memorials provide report structure and do not supply calculation values.
- [x] JSON and Word exports include inputs, assumptions, warnings and relevant pipe/node results.

**Verification:** The previous recorded run had 46 automated tests passing. The latest 056-MARLUCI UI smoke check verified import and interface interactions only; Analyze stopped because no source was defined, so it did not generate hydraulic results. The supplied fixtures cannot verify return circulation. Full manufacturer-curve comparison remains pending for models without tabulated curves.

**Dependencies:** Task 4.

**Estimated scope:** Large; write module specs before implementation.

## Checkpoint: IFC foundation (after Tasks 1-2)
- [x] Desktop build succeeds (0 warnings, 0 errors).
- [ ] All three IFCs have been visually checked for silent omissions; parser smoke checks alone do not verify the viewport.
- [x] Metadata and classification warnings are generated and shown in the import summary.

## Checkpoint: Hydraulic dimensioner complete (after Tasks 3-5)
- [ ] All three modes are complete on project IFCs; none of the supplied IFCs identifies a return circuit, so hot-water recirculation is not yet verified against a real project model.
- [ ] All pump selections are traceable to complete authoritative performance curves; only the WDM curve is tabulated for automatic evaluation.
- [ ] Approved desktop layout and 3D interaction have been visually checked end to end.

