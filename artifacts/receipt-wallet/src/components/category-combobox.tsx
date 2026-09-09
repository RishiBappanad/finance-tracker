import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

// Shared category picker -- a plain <select> with all ~19+ categories (more
// once users add their own) was slow to use: everything rendered at once
// with no way to narrow it down. This wraps the same
// Popover+Command(cmdk)+Input pattern shadcn calls a "combobox", already
// available in this codebase (command.tsx, popover.tsx, the cmdk
// dependency) but not used anywhere until now -- CommandList's own
// max-h-[300px] overflow-y-auto is what makes the list scroll instead of
// dumping every option on screen, and CommandInput is the type-to-filter bar.
interface CategoryComboboxProps {
  categories: string[];
  value: string | null;
  onChange: (value: string) => void;
  placeholder?: string;
  triggerClassName?: string;
}

export function CategoryCombobox({
  categories,
  value,
  onChange,
  placeholder = "Select category",
  triggerClassName,
}: CategoryComboboxProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          size="sm"
          className={cn("justify-between font-normal text-xs", triggerClassName)}
        >
          <span className="truncate">{value || placeholder}</span>
          <ChevronsUpDown className="ml-1 h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[220px] p-0">
        <Command>
          <CommandInput placeholder="Search categories..." className="text-xs" />
          <CommandList>
            <CommandEmpty>No category found.</CommandEmpty>
            <CommandGroup>
              {categories.map((cat) => (
                <CommandItem
                  key={cat}
                  value={cat}
                  // Not using onSelect's own argument: cmdk normalizes it
                  // (lowercases for its internal search matching), which
                  // would silently break case-sensitive category names --
                  // close over the real `cat` string instead.
                  onSelect={() => {
                    onChange(cat);
                    setOpen(false);
                  }}
                  className="text-xs"
                >
                  <Check className={cn("h-3.5 w-3.5", value === cat ? "opacity-100" : "opacity-0")} />
                  {cat}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
