function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function json(value: unknown) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

type WorkspaceData = {
  id: string;
  status: string;
  expiresAt: Date | null;
  savedDesignUrl: string | null;
  tid: string | null;
  title: string | null;
  description: string | null;
  previewUrl: string | null;
  productionArtworkReady: boolean;
  compatibleVariantIds: string[];
  product: {
    title: string;
    imageUrl: string | null;
    selectedVariantId: string;
    inkyBayProductUrl: string;
    variants: Array<{
      id: string;
      title: string;
      availableForSale: boolean;
    }>;
  };
  creator: { displayName: string; collectionUrl: string | null };
};

export function inkyBayWorkspaceHtml(input: {
  sessionToken: string;
  data: WorkspaceData;
}) {
  const state = { token: input.sessionToken, session: input.data };
  const image = input.data.product.imageUrl
    ? `<img class="product-image" src="${escapeHtml(
        input.data.product.imageUrl,
      )}" alt="${escapeHtml(input.data.product.title)}">`
    : `<div class="product-placeholder">Product preview</div>`;
  const variants = input.data.product.variants
    .filter((variant) => variant.availableForSale)
    .map(
      (variant) => `<label class="option"><input type="checkbox" name="compatibleVariantIds" value="${escapeHtml(
        variant.id,
      )}" ${
        input.data.compatibleVariantIds.includes(variant.id) ? "checked" : ""
      }><span>${escapeHtml(variant.title)}</span></label>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Create design · Custom House</title>
  <style>
    :root{--ink:#172033;--muted:#657084;--line:#e4e7ee;--brand:#6d35e8;--brand2:#ec4899;--ok:#0f766e;--danger:#b42318;--surface:#fff;--bg:#f7f5ff}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top right,#fce7f3 0,transparent 34%),var(--bg);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}.shell{width:min(1180px,calc(100% - 28px));margin:28px auto 56px}.hero{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;margin-bottom:20px}.eyebrow{color:var(--brand);font-weight:800;letter-spacing:.08em;text-transform:uppercase;font-size:12px}.hero h1{margin:7px 0 8px;font-size:clamp(28px,5vw,46px);line-height:1.05}.hero p{margin:0;color:var(--muted)}.pill{white-space:nowrap;background:#ede9fe;color:#5b21b6;padding:9px 13px;border-radius:999px;font-weight:750}.steps{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin:20px 0}.step{background:#fff;border:1px solid var(--line);border-radius:14px;padding:11px;font-size:13px;font-weight:700}.step b{display:block;color:var(--brand);margin-bottom:3px}.layout{display:grid;grid-template-columns:minmax(280px,380px) 1fr;gap:18px}.card{background:var(--surface);border:1px solid var(--line);border-radius:22px;padding:22px;box-shadow:0 18px 50px #4c1d9510}.card h2{margin:0 0 7px}.muted{color:var(--muted)}.product-image,.product-placeholder{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:16px;background:#f1f5f9;margin-bottom:16px}.product-placeholder{display:grid;place-items:center;color:var(--muted)}.stack{display:grid;gap:16px}.field{display:grid;gap:7px;font-weight:700}.field small{color:var(--muted);font-weight:500}.field input,.field textarea{width:100%;border:1px solid #cfd5df;border-radius:12px;padding:12px 13px;font:inherit}.field textarea{min-height:100px;resize:vertical}.options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.option{display:flex;gap:9px;align-items:center;border:1px solid var(--line);border-radius:12px;padding:10px;font-weight:650}.actions{display:flex;flex-wrap:wrap;gap:10px}.button{appearance:none;border:0;border-radius:999px;background:linear-gradient(135deg,var(--brand),var(--brand2));color:#fff;padding:12px 18px;font:inherit;font-weight:800;cursor:pointer;text-decoration:none;text-align:center}.button.secondary{background:#fff;color:var(--ink);border:1px solid var(--line)}.button:disabled{opacity:.55;cursor:not-allowed}.status{margin-top:15px;border-radius:14px;padding:12px 14px;background:#ecfdf5;color:var(--ok);font-weight:650}.status[data-error=true]{background:#fef3f2;color:var(--danger)}.asset-state{font-size:13px;color:var(--muted)}.success{display:none}.success.visible{display:block}.form-hidden{display:none}.preview{max-width:220px;border-radius:14px;border:1px solid var(--line)}@media(max-width:820px){.layout{grid-template-columns:1fr}.steps{grid-template-columns:1fr 1fr}.hero{display:block}.pill{display:inline-block;margin-top:12px}}@media(max-width:520px){.shell{width:min(100% - 18px,1180px);margin-top:14px}.card{padding:16px;border-radius:17px}.options,.steps{grid-template-columns:1fr}.actions .button{width:100%}}
  </style>
</head>
<body>
  <main class="shell">
    <header class="hero"><div><div class="eyebrow">Custom House Creator</div><h1>${escapeHtml(
      input.data.creator.displayName,
    )}'s design workspace</h1><p>Create in PitchPrint, then safely publish the fixed artwork to your collection.</p></div><span class="pill" id="status-pill">${escapeHtml(
      input.data.status,
    )}</span></header>
    <nav class="steps" aria-label="Publishing steps"><div class="step"><b>1</b>Product</div><div class="step"><b>2</b>Design in PitchPrint</div><div class="step"><b>3</b>Saved design</div><div class="step"><b>4</b>Listing & files</div><div class="step"><b>5</b>Publish</div></nav>
    <div class="layout" id="workspace">
      <aside class="card">${image}<h2>${escapeHtml(
        input.data.product.title,
      )}</h2><p class="muted">Session expires ${escapeHtml(
        input.data.expiresAt?.toLocaleString() || "soon",
      )}.</p><div class="actions"><a class="button secondary" href="${escapeHtml(
        input.data.product.inkyBayProductUrl,
      )}" target="_blank" rel="noopener">Open PitchPrint Designer</a></div><p class="muted">Create and save the design in the product's existing PitchPrint designer. Copy the saved-design URL, then return here. This manual bridge does not claim an unsupported PitchPrint API.</p></aside>
      <section class="card stack">
        <form id="details-form" class="stack">
          <label class="field">PitchPrint saved-design URL<input name="savedDesignUrl" type="url" required value="${escapeHtml(
            input.data.savedDesignUrl || "",
          )}" placeholder="https://...?projectId=..."><small>Only configured Shopify/PitchPrint HTTPS hosts are accepted.</small></label>
          <label class="field">Saved design tid<input name="tid" required maxlength="200" value="${escapeHtml(
            input.data.tid || "",
          )}"></label>
          <label class="field">Design title<input name="title" required minlength="2" maxlength="120" value="${escapeHtml(
            input.data.title || "",
          )}"></label>
          <label class="field">Short description<textarea name="description" maxlength="2000">${escapeHtml(
            input.data.description || "",
          )}</textarea></label>
          <div class="field">Compatible size/color variants<div class="options">${variants}</div></div>
          <div class="actions"><button class="button secondary" type="submit">Save design details</button></div>
        </form>
        <form id="assets-form" class="stack" enctype="multipart/form-data">
          <label class="field">Public product preview<input name="preview" type="file" accept="image/png,image/jpeg,image/webp" required><small>PNG, JPEG or WebP; minimum 600 × 600.</small></label>
          <label class="field">Production-ready artwork<input name="productionArtwork" type="file" accept="image/png,application/pdf" required><small>Private high-resolution PNG or production PDF. This file is never placed in public metafields.</small></label>
          <p class="asset-state">Preview: ${
            input.data.previewUrl ? "ready" : "required"
          } · Production artwork: ${
            input.data.productionArtworkReady ? "securely stored" : "required"
          }</p>
          ${
            input.data.previewUrl
              ? `<img class="preview" src="${escapeHtml(
                  input.data.previewUrl,
                )}" alt="Current design preview">`
              : ""
          }
          <div class="actions"><button class="button secondary" type="submit">Upload and validate files</button></div>
        </form>
        <div class="actions"><button id="publish-button" class="button" type="button">Publish to My Collection</button></div>
        <div class="status" id="message" aria-live="polite">Your progress is saved securely.</div>
      </section>
    </div>
    <section class="card success" id="success"><h2>Your design has been added to your collection.</h2><p>The product artwork is fixed and customers can choose only the allowed variants.</p><div class="actions"><a class="button" id="view-product">View Product</a><a class="button secondary" id="view-collection">View My Collection</a><a class="button secondary" href="/pages/creator-dashboard">Create Another Design</a></div></section>
  </main>
  <script>window.__CUSTOM_HOUSE_INKYBAY_WORKSPACE__=${json(state)};</script>
  <script>
  (()=>{const state=window.__CUSTOM_HOUSE_INKYBAY_WORKSPACE__;const base="/apps/customhouse/api/inkybay/creator-designs/"+encodeURIComponent(state.session.id);const message=document.getElementById("message");const setMessage=(text,error=false)=>{message.textContent=text;message.dataset.error=String(error)};const headers={"Accept":"application/json","X-Customhouse-Session-Token":state.token};async function request(url,options={}){const response=await fetch(url,{credentials:"same-origin",...options,headers:{...headers,...(options.headers||{})}});const body=await response.json().catch(()=>null);if(!response.ok||!body?.success)throw new Error(body?.error?.message||"The request could not be completed.");return body.data}function busy(button,value){button.disabled=value;button.dataset.label||=(button.textContent||"");button.textContent=value?"Working…":button.dataset.label}document.getElementById("details-form").addEventListener("submit",async event=>{event.preventDefault();const button=event.currentTarget.querySelector("button");busy(button,true);try{const form=new FormData(event.currentTarget);await request(base,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({savedDesignUrl:form.get("savedDesignUrl"),tid:form.get("tid"),title:form.get("title"),description:form.get("description"),compatibleVariantIds:form.getAll("compatibleVariantIds")})});setMessage("Design details saved.")}catch(error){setMessage(error instanceof Error?error.message:"The details could not be saved.",true)}finally{busy(button,false)}});document.getElementById("assets-form").addEventListener("submit",async event=>{event.preventDefault();const button=event.currentTarget.querySelector("button");busy(button,true);try{await request(base+"/assets",{method:"POST",body:new FormData(event.currentTarget)});setMessage("Preview and private production artwork uploaded successfully.")}catch(error){setMessage(error instanceof Error?error.message:"The files could not be uploaded.",true)}finally{busy(button,false)}});document.getElementById("publish-button").addEventListener("click",async event=>{const button=event.currentTarget;busy(button,true);try{const result=await request(base+"/publish",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});document.getElementById("workspace").classList.add("form-hidden");const success=document.getElementById("success");success.classList.add("visible");const product=document.getElementById("view-product");product.hidden=!result.productUrl;if(result.productUrl)product.href=result.productUrl;const collection=document.getElementById("view-collection");collection.hidden=!result.collectionUrl;if(result.collectionUrl)collection.href=result.collectionUrl;document.getElementById("status-pill").textContent="PUBLISHED"}catch(error){setMessage(error instanceof Error?error.message:"The design could not be published.",true);busy(button,false)}})})();
  </script>
</body>
</html>`;
}

export function inkyBayWorkspaceErrorHtml(message: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Creator publishing unavailable</title><style>body{margin:0;background:#f7f5ff;color:#172033;font-family:system-ui}.card{width:min(650px,calc(100% - 28px));margin:10vh auto;background:#fff;border:1px solid #e4e7ee;border-radius:20px;padding:28px}.button{display:inline-block;background:#6d35e8;color:#fff;padding:11px 16px;border-radius:999px;text-decoration:none}</style></head><body><main class="card"><h1>Creator publishing unavailable</h1><p>${escapeHtml(
    message,
  )}</p><a class="button" href="/pages/creator-dashboard">Return to creator dashboard</a></main></body></html>`;
}
