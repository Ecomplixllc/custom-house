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
        .featured-creator-admin{display:grid;gap:20px;max-width:1040px;margin:0 auto;padding:8px 0 28px}.featured-creator-admin__hero,.featured-creator-card{border:1px solid #d8d8dc;border-radius:16px;background:#fff;padding:22px}.featured-creator-admin__hero h1,.featured-creator-card h2{margin:0 0 8px}.featured-creator-admin__hero p,.featured-creator-card p{margin:0;color:#61636b}.featured-creator-search{display:flex;gap:10px;margin-top:18px}.featured-creator-search input{flex:1;min-width:0;height:42px;border:1px solid #8c9196;border-radius:9px;padding:0 12px}.featured-creator-search button,.featured-creator-actions button,.featured-creator-save{min-height:38px;border:1px solid #8c9196;border-radius:8px;background:#fff;padding:0 13px;font-weight:650;cursor:pointer}.featured-creator-save{border-color:#303030;background:#303030;color:#fff}.featured-creator-list{display:grid;gap:10px;margin:16px 0 0;padding:0;list-style:none}.featured-creator-list li{display:flex;align-items:center;justify-content:space-between;gap:14px;border:1px solid #e1e3e5;border-radius:12px;padding:12px}.featured-creator-identity{display:flex;align-items:center;gap:11px;min-width:0}.featured-creator-identity>span:last-child{display:grid;min-width:0}.featured-creator-identity strong,.featured-creator-identity small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.featured-creator-identity small{color:#6d7175}.featured-creator-avatar{display:grid;place-items:center;width:42px;height:42px;flex:0 0 42px;overflow:hidden;border-radius:50%;background:#f0e9ff;color:#6f2cff;font-weight:800}.featured-creator-avatar img{width:100%;height:100%;object-fit:cover}.featured-creator-actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}.featured-creator-actions button:disabled{opacity:.45;cursor:not-allowed}.featured-creator-candidates{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:16px}.featured-creator-candidate{display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid #e1e3e5;border-radius:12px;padding:12px}.featured-creator-candidate button{min-height:36px;border:0;border-radius:8px;background:#ede6ff;color:#4b19a8;padding:0 14px;font-weight:750;cursor:pointer}.featured-creator-candidate button:disabled{background:#f1f2f3;color:#8c9196}.featured-creator-notice{border-radius:9px;padding:11px 13px;font-weight:650}.featured-creator-notice--success{background:#eaf8ef;color:#176b3a}.featured-creator-notice--error{background:#fff0f0;color:#b42318}.featured-creator-empty{padding:18px 0;color:#6d7175}@media(max-width:720px){.featured-creator-candidates{grid-template-columns:1fr}.featured-creator-list li,.featured-creator-candidate{align-items:flex-start;flex-direction:column}.featured-creator-actions{justify-content:flex-start}}
      `}</style>
      <s-section>
        <div className="featured-creator-admin">
          <header className="featured-creator-admin__hero">
            <h1>Featured Creators</h1>
            <p>
              Select and order approved Creators shown on the public Creator Content page.
              Only Creators with an active collection and published product are eligible.
            </p>
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
            <h2>Selected Creators</h2>
            <p>The order below is the storefront order.</p>
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
                      <CreatorIdentity creator={creator} />
                      <span className="featured-creator-actions">
                        <button
                          type="button"
                          aria-label={`Move up ${creator.displayName}`}
                          disabled={index === 0}
                          onClick={() => moveCreator(index, -1)}
                        >
                          Move up
                        </button>
                        <button
                          type="button"
                          aria-label={`Move down ${creator.displayName}`}
                          disabled={index === selected.length - 1}
                          onClick={() => moveCreator(index, 1)}
                        >
                          Move down
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
                <p className="featured-creator-empty">No Featured Creators selected.</p>
              )}
              {actionData ? (
                <p className={`featured-creator-notice featured-creator-notice--${actionData.ok ? "success" : "error"}`} role="status">
                  {actionData.message}
                </p>
              ) : null}
              <button className="featured-creator-save" type="submit">Save ordering</button>
            </Form>
          </section>

          <section className="featured-creator-card">
            <h2>Approved Creators</h2>
            <p>Add eligible Creators to the featured list.</p>
            {candidates.length ? (
              <div className="featured-creator-candidates">
                {candidates.map((creator) => (
                  <div className="featured-creator-candidate" key={creator.id}>
                    <CreatorIdentity creator={creator} />
                    <button
                      type="button"
                      disabled={selectedIds.has(creator.id)}
                      onClick={() => addCreator(creator)}
                    >
                      {selectedIds.has(creator.id) ? "Selected" : "Add"}
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
