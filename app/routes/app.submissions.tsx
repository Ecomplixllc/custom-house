import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import {
  AdminStyles,
  SafeAdminError,
  StatusBadge,
  SubmitButton,
} from "../components/admin-ui";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { safeJson } from "../services/domain";
import { publishSubmission } from "../services/publishing.server";
import { AdminGraphqlClient } from "../services/shopify-graphql.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  return db.designSubmission.findMany({
    where: { shop: session.shop },
    include: {
      creator: {
        select: { displayName: true },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  const id = String(form.get("id") || "").trim();
  const intent = String(form.get("intent") || "").trim();
  const reason = String(form.get("reason") || "").trim();

  if (!/^[a-z0-9]{20,40}$/i.test(id)) {
    throw new Response("Invalid submission identifier", { status: 400 });
  }
  if (reason.length > 1000) {
    throw new Response("The reason is too long", { status: 422 });
  }
  if (intent === "PUBLISH") {
    await publishSubmission(
      session.shop,
      id,
      new AdminGraphqlClient(admin),
    );
    return { ok: true };
  }
  if (intent !== "REJECTED" && intent !== "ARCHIVED") {
    throw new Response("Invalid action", { status: 400 });
  }

  await db.$transaction(async (tx) => {
    const before = await tx.designSubmission.findFirst({
      where: { id, shop: session.shop },
    });
    if (!before) {
      throw new Response("Design submission not found", { status: 404 });
    }
    if (before.status === intent) return;

    await tx.designSubmission.update({
      where: { id: before.id },
      data: {
        status: intent,
        publishError:
          intent === "REJECTED"
            ? reason || "Rejected by admin"
            : before.publishError,
        reviewedAt: new Date(),
      },
    });
    await tx.auditLog.create({
      data: {
        shop: session.shop,
        actorType: "ADMIN",
        action: `submission.${intent.toLowerCase()}`,
        entityType: "DesignSubmission",
        entityId: before.id,
        beforeJson: safeJson({ status: before.status }),
        afterJson: safeJson({ status: intent }),
      },
    });
  });
  return { ok: true };
}

export default function Submissions() {
  const rows = useLoaderData<typeof loader>();
  return (
    <s-page heading="Design submissions">
      <AdminStyles />
      <s-section>
        {rows.length ? (
          <div className="dashboard-grid">
            {rows.map((submission) => (
              <div className="dashboard-card" key={submission.id}>
                <h3>
                  {submission.designName} by {submission.creator.displayName}
                </h3>
                <p>
                  <StatusBadge status={submission.status} /> ·{" "}
                  {new Date(submission.createdAt).toLocaleString()}
                </p>
                <p>
                  <a
                    href={submission.savedDesignUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open saved design
                  </a>
                </p>
                {submission.previewUrl && (
                  <p>
                    <a
                      href={submission.previewUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open preview
                    </a>
                  </p>
                )}
                <Form method="post">
                  <input type="hidden" name="id" value={submission.id} />
                  <label className="dashboard-field">
                    Review reason
                    <input name="reason" maxLength={1000} />
                  </label>
                  <div className="dashboard-actions">
                    <SubmitButton
                      name="intent"
                      value="PUBLISH"
                      confirmMessage="Approve and publish this design? Publishing will use the existing guarded publishing workflow."
                    >
                      Approve and publish
                    </SubmitButton>
                    <SubmitButton
                      name="intent"
                      value="REJECTED"
                      confirmMessage="Reject this design submission?"
                    >
                      Reject
                    </SubmitButton>
                    <SubmitButton
                      name="intent"
                      value="ARCHIVED"
                      confirmMessage="Archive this design submission?"
                    >
                      Archive
                    </SubmitButton>
                  </div>
                </Form>
              </div>
            ))}
          </div>
        ) : (
          <div className="dashboard-empty">
            <strong>No design submissions were found.</strong>
            <span className="dashboard-muted">
              New creator submissions will appear here for review.
            </span>
          </div>
        )}
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return <SafeAdminError heading="Design submissions" />;
}
