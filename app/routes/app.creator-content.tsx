import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { AdminStyles, SafeAdminError } from "../components/admin-ui";
import { authenticate } from "../shopify.server";
import {
  listFeaturedCreatorAdminState,
  saveFeaturedCreatorOrder,
  type FeaturedCreatorSummary,
} from "../services/creator-content.server";
import { DomainError } from "../services/domain";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const query = new URL(request.url).searchParams.get("q") || "";
  const state = await listFeaturedCreatorAdminState(session.shop, query);
  return { ...state, query };
}

function creatorIdsFromForm(value: FormDataEntryValue | null) {
  if (typeof value !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new DomainError(
      "FEATURED_CREATOR_INPUT_INVALID",
      "Featured Creator ordering is invalid.",
      422,
    );
  }
  if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string")) {
    throw new DomainError(
      "FEATURED_CREATOR_INPUT_INVALID",
      "Featured Creator ordering is invalid.",
      422,
    );
  }
  return parsed;
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  try {
    const creatorIds = creatorIdsFromForm(form.get("creatorIds"));
    await saveFeaturedCreatorOrder(session.shop, creatorIds);
    return {
      ok: true,
      message: "Featured Creator ordering saved.",
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof DomainError
          ? error.message
          : "Featured Creators could not be saved.",
    };
  }
}

function CreatorIdentity({ creator }: { creator: FeaturedCreatorSummary }) {
  return (
    <span className="featured-creator-identity">
      <span className="featured-creator-avatar" aria-hidden="true">
        {creator.profileImageUrl ? (
          <img src={creator.profileImageUrl} alt="" />
        ) : (
          creator.displayName.slice(0, 1).toUpperCase()
        )}
      </span>
      <span>
        <strong>{creator.displayName}</strong>
        <small>@{creator.publicHandle}</small>
      </span>
    </span>
  );
}

