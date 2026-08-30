"use client";

import type { CSSProperties } from "react";
import { Toaster as Sonner } from "sonner";

export function Toaster({ sidebarWidth }: { sidebarWidth: number }) {
  return <Sonner position="bottom-center" closeButton richColors style={{ "--toast-center": `calc(50% + ${sidebarWidth / 2}px)` } as CSSProperties} />;
}
