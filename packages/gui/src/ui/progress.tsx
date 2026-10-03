import { Progress as RadixProgress } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "./classes.js";

export const Progress = ({ className, value = null, max = 100, ...props }: ComponentProps<typeof RadixProgress.Root>) => {
  const limit = Number.isFinite(max) && max > 0 ? max : 100;
  const reading = value === null || !Number.isFinite(value) ? null : Math.min(limit, Math.max(0, value));
  return <RadixProgress.Root className={cn("h-1 w-full overflow-hidden rounded-full bg-wash", className)} value={reading} max={limit} {...props}>
    <RadixProgress.Indicator className={cn("h-full bg-beam transition-transform", reading === null && "motion-safe:animate-pulse")} style={{ width: reading === null ? "100%" : `${reading / limit * 100}%` }} />
  </RadixProgress.Root>;
};
