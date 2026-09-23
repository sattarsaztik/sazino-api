export async function initTreasury() {
  console.log("[ton] treasury disabled (manual mode)");
}
export function treasuryReady() {
  return false;
}
export async function sendSaz() {
  throw new Error("TON treasury not configured");
}
export async function scanDeposits() {
  return [];
}
export function treasuryAddress() {
  return null;
}
export async function treasuryTonBalance() {
  return 0;
}
