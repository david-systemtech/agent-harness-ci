/** Independent probes: a denied parent access cannot suppress the network probe. */
export const hostileHtml = `<!doctype html><h1>Receipt summary</h1><p>Totals are checked in integer cents.</p>
<script>document.documentElement.dataset.previewScriptRan="yes"</script>
<script>try{parent.document.documentElement.dataset.previewParentAccess="yes"}catch{}</script>
<script>fetch("https://example.test/preview-isolation-html-network").catch(()=>{})</script>
<style>body{background-image:url("https://example.test/preview-isolation-html-style")}</style>
<img hidden src="https://example.test/preview-isolation-html-image">
<form action="https://example.test/preview-isolation-html-form"><input></form>`;

export const hostileSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" onload="document.documentElement.dataset.previewScriptRan='yes'">
<circle cx="32" cy="32" r="16"/>
<script>document.documentElement.dataset.previewScriptRan="yes"</script>
<script>try{parent.document.documentElement.dataset.previewParentAccess="yes"}catch{}</script>
<script>fetch("https://example.test/preview-isolation-svg-network").catch(()=>{})</script>
<style>svg{background-image:url("https://example.test/preview-isolation-svg-style")}</style>
<image href="https://example.test/preview-isolation-svg-image" width="1" height="1"/>
</svg>`;
