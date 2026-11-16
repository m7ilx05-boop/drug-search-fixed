export const secs = (a?: string | null, b?: string | null) => {
  if (!a || !b) return null;
  const d = (Date.parse(b) - Date.parse(a)) / 1000;
  return isNaN(d) || d < 0 ? null : Math.round(d * 10) / 10;
};
