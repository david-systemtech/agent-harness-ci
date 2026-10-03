import { Slider as RadixSlider } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "./classes.js";

/** Each thumb shares the control's name; a range may supply a name for each thumb. */
export const Slider = ({ className, value, min = 0, defaultValue = [min], thumbLabels, "aria-label": label, "aria-labelledby": labelledBy, ...props }: ComponentProps<typeof RadixSlider.Root> & { readonly thumbLabels?: readonly string[] }) => (
  <RadixSlider.Root className={cn("relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50 data-[orientation=vertical]:h-44 data-[orientation=vertical]:w-4 data-[orientation=vertical]:flex-col", className)} {...(value === undefined ? {} : { value })} defaultValue={defaultValue} min={min} {...props}>
    <RadixSlider.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-wash-strong data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1">
      <RadixSlider.Range className="absolute h-full bg-beam data-[orientation=vertical]:w-full" />
    </RadixSlider.Track>
    {(value ?? defaultValue).map((_, index) => <RadixSlider.Thumb key={index} aria-label={thumbLabels?.[index] ?? label} aria-labelledby={labelledBy} className="block size-3.5 rounded-full border border-beam bg-panel outline-none hover:ring-3 hover:ring-beam/30 focus-visible:ring-3 focus-visible:ring-beam/50" />)}
  </RadixSlider.Root>
);
