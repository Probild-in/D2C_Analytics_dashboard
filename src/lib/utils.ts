import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const inrFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

export function formatCurrency(value: number) {
  return inrFormatter.format(value);
}

// Hand-rolled Indian numbering (K / Lakh / Crore) — Intl's compact notation
// abbreviations for en-IN are inconsistent across browser ICU builds, so we
// format the units ourselves to match the ₹X.XL / ₹X.XCr convention used
// throughout Indian D2C reporting.
export function formatCurrencyCompact(value: number) {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1e7) return `${sign}₹${trimZero(abs / 1e7)}Cr`;
  if (abs >= 1e5) return `${sign}₹${trimZero(abs / 1e5)}L`;
  if (abs >= 1e3) return `${sign}₹${trimZero(abs / 1e3)}K`;
  return `${sign}₹${Math.round(abs)}`;
}

function trimZero(value: number) {
  return value.toFixed(value < 10 ? 2 : value < 100 ? 1 : 0);
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat("en-IN").format(value);
}

// International K/M/B compact notation — used for ad-platform counts
// (impressions, reach) to match Meta/Google Ads Manager conventions.
export function formatCompact(value: number) {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${sign}${trimZero(abs / 1e9)}B`;
  if (abs >= 1e6) return `${sign}${trimZero(abs / 1e6)}M`;
  if (abs >= 1e3) return `${sign}${trimZero(abs / 1e3)}K`;
  return `${sign}${Math.round(abs)}`;
}

export function formatPercent(value: number, digits = 1) {
  return `${value.toFixed(digits)}%`;
}

export function formatSigned(value: number, digits = 1) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}
