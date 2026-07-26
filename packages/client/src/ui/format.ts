/** 毫秒 → m:ss.mmm */
export function fmtMs(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mm = Math.floor(ms % 1000);
  return `${m}:${String(s).padStart(2, "0")}.${String(mm).padStart(3, "0")}`;
}
