import type { StepId } from "@agent-harness/contracts";

/** The head of a step's page: its heading (§1 rule 4: the question or the purpose), the line saying why, and the "What is this?" sentences where it has them. */
export interface StepWords {
  readonly heading: string;
  readonly why: string;
  readonly what?: string;
}

/** §2's "What is this?" sentences, for the steps whose §5 section names none of its own. */
const THIS_COMPUTER = "agent-harness runs a small background service on each computer you set up. It runs your agents and keeps your sessions, even when this window is closed.";
const TAILSCALE = "Tailscale is a free app that links your own devices privately over the internet.";
const FORGE = "A forge is a website that keeps your code, like GitHub, Forgejo or Gitea.";
const TOKEN = "A token is a long password that a website makes for apps. You copy it from the site and paste it here.";
const KEY_MANAGER = "A key manager keeps passwords and keys in one safe place, like OpenBao, Doppler, 1Password or Bitwarden. Most people can skip this step.";
const MEMORY_BANK = "A memory bank is a notebook your agents keep. It is stored as a private repository on your forge, or on this computer only.";
const SKILL = "A skill is a short guide an agent can follow, like \"review this code\". A collection is a folder of skills that agent-harness keeps up to date.";
const SANDBOX = "A sandbox keeps an agent's commands inside the project folder, so they cannot change the rest of the computer.";
const ALWAYS_ASK = "The always-ask list names things an agent must always ask you about, like your SSH keys.";

/**
 * Every step page's head (docs/specs/setup-copy.md §3 "Step page" and §5):
 * the heading, the why line and the "What is this?" fold, which holds the
 * step's own §5 sentence or else §2's sentences for the words the step
 * uses. The checklist's card draws it with `StepIntro`; a step's card reads
 * it from here rather than saying it again.
 */
export const STEP_WORDS: { readonly [Id in StepId]: StepWords } = {
  account: { heading: "Sign in to Claude", why: "Your agents work through your Claude account." },
  "carry-over": {
    heading: "Bring over your past work", why: "Your old Claude Code chats and notes can come with you.",
    what: "agent-harness can copy your past Claude Code chats, notes and skills from this computer. Nothing is deleted or changed where they came from.",
  },
  "your-machines": { heading: "Use agent-harness from other devices?", why: "Reach this computer's agents from your phone or another computer.", what: `${THIS_COMPUTER} ${TAILSCALE}` },
  forges: { heading: "Connect GitHub or another forge", why: "Agents can then open pull requests and read your private code.", what: `${FORGE} ${TOKEN}` },
  "key-manager": { heading: "Use a key manager?", why: "If you keep passwords and keys in one, agents can fetch them when they need them.", what: KEY_MANAGER },
  "memory-bank": { heading: "Give your agents a notebook", why: "Agents write down what they learn, so the next session already knows it.", what: MEMORY_BANK },
  skills: { heading: "Add ready-made skills", why: "Skills are guides agents can follow, like reviewing code or writing tests.", what: SKILL },
  instructions: {
    heading: "Tell every agent how you work", why: "Instructions are notes every agent reads before it starts.",
    what: "agent-harness already tells agents about this computer: your accounts, forges and notebooks. You can add your own notes too.",
  },
  browser: {
    heading: "Let agents use your Chrome", why: "Agents can open web pages in your own Chrome, with your logins.",
    what: "agent-harness adds a small extension to Chrome. Agents work in their own tab group, and some sites are always off limits. Only Chrome works for now.",
  },
  permissions: { heading: "Choose when agents ask you", why: "This is the most any session may do without asking. A session can always ask more often.", what: `${SANDBOX} ${ALWAYS_ASK}` },
  appearance: { heading: "Choose how the window looks", why: "You can change this any time." },
};
