import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import * as Primitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export const Select = Primitive.Root;
export const SelectValue = Primitive.Value;

export const SelectTrigger = forwardRef<ElementRef<typeof Primitive.Trigger>, ComponentPropsWithoutRef<typeof Primitive.Trigger>>(({ className, children, ...props }, ref) => (
  <Primitive.Trigger ref={ref} className={cn("flex h-9 items-center justify-between gap-2 rounded-lg border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring", className)} {...props}>{children}<Primitive.Icon><ChevronDown className="size-4" /></Primitive.Icon></Primitive.Trigger>
));
SelectTrigger.displayName = "SelectTrigger";

export const SelectContent = forwardRef<ElementRef<typeof Primitive.Content>, ComponentPropsWithoutRef<typeof Primitive.Content>>(({ className, children, position = "popper", ...props }, ref) => (
  <Primitive.Portal><Primitive.Content ref={ref} position={position} className={cn("z-[90] min-w-32 overflow-hidden rounded-xl border bg-popover p-1 shadow-xl", className)} {...props}><Primitive.Viewport>{children}</Primitive.Viewport></Primitive.Content></Primitive.Portal>
));
SelectContent.displayName = "SelectContent";

export const SelectItem = forwardRef<ElementRef<typeof Primitive.Item>, ComponentPropsWithoutRef<typeof Primitive.Item>>(({ className, children, ...props }, ref) => (
  <Primitive.Item ref={ref} className={cn("relative flex min-h-9 select-none items-center rounded-lg py-2 pl-3 pr-8 text-sm outline-none data-[highlighted]:bg-accent", className)} {...props}><Primitive.ItemText>{children}</Primitive.ItemText><span className="absolute right-2"><Primitive.ItemIndicator><Check className="size-4" /></Primitive.ItemIndicator></span></Primitive.Item>
));
SelectItem.displayName = "SelectItem";
