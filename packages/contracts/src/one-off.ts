/** Bounds and output collection for commands run through terminals.run (#265). */
export const ONE_OFF_MAX_CHARS = 256 * 1024;

/** A one-off's stdin is closed; tell pagers to print as well. */
export const NO_PAGERS: Readonly<Record<string, string>> = { PAGER: "cat", GIT_PAGER: "cat", MANPAGER: "cat", SYSTEMD_PAGER: "cat" };

/** Output is all the command's: no prompt, typed line or marker to discard. */
export const oneOffOutput = (max = ONE_OFF_MAX_CHARS) => {
  let text = "";
  let cut = false;
  let dropped = false;
  const take = (data: string) => {
    const room = max - text.length;
    if (data.length > room) cut = true;
    text += data.slice(0, Math.max(0, room));
  };
  return {
    take,
    reset(data: string, truncated = false) {
      text = "";
      dropped ||= truncated;
      take(data);
    },
    said: () => ({ text, cut, dropped }),
  };
};
