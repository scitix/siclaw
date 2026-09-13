/** Shared transport/resource budgets. Remote service processing may outlive RPC. */
export const SCRIPT_STARTUP_MS = 90_000;
export const TOOL_CALLBACK_MS = 55_000;
export const NODE_CALLBACK_MS = 125_000;
export const ADMISSION_WAIT_MS = 25_000;
export const ADMISSION_LEASE_MS = 150_000;
/** Starts before admission, never reset after a slow queue or credential lookup. */
export const DISPATCH_WINDOW_MS = 100_000;
export const CLOCK_SKEW_MS = 5_000;
export const DIAGNOSTIC_CLEANUP_MS = 34_000;
