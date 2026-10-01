/** The pane's native controls need no global binding: Tab reaches them and Enter/Space activates them. */
const SKILLS_ACTIONS = [
  "Probe a skill repository and track selected folders",
  "Pull a source now, change its branch, pin or remove it",
  "Create or remove an own skill",
  "Change enabled and always-on choices for each account",
  "Check skill readiness again for a session",
  "Decide repository trust or revoke it",
] as const;

export const matchingSkillsActions = (query: string): readonly string[] => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return SKILLS_ACTIONS.filter((description) => words.every((word) => `skills ${description} tab shift+tab enter space`.toLowerCase().includes(word)));
};

export const SkillsKeyboardHelp = ({ query }: { readonly query: string }) => {
  const found = matchingSkillsActions(query);
  return found.length === 0 ? null : (
    <section aria-label="Skills actions" className="flex flex-col gap-2 text-sm">
      <h3 className="font-semibold">Skills actions</h3>
      <p className="text-ink-muted">
        Open Settings with Mod+, and choose Skills. Tab and Shift+Tab reach its controls; Enter activates a button, Space changes a choice, and arrow keys
        choose a session or environment. The trust question uses the same controls in the session.
      </p>
      <ul className="list-inside list-disc text-ink-muted">
        {found.map((description) => (
          <li key={description}>{description}</li>
        ))}
      </ul>
    </section>
  );
};
