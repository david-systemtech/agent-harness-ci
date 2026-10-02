/** A print that cannot go on: its one line, said on standard error and in the result, and its exit (2 for selectors that cannot work together). */
export class PrintFailure extends Error {
  constructor(
    message: string,
    readonly exit: 1 | 2 = 1,
  ) {
    super(message);
  }
}
