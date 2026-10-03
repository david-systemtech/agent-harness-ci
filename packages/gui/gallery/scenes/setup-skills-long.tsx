import { useEffect, useState } from "react";
import type { LadderName } from "@agent-harness/theme";
import { App, type AppProps } from "../../src/app.js";
import { SkillsCard } from "../../src/skills/skills-card.js";
import { STEP_CARDS, type StepCardProps } from "../../src/setup/cards.js";
import { useChecklist } from "../../src/setup/checklist-window.js";
import type { SceneGeometry } from "../scene-registry.js";
import { prepareWorld, startWorld } from "../world.js";

/** look.md §13.2: the actual catalogue overflows; capture its bottom with navigation still visible. */
export const geometry: readonly SceneGeometry[] = [
  { selector: 'nav[aria-label="Set up steps"]', width: 280 },
  { selector: 'nav[aria-label="Set up steps"] button > span:first-child', width: 18 },
  { selector: 'footer[aria-label="Step navigation"]', height: 67 },
  { selector: 'footer[aria-label="Step navigation"] button', height: 32 },
];

const OpenSkills = () => {
  const { choose } = useChecklist();
  useEffect(() => choose("skills"), [choose]);
  return null;
};

const ScrolledSkills = (props: StepCardProps) => {
  useEffect(() => {
    let stopped = false;
    const ready = async () => {
      await document.fonts?.ready;
      if (stopped) return;
      const scroll = document.querySelector<HTMLElement>("[data-setup-scroll]");
      if (scroll === null) throw new Error("The Skills card has no scrolling region.");
      const footer = document.querySelector<HTMLElement>('footer[aria-label="Step navigation"]');
      if (footer === null || scroll.contains(footer)) throw new Error("Step navigation must stay outside scrolling content.");
      const before = footer.getBoundingClientRect();
      scroll.scrollTop = scroll.scrollHeight;
      const after = footer.getBoundingClientRect();
      // jsdom has no layout; the hosted capture proves actual scrolling and viewport geometry.
      if (scroll.clientHeight > 0 && (scroll.scrollTop === 0 || after.bottom > window.innerHeight || after.top !== before.top)) {
        throw new Error("The long Skills card must scroll while its footer stays visible.");
      }
      document.getElementById("root")?.setAttribute("data-gallery-ready", "setup-skills-long");
    };
    void ready();
    return () => { stopped = true; };
  }, []);
  return <SkillsCard {...props} />;
};
const cards = { ...STEP_CARDS, account: OpenSkills, skills: ScrolledSkills };

export default function SetupSkillsLong({ ladder }: { readonly ladder: LadderName }) {
  const [app, setApp] = useState<AppProps>();
  useEffect(() => {
    let stopped = false;
    let dispose: (() => Promise<void>) | undefined;
    // The component scene mounts asynchronously; ready means its real card has scrolled.
    queueMicrotask(() => document.getElementById("root")?.removeAttribute("data-gallery-ready"));
    void (async () => {
      const prepared = await prepareWorld({ environments: [{ name: "desk", reach: "local", accounts: [{ label: "personal" }] }] }, { firstLaunch: true, presentation: { lightOrDark: ladder } });
      prepared.world.environment("desk").wire.answer("trust.list", () => ({ result: { trusted: [], declined: [] } }));
      const world = await startWorld(prepared, prepared.paired);
      dispose = async () => {
        world.stopFollowing();
        await world.presentation.close();
        await world.runtime.close();
      };
      if (stopped) { await dispose(); return; }
      setApp({ ...world, clock: prepared.clock, shell: prepared.shell, version: prepared.version, macOS: prepared.macOS, stepCards: cards });
    })();
    return () => { stopped = true; void dispose?.(); };
  }, [ladder]);
  return app === undefined ? null : <App {...app} />;
}
