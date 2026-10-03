import "../src/styles.css";
import { mountGallery } from "./mount.js";

const container = document.getElementById("root");
if (container === null) throw new Error("The gallery has no #root.");
const scene = new URL(window.location.href).searchParams.get("scene") ?? "window-empty";
await mountGallery(container, scene);
