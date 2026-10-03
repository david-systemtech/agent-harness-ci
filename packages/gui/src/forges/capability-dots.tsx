import { capabilityName, capabilityStateWords } from "@agent-harness/client-runtime";
import { FORGE_CAPABILITIES, type ForgeCapabilities } from "@agent-harness/contracts";
import { StatusDot, Tooltip } from "../ui/index.js";

/** Each dot has a text equivalent; colour never carries the verdict alone. */
export const CapabilityDots = ({ capabilities }: { readonly capabilities: ForgeCapabilities }) => (
  <ul aria-label="Capabilities" className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-muted">
    {FORGE_CAPABILITIES.map((name) => {
      const capability = capabilities[name];
      const label = `${capabilityName(name)}: ${capabilityStateWords(capability)}`;
      return <li key={name}>
        <Tooltip content={label}>
          <span className="inline-flex items-center gap-1.5" tabIndex={0}>
            <StatusDot label={label} tone={capability.state === "verified" ? "success" : capability.state === "failed" ? "danger" : "neutral"} />
            {capabilityName(name)}
          </span>
        </Tooltip>
      </li>;
    })}
  </ul>
);
