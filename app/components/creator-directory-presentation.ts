type CreatorDirectoryStatus = "PENDING" | "APPROVED" | "REJECTED" | "SUSPENDED";

export function creatorRowPresentation(status: CreatorDirectoryStatus) {
  const isPending = status === "PENDING";

  return {
    rowClassName: isPending ? "creator-row--pending" : undefined,
    actionGroupClassName: isPending
      ? "creator-action-group creator-action-group--pending-summary"
      : "creator-action-group",
    primaryActionLabel: isPending ? "Review application" : "View",
    showPendingReviewPanel: isPending,
    showInlineActions: !isPending,
  } as const;
}
