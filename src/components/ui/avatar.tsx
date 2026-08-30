import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import * as Primitive from "@radix-ui/react-avatar";
import { cn } from "@/lib/utils";

export const Avatar = forwardRef<ElementRef<typeof Primitive.Root>, ComponentPropsWithoutRef<typeof Primitive.Root>>(({ className, ...props }, ref) => <Primitive.Root ref={ref} className={cn("inline-flex size-8 shrink-0 overflow-hidden rounded-full", className)} {...props} />);
Avatar.displayName = "Avatar";
export const AvatarFallback = forwardRef<ElementRef<typeof Primitive.Fallback>, ComponentPropsWithoutRef<typeof Primitive.Fallback>>(({ className, ...props }, ref) => <Primitive.Fallback ref={ref} className={cn("grid size-full place-items-center bg-gradient-to-br from-violet-500 to-indigo-600 text-[10px] font-bold text-white", className)} {...props} />);
AvatarFallback.displayName = "AvatarFallback";
