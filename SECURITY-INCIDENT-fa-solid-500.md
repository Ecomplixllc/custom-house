# Security Incident: Disguised Font Asset and VS Code Auto-Execution

Date investigated: 2026-09-26
Repository: CustomHouse Creator Marketplace
Status: local remediation complete on `development`; remote branches and production are not yet remediated

## 1. Confirmed malicious artifact

The tracked path `public/fonts/fa-solid-500.woff2` was not a WOFF2 font. Windows Security quarantined the working-tree copy. Static inspection of the committed blob confirmed obfuscated Node.js execution indicators, including dynamic evaluation, child-process spawning, and outbound network behavior. The payload was not executed or reproduced during this investigation.

The current malicious blob metadata is:

- Blob: `72cc5362c1b21e1f128528295786a0c390b94ba0`
- Size: 32,320 bytes
- Last modifying commit: `429bbdf7a36395ddbac10be7a067fc6a6a45c2d8`

## 2. Introducing history

The malicious chain began earlier than commit `429bbdf`:

1. `1708cfce9a7d6940147df1128a8d3605cdf34840` (`feat: personalize creator dashboard heading`, 2026-07-27) added:
   - `public/fonts/fa-solid-400.woff2`, blob `a501890f1f96697651f2a5fa9d34cc2b9b20ee7e`, 34,731 bytes.
   - `.vscode/tasks.json`, which ran the disguised file with Node on folder open.
   - `.vscode/settings.json`, which enabled automatic tasks.
   - The fake font had text/tab bytes rather than the required WOFF2 `wOF2` signature and matched the same obfuscation/execution indicators.
2. `d4f34cceb45120d00a5c9cf71a9a7bebb76aa28b` (`fix: stabilize creator payouts on mobile`, 2026-09-07) deleted the `400` path, added `public/fonts/fa-solid-500.woff2`, and updated the hidden VS Code task to execute the new path.
   - Blob: `584816cee5742c0343159521664d3a60c6591cde`
   - Size: 32,003 bytes
3. `429bbdf7a36395ddbac10be7a067fc6a6a45c2d8` replaced the `500` blob with the 32,320-byte variant listed above.

All three commits are unsigned in the local Git metadata and carry the author/committer identity `JPChoyon <kotjpckhan@gmail.com>`. Git identity metadata alone does not prove who created or pushed the commits. The local remote-tracking reflog records `origin/main` being force-updated from `1bc0acb` to `429bbdf` on 2026-09-25. The only tree difference between sibling commits `1bc0acb` and `429bbdf` is the malicious font variant; `1bc0acb` still contains the earlier malicious `500` blob.

## 3. Related files and refs

Confirmed related files:

- `public/fonts/fa-solid-400.woff2` — historical predecessor payload, still reachable on backup branches.
- `public/fonts/fa-solid-500.woff2` — current quarantined payload path.
- `.vscode/tasks.json` — hidden `eslint-check` task that invoked Node on the disguised font, used `runOn: "folderOpen"`, and hid task output.
- `.vscode/settings.json` — set `task.allowAutomaticTasks` and included another folder-open task configuration.

Current remote tips containing the malicious `500` path include `origin/main`, `origin/development`, `origin/HEAD`, and the remote `codex/*` and `feature/*` refs inspected during this incident. Historical backup branches also retain the malicious `400` path and auto-execution configuration.

Other files added alongside the first incident commit were reviewed. The remaining Font Awesome `.woff2` assets have the valid `77 4F 46 32` (`wOF2`) signature. No other current file matched the high-risk execution/obfuscation indicators. The remaining `.vscode` extension and launch recommendations were introduced by the same commit but do not reference the payload or automatically execute it; they are not classified as malicious based on the available evidence.

## 4. Executability and exposure assessment

### STATIC_EXPOSURE

Confirmed. An HTTP HEAD request on 2026-09-26 returned `200 OK` for:

`https://custom-house.vercel.app/fonts/fa-solid-500.woff2`

The response reported `Content-Type: font/woff2` and `Content-Length: 32320`. Vite/Vercel treated the path as a public static asset.

### BUILD_EXECUTION_RISK

No evidence that the normal npm, React Router, Vite, Docker, Shopify, GitHub Actions, or Vercel build lifecycle executed the file. `package.json` contains only the expected `prisma generate` postinstall hook, and no package/build script references either fake font name. The Vite public directory behavior copied the asset into deployment output without evaluating it.

### SERVER_EXECUTION_RISK

