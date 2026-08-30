import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import * as Primitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export const DropdownMenu = Primitive.Root;
export const DropdownMenuTrigger = Primitive.Trigger;
export const DropdownMenuRadioGroup = Primitive.RadioGroup;
export const DropdownMenuSub = Primitive.Sub;
export const DropdownMenuLabel = ({ className, ...props }: ComponentPropsWithoutRef<typeof Primitive.Label>) => <Primitive.Label className={cn("px-2 py-1.5 text-xs font-semibold", className)} {...props} />;
export const DropdownMenuSeparator = ({ className, ...props }: ComponentPropsWithoutRef<typeof Primitive.Separator>) => <Primitive.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;

export const DropdownMenuContent = forwardRef<ElementRef<typeof Primitive.Content>, ComponentPropsWithoutRef<typeof Primitive.Content>>(({ className, sideOffset = 6, ...props }, ref) => (
  <Primitive.Portal><Primitive.Content ref={ref} sideOffset={sideOffset} className={cn("z-[80] min-w-48 rounded-xl border bg-popover p-1 text-popover-foreground shadow-xl", className)} {...props} /></Primitive.Portal>
));
DropdownMenuContent.displayName = "DropdownMenuContent";

export const DropdownMenuItem = forwardRef<ElementRef<typeof Primitive.Item>, ComponentPropsWithoutRef<typeof Primitive.Item>>(({ className, ...props }, ref) => (
  <Primitive.Item ref={ref} className={cn("flex min-h-9 select-none items-center gap-2 rounded-lg px-2.5 py-2 text-sm outline-none data-[highlighted]:bg-accent", className)} {...props} />
));
DropdownMenuItem.displayName = "DropdownMenuItem";

export const DropdownMenuCheckboxItem = forwardRef<ElementRef<typeof Primitive.CheckboxItem>, ComponentPropsWithoutRef<typeof Primitive.CheckboxItem>>(({ className, children, ...props }, ref) => (
  <Primitive.CheckboxItem ref={ref} className={cn("relative flex min-h-9 select-none items-center gap-2 rounded-lg px-2.5 py-2 pr-8 text-sm outline-none data-[highlighted]:bg-accent", className)} {...props}>
    {children}<span className="absolute right-2"><Primitive.ItemIndicator><Check className="size-4" /></Primitive.ItemIndicator></span>
  </Primitive.CheckboxItem>
));
DropdownMenuCheckboxItem.displayName = "DropdownMenuCheckboxItem";

export const DropdownMenuRadioItem = forwardRef<ElementRef<typeof Primitive.RadioItem>, ComponentPropsWithoutRef<typeof Primitive.RadioItem>>(({ className, children, ...props }, ref) => (
  <Primitive.RadioItem ref={ref} className={cn("relative flex min-h-9 select-none items-center gap-2 rounded-lg px-2.5 py-2 pr-8 text-sm outline-none data-[highlighted]:bg-accent", className)} {...props}>
    {children}<span className="absolute right-2"><Primitive.ItemIndicator><Check className="size-4" /></Primitive.ItemIndicator></span>
  </Primitive.RadioItem>
));
DropdownMenuRadioItem.displayName = "DropdownMenuRadioItem";

export const DropdownMenuSubTrigger = forwardRef<ElementRef<typeof Primitive.SubTrigger>, ComponentPropsWithoutRef<typeof Primitive.SubTrigger>>(({ className, children, ...props }, ref) => (
  <Primitive.SubTrigger ref={ref} className={cn("relative flex min-h-9 select-none items-center gap-2 rounded-lg px-2.5 py-2 pr-8 text-sm outline-none data-[highlighted]:bg-accent data-[state=open]:bg-accent", className)} {...props}>
    {children}<ChevronRight className="absolute right-2 size-4 text-muted-foreground" />
  </Primitive.SubTrigger>
));
DropdownMenuSubTrigger.displayName = "DropdownMenuSubTrigger";

export const DropdownMenuSubContent = forwardRef<ElementRef<typeof Primitive.SubContent>, ComponentPropsWithoutRef<typeof Primitive.SubContent>>(({ className, ...props }, ref) => (
  <Primitive.Portal><Primitive.SubContent ref={ref} className={cn("z-[90] min-w-36 rounded-xl border bg-popover p-1 text-popover-foreground shadow-xl", className)} {...props} /></Primitive.Portal>
));
DropdownMenuSubContent.displayName = "DropdownMenuSubContent";
