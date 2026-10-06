import { Monitor, Moon, Sun } from "lucide-react";
import { RadioGroup as Radio } from "radix-ui";
import { LIGHT_OR_DARK } from "../presentation.js";
import { Tooltip } from "../ui/index.js";
import { usePresentation } from "../window-context.js";

const CHOICES = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
] as const;

/** The client's ladder preference, with radio arrows and the OS-following System choice (look §9.1). */
export const ThemeToggle = () => {
  const [value, setValue] = usePresentation("lightOrDark");
  return <Radio.Root aria-label="Theme" orientation="horizontal" value={value} onValueChange={(next) => {
    const choice = LIGHT_OR_DARK.find((choice) => choice === next);
    if (choice !== undefined) setValue(choice);
  }} className="flex shrink-0 gap-0.5 rounded-md border border-hairline bg-inset p-0.5">
    {CHOICES.map(({ value, label, Icon }) => <Tooltip key={value} content={`${label} theme · ←/→`}>
      <Radio.Item value={value} aria-label={label} className="flex size-6 items-center justify-center rounded-sm border border-transparent text-ink-faint outline-none hover:bg-raised hover:text-ink-muted focus-visible:ring-2 focus-visible:ring-beam/50 aria-checked:border-beam/30 aria-checked:bg-beam/10 aria-checked:text-beam-text">
        <Icon aria-hidden="true" className="size-3.5" />
      </Radio.Item>
    </Tooltip>)}
  </Radio.Root>;
};