No evidence that application server code imported, required, read, or executed either fake font path. Production could serve the bytes, but static serving alone does not execute Node.js content on the server.

### CLIENT_EXECUTION_RISK

No source, CSS, HTML, Liquid, or JavaScript reference to either fake font path was found. Production served the artifact with a font MIME type, and no script import or script tag was found. Browser-side script execution is therefore not supported by the available evidence.

### DEVELOPER_WORKSTATION_EXECUTION_RISK

Credible and high. The committed `.vscode/tasks.json` explicitly ran:

`node ./public/fonts/fa-solid-400.woff2`

and later the `500` path. It was configured as a hidden background task with `runOn: "folderOpen"`. Workspace settings enabled automatic tasks. According to the official VS Code task documentation, a folder-open task runs automatically without prompting when automatic tasks are enabled in a trusted workspace. Restricted Mode would prevent the task from running.

No exact filename trace was found in the available VS Code logs, workspace storage, or PowerShell history. This means actual execution is not proven, but any trusted VS Code opening between 2026-07-27 and remediation must be treated as a plausible execution event.

## 5. Files removed or sanitized

- Removed `public/fonts/fa-solid-500.woff2` from the current `development` tree.
- Removed `.vscode/tasks.json` from the current `development` tree.
- Removed automatic-task permission and folder-open task configuration from `.vscode/settings.json`.

No legitimate replacement was added. The application has no reference to the fake `400` or `500` filenames. The existing `public/fonts/fa-solid-900.woff2` is a valid WOFF2 asset and remains available if Font Awesome Solid is needed.

## 6. Credential risk and recommended rotations

Static production hosting alone does not establish access to Vercel runtime secrets, Shopify secrets, database credentials, or other server environment variables.

If this repository was ever opened as a trusted VS Code workspace while the automatic task existed, assume the payload could access the developer account's environment variables, readable files, CLI credential stores, and network. In that case, rotate or revoke credentials that were present on the affected workstation during the exposure window, including:

1. Vercel CLI tokens/sessions and relevant project/team tokens.
2. GitHub personal access tokens, OAuth sessions, SSH keys where exposed, and stored Git credentials; audit account and repository activity.
3. Shopify app secrets, Admin/API access tokens, and development-store credentials stored locally.
4. Neon/Postgres connection strings and database passwords.
5. Resend API keys only if one existed on the workstation before this remediation.
6. PitchPrint, Vercel Blob, storage, webhook, encryption, signing, and other provider secrets stored in local `.env` files or CLI configuration.

Do not rotate credentials automatically from this repository. Rotate them through each provider's trusted administrative interface, invalidate old sessions, and update deployment configuration only after the repository cleanup is reviewed.

## 7. Verification performed

- Collected Git commit metadata, blob hashes, sizes, paths, containing refs, and remote-tracking reflog entries without executing the payload.
- Compared `1bc0acb` and `429bbdf` and traced the predecessor payload to `1708cfce`.
- Scanned current application, extension, script, public, theme, package, Docker, Vercel, Shopify, and CI configuration for execution primitives and references.
- Verified remaining WOFF2 asset signatures.
- Confirmed no current references to the fake `400` or `500` font names after remediation.
- Confirmed no current hidden Node-on-font task or automatic-task permission after remediation.
- Checked available VS Code logs, workspace storage, and PowerShell history for exact payload paths; no trace was found.
- Performed a headers-only production request confirming static exposure without downloading the payload.
- Ran `git diff --check`, a targeted static rescan, `npm run typecheck`, and `npm run build` after remediation.

## 8. Cleanliness and deployment decision

The local `development` tree is clean of the active payload and its automatic execution path after the remediation changes. The malicious blobs still exist in Git history, and unremediated local/remote branch tips and production still contain or serve them until an approved branch update and deployment occurs.

Deployment is **not yet safe** from the current remote state. Before deployment:

1. Review this report and the remediation commit.
2. Decide whether to coordinate a history rewrite and removal/update of affected backup and historical branches. Do not force-rewrite shared history without explicit approval and a recovery plan.
3. Rotate credentials if the workspace may have been opened as trusted in VS Code.
4. Push the reviewed clean `development` commit, test it, then merge to `main` under the normal approval workflow.
5. Redeploy production and verify the static URL returns `404`.
6. Invalidate or confirm expiry of CDN caches and review Vercel/GitHub/Shopify access logs for unexpected activity.

No deployment, remote branch mutation, credential rotation, or history rewrite was performed during this remediation.
