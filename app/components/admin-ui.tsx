import { useNavigation, useRouteError } from "react-router";
import type { ReactNode } from "react";

type SubmitButtonProps = {
  children: ReactNode;
  name?: string;
  value?: string;
  confirmMessage?: string;
};

export function SubmitButton({
  children,
  name,
  value,
  confirmMessage,
}: SubmitButtonProps) {
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";

  return (
    <button
      type="submit"
      name={name}
      value={value}
      disabled={submitting}
      aria-busy={submitting}
      onClick={(event) => {
        if (confirmMessage && !window.confirm(confirmMessage)) {
          event.preventDefault();
        }
      }}
    >
      {submitting ? "Working…" : children}
    </button>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const label =
    {
      PENDING: "Pending Review",
      APPROVED: "Approved",
      REJECTED: "Needs Changes",
      SUSPENDED: "Suspended",
      PUBLISHING: "Publishing",
      PUBLISHED: "Published",
      FAILED: "Failed",
      ARCHIVED: "Archived",
      REQUESTED: "Requested",
      PROCESSING: "Processing",
      PAID: "Paid",
      CANCELLED: "Cancelled",
      PENDING_VERIFICATION: "Pending Verification",
      VERIFIED: "Verified",
      DISABLED: "Disabled",
    }[status] ?? "Unknown";

  return (
    <span className={`status-badge status-badge--${status.toLowerCase()}`}>
      {label}
    </span>
  );
}

export function AdminStyles() {
  return null;
}

export function SafeAdminError({
  heading = "We could not load this page",
}: {
  heading?: string;
}) {
  useRouteError();

  return (
    <s-page heading={heading}>
      <AdminStyles />
      <s-banner tone="critical">
        We could not load this information. Please try again. If the problem
        continues, contact support with the approximate time of the error.
      </s-banner>
    </s-page>
  );
}
