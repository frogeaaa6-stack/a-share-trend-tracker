export function shouldAlertOnSourceFailure(input: { completeOnly: boolean; purpose?: unknown; notifyOnSourceFailure?: unknown; rejectedSourceCount: number }) {
  return input.completeOnly === true
    && input.purpose === "scheduled"
    && input.notifyOnSourceFailure === true
    && input.rejectedSourceCount > 0;
}
