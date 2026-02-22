import React from "react";
import { Button } from "./button";
import { HelpCircle, Mail, Bug } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { cn } from "../lib/utils";

interface SupportDropdownProps {
  className?: string;
}

const openExternal = async (url: string) => {
  try {
    const result = await window.electronAPI?.openExternal(url);
    if (!result?.success) {
      console.error("Failed to open URL:", result?.error);
    }
  } catch (error) {
    console.error("Error opening URL:", error);
  }
};

export default function SupportDropdown({ className }: SupportDropdownProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "text-foreground/70 hover:text-foreground hover:bg-foreground/10",
            className
          )}
        >
          <HelpCircle size={16} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={async () => {
            const result = await window.electronAPI?.openExternal("mailto:moonlitpoet@proton.me");
            if (!result?.success) {
              openExternal("https://mail.google.com/mail/?view=cm&to=moonlitpoet@proton.me");
            }
          }}
        >
          <Mail className="mr-2 h-4 w-4" />
          Contact Support
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => openExternal("https://github.com/GravityPoet/ChordVox/issues")}
        >
          <Bug className="mr-2 h-4 w-4" />
          Submit Bug
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
