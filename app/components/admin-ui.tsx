import { useNavigation, useRouteError } from "react-router";
import { useEffect } from "react";
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

const ADMIN_DETAILS_POPUP_SELECTOR = [
  "details.admin-notification-menu",
  "details.creator-more-menu",
  "details.creator-pending-reject-menu",
  "details.creator-delete-menu",
].join(", ");

function closeAdminDetailsPopups(except?: HTMLDetailsElement | null) {
  document
    .querySelectorAll<HTMLDetailsElement>(`${ADMIN_DETAILS_POPUP_SELECTOR}[open]`)
    .forEach((details) => {
      if (details !== except) {
        details.open = false;
      }
    });
}

export function AdminStyles() {
  useEffect(() => {
    function openPopupFromTarget(target: EventTarget | null) {
      if (!(target instanceof Element)) return null;
      return target.closest<HTMLDetailsElement>(ADMIN_DETAILS_POPUP_SELECTOR);
    }

    function handlePointerDown(event: PointerEvent) {
      const activePopup = openPopupFromTarget(event.target);
      closeAdminDetailsPopups(activePopup);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      closeAdminDetailsPopups();
    }

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

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
