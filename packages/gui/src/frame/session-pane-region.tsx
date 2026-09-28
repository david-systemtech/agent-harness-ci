/** The session pane region: one session pane, with no session open in it yet (docs/specs/gui.md, "A session pane"). */
export const SessionPaneRegion = () => (
  <main className="flex h-full min-w-0 flex-col bg-abyss">
    <section aria-label="Session pane" className="flex flex-1 items-center justify-center p-6">
      <p className="text-sm text-ink-faint">No session is open. Choose one from the sidebar.</p>
    </section>
  </main>
);
