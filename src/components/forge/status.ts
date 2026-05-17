import type { RuntimeStatus } from "@/lib/runtime/types";

export function statusClass(status: RuntimeStatus) {
  switch (status) {
    case "running":
    case "ready":
      return "border-sky-400/40 bg-sky-400/10 text-sky-200";
    case "blocked":
    case "failed":
      return "border-rose-400/40 bg-rose-400/10 text-rose-200";
    case "reviewing":
    case "planning":
      return "border-amber-400/40 bg-amber-400/10 text-amber-200";
    case "completed":
      return "border-emerald-400/40 bg-emerald-400/10 text-emerald-200";
    default:
      return "border-slate-500/30 bg-slate-500/10 text-slate-300";
  }
}

export function severityClass(severity: "info" | "success" | "warning" | "error") {
  switch (severity) {
    case "success":
      return "text-emerald-200";
    case "warning":
      return "text-amber-200";
    case "error":
      return "text-rose-200";
    default:
      return "text-sky-200";
  }
}
