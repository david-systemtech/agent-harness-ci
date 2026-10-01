/** Query answers for a shell this client opened, including its first snapshot (#265). */
export const terminalAnswers = (now: () => number = Date.now) => {
  let until = 0;
  let firstSnapshot = false;
  return {
    start() {
      until = now() + 1000;
      firstSnapshot = true;
    },
    take(kind: "reset" | "output", live: boolean, focused: boolean): boolean {
      const startup = now() < until;
      if (kind === "reset") {
        const answer = startup && firstSnapshot;
        firstSnapshot = false;
        return answer;
      }
      return live && (focused || startup);
    },
  };
};
