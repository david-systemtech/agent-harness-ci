import "../src/styles.css";
import { mountGallery } from "./mount.js";

const container = document.getElementById("root");
if (container === null) throw new Error("The gallery has no #root.");
const params = new URL(window.location.href).searchParams;
const scene = params.get("scene") ?? "window-empty";
const ladder = params.get("ladder") ?? "dark";
if (ladder !== "light" && ladder !== "dark") throw new Error(`Unknown gallery ladder: ${ladder}`);
await mountGallery(container, scene, ladder);
