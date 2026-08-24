import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none w-fit",
  {
    variants: {
      variant: {
        neutral: "bg-bg-subtle text-text-secondary border-border-subtle",
        brand: "bg-brand-subtle text-brand border-transparent",
        positive: "bg-positive-subtle text-positive border-transparent",
        negative: "bg-negative-subtle text-negative border-transparent",
        warning: "bg-warning-subtle text-warning border-transparent",
        info: "bg-info-subtle text-info border-transparent",
        outline: "bg-transparent text-text-secondary border-border",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  dot?: boolean;
}

export function Badge({ className, variant, dot, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot && (
        <span
          className={cn(
            "size-1.5 rounded-full",
            variant === "positive" && "bg-positive",
            variant === "negative" && "bg-negative",
            variant === "warning" && "bg-warning",
            variant === "info" && "bg-info",
            variant === "brand" && "bg-brand",
            (!variant || variant === "neutral" || variant === "outline") && "bg-text-tertiary",
          )}
        />
      )}
      {children}
    </span>
  );
}