export default function CreatorContentAdmin() {
  const { candidates, selected: initialSelected, query } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [selected, setSelected] = useState(initialSelected);
  const selectedIds = new Set(selected.map((creator) => creator.id));

  const addCreator = (creator: FeaturedCreatorSummary) => {
    setSelected((current) =>
      current.some((item) => item.id === creator.id)
        ? current
        : [...current, creator],
    );
  };
  const moveCreator = (index: number, offset: number) => {
    setSelected((current) => {
      const nextIndex = index + offset;
      if (nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
      return next;
    });
  };

  return (
    <s-page heading="Creator Content">
      <AdminStyles />
      <style>{`
        .featured-creator-admin{--fc-ink:#17151d;--fc-muted:#65636b;--fc-line:#e3e0e8;--fc-purple:#6f2cff;--fc-purple-dark:#4b19a8;--fc-lime:#c8ff00;display:grid;gap:20px;max-width:1120px;margin:0 auto;padding:12px 0 40px;color:var(--fc-ink)}
        .featured-creator-admin *{box-sizing:border-box}
        .featured-creator-admin button,.featured-creator-admin input{font:inherit}
        .featured-creator-admin__hero{position:relative;overflow:hidden;border:1px solid #29252f;border-radius:20px;background:linear-gradient(118deg,#121016 0 64%,#25133f 100%);padding:30px;color:#fff;box-shadow:0 14px 34px rgba(24,16,40,.14)}
        .featured-creator-admin__hero:after{position:absolute;right:-68px;top:-92px;width:250px;height:250px;border:42px solid rgba(200,255,0,.12);border-radius:50%;content:"";pointer-events:none}
        .featured-creator-admin__hero-grid{position:relative;z-index:1;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:28px;align-items:end}
        .featured-creator-eyebrow{display:flex;align-items:center;gap:8px;margin:0 0 10px;color:var(--fc-lime);font-size:11px;font-weight:800;letter-spacing:.13em;text-transform:uppercase}
        .featured-creator-eyebrow:before{width:8px;height:8px;border-radius:50%;background:var(--fc-lime);box-shadow:0 0 0 4px rgba(200,255,0,.12);content:""}
        .featured-creator-admin__hero h1{max-width:650px;margin:0;font-size:clamp(28px,4vw,46px);letter-spacing:-.04em;line-height:1.02}
        .featured-creator-admin__hero p{max-width:680px;margin:12px 0 0;color:#c9c5d0;line-height:1.55}
        .featured-creator-stats{display:flex;gap:10px}
        .featured-creator-stat{min-width:118px;border:1px solid rgba(255,255,255,.13);border-radius:14px;background:rgba(255,255,255,.06);padding:14px 16px;backdrop-filter:blur(8px)}
        .featured-creator-stat strong,.featured-creator-stat span{display:block}.featured-creator-stat strong{font-size:24px;line-height:1}.featured-creator-stat span{margin-top:6px;color:#bcb6c5;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em}
        .featured-creator-search{position:relative;z-index:1;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;margin-top:24px}
        .featured-creator-search input{width:100%;height:46px;border:1px solid rgba(255,255,255,.2);border-radius:10px;outline:0;background:rgba(255,255,255,.08);color:#fff;padding:0 15px;font-size:14px}.featured-creator-search input::placeholder{color:#aaa4b2}.featured-creator-search input:focus{border-color:#a96cff;box-shadow:0 0 0 3px rgba(111,44,255,.24)}
        .featured-creator-search button,.featured-creator-save,.featured-creator-candidate button,.featured-creator-actions button{min-height:38px;border-radius:9px;padding:0 14px;font-weight:750;cursor:pointer;transition:transform .15s ease,box-shadow .15s ease,background .15s ease}
        .featured-creator-search button{border:1px solid var(--fc-lime);background:var(--fc-lime);color:#111}.featured-creator-search button:hover,.featured-creator-save:hover,.featured-creator-candidate button:hover:not(:disabled){transform:translateY(-1px)}
        .featured-creator-card{border:1px solid var(--fc-line);border-radius:18px;background:#fff;padding:24px;box-shadow:0 7px 22px rgba(24,16,40,.06)}
        .featured-creator-card__header{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.featured-creator-card__label{display:block;margin-bottom:5px;color:var(--fc-purple);font-size:10px;font-weight:850;letter-spacing:.12em;text-transform:uppercase}.featured-creator-card h2{margin:0;font-size:22px;letter-spacing:-.025em}.featured-creator-card p{margin:6px 0 0;color:var(--fc-muted);line-height:1.45}.featured-creator-count{flex:0 0 auto;border:1px solid #ded4ee;border-radius:999px;background:#f7f3ff;color:var(--fc-purple-dark);padding:7px 11px;font-size:11px;font-weight:800}
        .featured-creator-list{display:grid;gap:10px;margin:20px 0 0;padding:0;list-style:none;counter-reset:featured}.featured-creator-list li{display:grid;grid-template-columns:42px minmax(0,1fr) auto;gap:12px;align-items:center;border:1px solid var(--fc-line);border-radius:13px;background:#fcfbfd;padding:11px 12px}.featured-creator-order{display:grid;width:34px;height:34px;place-items:center;border-radius:9px;background:#ede5ff;color:var(--fc-purple-dark);font-size:11px;font-weight:850}
        .featured-creator-identity{display:flex;align-items:center;gap:11px;min-width:0}.featured-creator-identity>span:last-child{display:grid;min-width:0}.featured-creator-identity strong,.featured-creator-identity small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.featured-creator-identity strong{font-size:13px}.featured-creator-identity small{margin-top:2px;color:#77727e;font-size:11px}.featured-creator-avatar{display:grid;place-items:center;width:44px;height:44px;flex:0 0 44px;overflow:hidden;border:1px solid #ded4ee;border-radius:50%;background:linear-gradient(145deg,#f2ebff,#e7dbff);color:var(--fc-purple);font-weight:850}.featured-creator-avatar img{width:100%;height:100%;object-fit:cover}
        .featured-creator-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}.featured-creator-actions button{min-height:34px;border:1px solid #d5d1da;background:#fff;color:#36313c;font-size:11px}.featured-creator-actions button:hover:not(:disabled){border-color:#a789cf;background:#f8f4ff}.featured-creator-actions button:last-child{border-color:#f1c8c5;color:#a42820}.featured-creator-actions button:disabled{opacity:.38;cursor:not-allowed}
        .featured-creator-savebar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:18px;border-top:1px solid var(--fc-line);padding-top:18px}.featured-creator-savebar span{color:var(--fc-muted);font-size:12px}.featured-creator-save{min-height:42px;border:1px solid #211d27;background:#211d27;color:#fff;box-shadow:0 7px 16px rgba(32,24,45,.18)}
        .featured-creator-candidates{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:18px}.featured-creator-candidate{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid var(--fc-line);border-radius:13px;background:#fcfbfd;padding:12px}.featured-creator-candidate.is-selected{background:#f8f5fb}.featured-creator-candidate button{min-width:96px;border:1px solid #d9c9f4;background:#f1e9ff;color:var(--fc-purple-dark)}.featured-creator-candidate button:disabled{border-color:#e4e2e7;background:#f2f1f3;color:#98949d;cursor:not-allowed}
        .featured-creator-notice{margin:16px 0 0!important;border-radius:10px;padding:11px 13px!important;font-size:12px;font-weight:700}.featured-creator-notice--success{border:1px solid #bce6cb;background:#ecf9f1;color:#176b3a}.featured-creator-notice--error{border:1px solid #fac8c4;background:#fff1f0;color:#b42318}.featured-creator-empty{margin-top:18px!important;border:1px dashed #d8d3dd;border-radius:12px;background:#faf9fb;padding:22px!important;color:#77727e!important;text-align:center}
        @media(max-width:760px){.featured-creator-admin__hero{padding:22px}.featured-creator-admin__hero-grid{grid-template-columns:1fr}.featured-creator-stats{width:100%}.featured-creator-stat{flex:1;min-width:0}.featured-creator-search{grid-template-columns:1fr}.featured-creator-card{padding:18px}.featured-creator-card__header,.featured-creator-savebar{align-items:stretch;flex-direction:column}.featured-creator-candidates{grid-template-columns:1fr}.featured-creator-list li{grid-template-columns:36px minmax(0,1fr)}.featured-creator-actions{grid-column:1/-1;justify-content:flex-start;padding-left:48px}.featured-creator-candidate{align-items:flex-start;flex-direction:column}.featured-creator-candidate button,.featured-creator-save{width:100%}}
      `}</style>
      <s-section>
        <div className="featured-creator-admin">
          <header className="featured-creator-admin__hero">
            <div className="featured-creator-admin__hero-grid">
              <div>
                <span className="featured-creator-eyebrow">Storefront curation</span>
                <h1>Build the Featured Creators lineup</h1>
                <p>
                  Choose and order the approved Creators promoted at the top of the public
                  Creator Content page. The product grid continues to include every eligible
                  published Creator product automatically.
                </p>
              </div>
              <div className="featured-creator-stats" aria-label="Creator Content summary">
                <div className="featured-creator-stat">
                  <strong>{selected.length}</strong>
                  <span>Featured</span>
                </div>
                <div className="featured-creator-stat">
                  <strong>{candidates.length}</strong>
                  <span>Eligible</span>
                </div>
              </div>
            </div>
            <Form method="get" className="featured-creator-search">
              <input
                name="q"
                defaultValue={query}
                aria-label="Search approved Creators"
                placeholder="Search approved Creators"
              />
              <button type="submit">Search</button>
            </Form>
          </header>

          <section className="featured-creator-card">
            <div className="featured-creator-card__header">
              <div>
                <span className="featured-creator-card__label">Storefront lineup</span>
                <h2>Featured Creators</h2>
                <p>Arrange the exact order customers see in the featured row.</p>
              </div>
              <span className="featured-creator-count">{selected.length} / 24 selected</span>
            </div>
            <Form method="post">
              <input
                type="hidden"
                name="creatorIds"
                value={JSON.stringify(selected.map((creator) => creator.id))}
              />
              {selected.length ? (
                <ol className="featured-creator-list">
                  {selected.map((creator, index) => (
                    <li key={creator.id}>
                      <span className="featured-creator-order" aria-label={`Position ${index + 1}`}>
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <CreatorIdentity creator={creator} />
                      <span className="featured-creator-actions">
                        <button
                          type="button"
                          aria-label={`Move up ${creator.displayName}`}
                          disabled={index === 0}
                          onClick={() => moveCreator(index, -1)}
                        >
                          ↑ Up
                        </button>
                        <button
                          type="button"
                          aria-label={`Move down ${creator.displayName}`}
                          disabled={index === selected.length - 1}
                          onClick={() => moveCreator(index, 1)}
                        >
                          ↓ Down
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove ${creator.displayName}`}
                          onClick={() => setSelected((current) => current.filter((item) => item.id !== creator.id))}
                        >
                          Remove
                        </button>
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="featured-creator-empty">
                  No Featured Creators selected. Add approved Creators from the list below.
                </p>
              )}
              {actionData ? (
                <p className={`featured-creator-notice featured-creator-notice--${actionData.ok ? "success" : "error"}`} role="status">
                  {actionData.message}
                </p>
              ) : null}
              <div className="featured-creator-savebar">
                <span>Changes appear on the storefront after you save.</span>
                <button className="featured-creator-save" type="submit">
                  Save featured lineup
                </button>
              </div>
            </Form>
          </section>

          <section className="featured-creator-card">
            <div className="featured-creator-card__header">
              <div>
                <span className="featured-creator-card__label">Creator directory</span>
                <h2>Approved Creators</h2>
                <p>Add eligible Creators with an active collection and published work.</p>
              </div>
            </div>
            {candidates.length ? (
              <div className="featured-creator-candidates">
                {candidates.map((creator) => (
                  <div
                    className={`featured-creator-candidate${selectedIds.has(creator.id) ? " is-selected" : ""}`}
                    key={creator.id}
                  >
                    <CreatorIdentity creator={creator} />
                    <button
                      type="button"
                      disabled={selectedIds.has(creator.id)}
                      onClick={() => addCreator(creator)}
                    >
                      {selectedIds.has(creator.id) ? "Added" : "+ Add creator"}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="featured-creator-empty">No eligible Creators match this search.</p>
            )}
          </section>
        </div>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return <SafeAdminError heading="Creator Content settings unavailable" />;
}
