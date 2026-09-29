import { packageProject } from "../../vitest.shared.js";

// Every test runs under Node; one that reads a page parses it with jsdom (test/pages.ts).
export default packageProject("browser");
