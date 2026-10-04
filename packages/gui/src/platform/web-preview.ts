import type { WebModule } from "./web-registrations.js";

/** Preview is rendered by its retained pane; the web slot needs no background service. */
export const webModule: WebModule = { slot: "preview", registration: {} };

/**
 * A static HTML/SVG snapshot in an opaque, scriptless srcdoc frame. CSP is
 * installed before untrusted markup. Sanitising navigation closes the gap
 * left by CSP's resource directives (which do not block frame navigation).
 * This is deliberately separate from the desktop's active preview grant.
 */
export const webPreview = (text: string): string => {
  const doc = new DOMParser().parseFromString(text, "text/html");
  for (const element of doc.querySelectorAll("script, noscript, iframe, frame, frameset, object, embed, applet, link, meta, base, form, template, foreignObject, animate, animateMotion, animateTransform, set")) element.remove();
  for (const element of doc.querySelectorAll("*")) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || ["href", "xlink:href", "src", "srcset", "action", "formaction", "ping", "target", "background", "poster"].includes(name)) element.removeAttribute(attribute.name);
    }
  }
  const policy = doc.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
  doc.head.prepend(policy);
  return `<!doctype html>${doc.documentElement.outerHTML}`;
};
