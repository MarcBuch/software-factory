import { Moon, Sun } from "lucide-react";

import { useTheme } from "@/components/theme-provider";
import { Toggle } from "@/components/ui/toggle";

function ModeToggle() {
  const { theme, setTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <Toggle
      variant="outline"
      size="sm"
      pressed={isDark}
      aria-label={`Switch to ${isDark ? "light" : "dark"} mode`}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? <Sun /> : <Moon />}
    </Toggle>
  );
}

export { ModeToggle };
