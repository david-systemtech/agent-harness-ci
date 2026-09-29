import { packageProject } from "../../vitest.shared.js";

// The tests that read a page parse it in jsdom (`@vitest-environment jsdom`); the rest run under Node.
export default packageProject("browser");
