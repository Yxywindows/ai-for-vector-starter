# D01 work state

State: ready for coordinator acceptance. Version: D01-R1. Owner: D01 task, 69f6 worktree. Implementation, review, fixes and verification are complete; final handoff freezes this directory until coordinator feedback. No further visual iteration is pending.

Entry: `http://127.0.0.1:18404/` → `index.html`. Portable startup: open PowerShell in the extracted directory and run `node server.mjs` or `.\start.ps1`.

Delivered: real A GLB and independent cube; one Three.js canvas; six face-anchored previews with indefinite reading time and explicit expansion; six destination pages and project/data details; responsive desktop/mobile/landscape views; separate map design with actual geometry, attributes and local unsaved-edit branches. Current code and coordinator contracts define capability boundaries.

Verification: 25 interaction checks passed; 8 map checks passed, including two separate saved rows surviving reload and real sessionStorage failure retaining pending edits. No reported browser errors or business write requests. The 16.24-second actual browser film was independently decoded at 7 times; buffered player seek to 9 seconds passed. Final keyframes, 24-panel contact sheet, contrast, performance and review evidence are included.

Latest review fixes: restored URL context now updates the actual scene; large viewport DPR and narrow screen framing corrected; video evidence uses decoded frames; consecutive local draft saves merge prior values. See `evidence/source-review.diff` and `evidence/review-report.json`.

Handoff authority: `stage_manifest.json` and `SHA256SUMS.txt`. Read-only integrity command: `node scripts/verify.mjs`, success marker `D01_VERIFY_OK`. Package: `D01-spatial-observatory-R1.zip`; its external checksum is `delivery-zip.sha256`.

Scope: all own writes remain under `artifacts/xiaog/D01`; protected main application code and T02 inputs are verified by hash. No main web/backend/dependency edits, commit, push, database writes or changes to existing GIS services. The preview service binds only to 127.0.0.1:18404.

Limits: independent design prototype; historical finite read-only snapshot; simulated analysis/export validation; session-only design drafts; no production OpenLayers integration, phone hardware benchmark or deployment acceptance. Inherited T02 model warnings remain documented. Coordinator acceptance is pending; it is distinct from local prototype verification.
