/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type * as aria from "./aria-types.js";
import type { DomUtils } from "./dom-utils.js";
import type { RoleUtils } from "./role-utils.js";

// Vendored from Playwright (https://github.com/microsoft/playwright) at commit
// 1b025d7e20a026371cd5f98ba0cdce48892737c8 (v1.63.0): packages/injected/src/ariaSnapshot.ts and
// packages/injected/src/ariaSnapshotDistiller.ts, with normalizeWhiteSpace and truncateDataUrl of
// packages/isomorphic/stringUtils.ts and hasPointerCursor of packages/isomorphic/ariaSnapshot.ts,
// under the Apache License 2.0 above, whose text is LICENSE beside this file, with Playwright's NOTICE.
// Changed for agent-harness: the modules are one function, given the DOM helpers, the role
// utilities and the value of a field that is never read, that returns the tree's generation and its
// rendering as JSON, so the snapshot runs from its source text in a page's isolated world
// (../in-page.ts). Only the `ai` mode is kept (no template matching, no boxes, no other mode), and
// its depth is the serialiser's (../serialiser.ts). A field that is never read (a password, a card
// detail, a one-time code) shows its marker in place of its value, a select's options included,
// and every field carries its type and `autocomplete` for the serialiser, which redacts whatever the
// page reports. An iframe carries its place among the frame owners the walk met, by which the driver
// stitches its frame in. The ref counter can be moved on, so a frame's next document never reuses a
// ref its last one gave. The distiller keeps names that repeat content shown below them (its
// `removeRedundantNames` is left out), since the interactive filter may leave that content out.

/**
 * Playwright's aria snapshot in its `ai` mode: the tree of a document's
 * elements with their roles, names and states, walked through open shadow
 * roots and slotted nodes, a ref on each element that can be acted on.
 * `secretValue` answers the marker for a field whose value is never read.
 */
export function playwrightAriaSnapshot(dom: DomUtils, roleUtils: RoleUtils, secretValue: (element: Element) => string | null) {
  const { computeBox, getElementComputedStyle, isElementVisible } = dom;

  function normalizeWhiteSpace(text: string): string {
    return text.replace(/[\u200b\u00ad]/g, '').trim().replace(/\s+/g, ' ');
  }

  function truncateDataUrl(url: string): string {
    // Data URLs can carry megabytes of base64 payload, which is never useful in
    // human/AI-facing output. Keep the media type prefix for context, drop the data.
    if (!url.startsWith('data:'))
      return url;
    const comma = url.indexOf(',');
    if (comma === -1)
      return url;
    return url.slice(0, comma + 1) + '\u2026';
  }

  function hasPointerCursor(ariaNode: aria.AriaNode): boolean {
    return ariaNode.box.cursor === 'pointer';
  }

  type AriaSnapshot = {
    root: aria.AriaNode;
    info: Map<string, { element: Element, nameFromContentRefs: string[] }>;
    refs: Map<Element, string>;
    /** agent-harness: the iframes the walk met, in document order. */
    frameOwners: Element[];
  };

  type AriaRef = {
    role: string;
    name: string;
    ref: string;
  };

  let lastRef = 0;

  type AriaTreeOptions = {
    refPrefix?: string;
    /** agent-harness: the least number the next new ref takes. */
    firstRef?: number;
  };

  type InternalOptions = {
    visibility: 'aria' | 'ariaOrVisible' | 'ariaAndVisible',
    refs: 'all' | 'interactable' | 'none',
    refPrefix?: string | undefined,
    includeGenericRole?: boolean,
    renderCursorPointer?: boolean,
    renderActive?: boolean,
  };

  function toInternalOptions(options: AriaTreeOptions): InternalOptions {
    // For AI consumption.
    return {
      visibility: 'ariaOrVisible',
      refs: 'interactable',
      refPrefix: options.refPrefix,
      includeGenericRole: true,
      renderActive: true,
      renderCursorPointer: true,
    };
  }

  function generateAriaTree(rootElement: Element, publicOptions: AriaTreeOptions): AriaSnapshot {
    const options = toInternalOptions(publicOptions);
    if (publicOptions.firstRef !== undefined)
      lastRef = Math.max(lastRef, publicOptions.firstRef - 1);
    const visited = new Set<Node>();
    // For each node, the elements that contributed to its accessible name.
    const nameSourceElements = new Map<aria.AriaNode, Set<Element> | undefined>();

    const snapshot: AriaSnapshot = {
      root: { role: 'fragment', name: '', children: [], props: {}, box: computeBox(rootElement), receivesPointerEvents: true },
      info: new Map<string, { element: Element, nameFromContentRefs: string[] }>(),
      refs: new Map<Element, string>(),
      frameOwners: [],
    };
    setAriaNodeElement(snapshot.root, rootElement);

    const visit = (ariaNode: aria.AriaNode, node: Node, parentElementVisible: boolean) => {
      if (visited.has(node))
        return;
      visited.add(node);

      if (node.nodeType === Node.TEXT_NODE && node.nodeValue) {
        if (!parentElementVisible)
          return;

        const text = node.nodeValue;
        // <textarea>AAA</textarea> should not report AAA as a child of the textarea.
        if (ariaNode.role !== 'textbox' && text)
          ariaNode.children.push(node.nodeValue || '');
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE)
        return;

      const element = node as Element;
      const isElementVisibleForAria = !roleUtils.isElementHiddenForAria(element);
      let visible = isElementVisibleForAria;
      if (options.visibility === 'ariaOrVisible')
        visible = isElementVisibleForAria || isElementVisible(element);
      if (options.visibility === 'ariaAndVisible')
        visible = isElementVisibleForAria && isElementVisible(element);

      // Optimization: if we only consider aria visibility, we can skip child elements because
      // they will not be visible for aria as well.
      if (options.visibility === 'aria' && !visible)
        return;

      const ariaChildren: Element[] = [];
      if (element.hasAttribute('aria-owns')) {
        const ids = (element.getAttribute('aria-owns') as string).split(/\s+/);
        for (const id of ids) {
          const ownedElement = rootElement.ownerDocument.getElementById(id);
          if (ownedElement)
            ariaChildren.push(ownedElement);
        }
      }

      const childAriaNode = visible ? toAriaNode(element, options, nameSourceElements) : null;
      if (childAriaNode && element.getAttribute('aria-hidden')?.toLowerCase() === 'true')
        childAriaNode.props['aria-hidden'] = 'true';
      let elementInfo: { element: Element, nameFromContentRefs: string[] } | undefined;
      if (childAriaNode) {
        if (childAriaNode.ref) {
          elementInfo = { element, nameFromContentRefs: [] };
          snapshot.info.set(childAriaNode.ref, elementInfo);
          snapshot.refs.set(element, childAriaNode.ref);
        }
        if (childAriaNode.role === 'iframe')
          childAriaNode.frame = snapshot.frameOwners.push(element) - 1;
        ariaNode.children.push(childAriaNode);
      }
      processElement(childAriaNode || ariaNode, element, ariaChildren, visible);

      // agent-harness: a field whose value is never read shows its marker alone: a select's options are its value.
      const secret = childAriaNode ? secretValue(element) : null;
      if (childAriaNode && secret !== null)
        childAriaNode.children = [secret];

      // Now that the subtree is processed, every descendant that contributed to this node's
      // accessible name has its ref assigned, so we can resolve those refs as the name's origins.
      if (elementInfo && childAriaNode) {
        for (const contributor of nameSourceElements.get(childAriaNode) || []) {
          const ref = snapshot.refs.get(contributor);
          if (ref && ref !== childAriaNode.ref)
            elementInfo.nameFromContentRefs.push(ref);
        }
      }
    };

    function processElement(ariaNode: aria.AriaNode, element: Element, ariaChildren: Element[], parentElementVisible: boolean) {
      // Surround every element with spaces for the sake of concatenated text nodes.
      const display = getElementComputedStyle(element)?.display || 'inline';
      const treatAsBlock = (display !== 'inline' || element.nodeName === 'BR') ? ' ' : '';
      if (treatAsBlock)
        ariaNode.children.push(treatAsBlock);

      ariaNode.children.push(roleUtils.getCSSContent(element, '::before') || '');
      const assignedNodes = element.nodeName === 'SLOT' ? (element as HTMLSlotElement).assignedNodes() : [];
      if (assignedNodes.length) {
        for (const child of assignedNodes)
          visit(ariaNode, child, parentElementVisible);
      } else {
        for (let child = element.firstChild; child; child = child.nextSibling) {
          if (!(child as Element | Text).assignedSlot)
            visit(ariaNode, child, parentElementVisible);
        }
        if (element.shadowRoot) {
          for (let child = element.shadowRoot.firstChild; child; child = child.nextSibling)
            visit(ariaNode, child, parentElementVisible);
        }
      }

      for (const child of ariaChildren)
        visit(ariaNode, child, parentElementVisible);

      ariaNode.children.push(roleUtils.getCSSContent(element, '::after') || '');

      if (treatAsBlock)
        ariaNode.children.push(treatAsBlock);

      if (ariaNode.children.length === 1 && ariaNode.name === ariaNode.children[0])
        ariaNode.children = [];

      if (ariaNode.role === 'link' && element.hasAttribute('href')) {
        const href = element.getAttribute('href') as string;
        ariaNode.props['url'] = truncateDataUrl(href);
      }

      if (ariaNode.role === 'textbox' && element.hasAttribute('placeholder') && element.getAttribute('placeholder') !== ariaNode.name) {
        const placeholder = element.getAttribute('placeholder') as string;
        ariaNode.props['placeholder'] = placeholder;
      }
    }

    roleUtils.beginAriaCaches();
    try {
      visit(snapshot.root, rootElement, true);
    } finally {
      roleUtils.endAriaCaches();
    }

    distillAriaSnapshot(snapshot);
    return snapshot;
  }

  function computeAriaRef(ariaNode: aria.AriaNode, options: InternalOptions) {
    if (options.refs === 'none')
      return;
    if (options.refs === 'interactable' && (!ariaNode.box.visible || !ariaNode.receivesPointerEvents))
      return;

    const element = ariaNodeElement(ariaNode) as Element & { _ariaRef?: AriaRef };
    let ariaRef = element._ariaRef;
    if (!ariaRef || ariaRef.role !== ariaNode.role || ariaRef.name !== ariaNode.name) {
      ariaRef = { role: ariaNode.role, name: ariaNode.name, ref: (options.refPrefix ?? '') + 'e' + (++lastRef) };
      element._ariaRef = ariaRef;
    }
    ariaNode.ref = ariaRef.ref;
  }

  function toAriaNode(element: Element, options: InternalOptions, nameSourceElements: Map<aria.AriaNode, Set<Element> | undefined>): aria.AriaNode | null {
    const active = element.ownerDocument.activeElement === element && element.ownerDocument.hasFocus();
    if (element.nodeName === 'IFRAME' || element.nodeName === 'FRAME') {
      const ariaNode: aria.AriaNode = {
        role: 'iframe',
        name: '',
        children: [],
        props: {},
        box: computeBox(element),
        receivesPointerEvents: true,
        active
      };
      setAriaNodeElement(ariaNode, element);
      computeAriaRef(ariaNode, options);
      return ariaNode;
    }

    const defaultRole = options.includeGenericRole ? 'generic' : null;
    const role = roleUtils.getAriaRole(element) ?? defaultRole;
    if (!role || role === 'presentation' || role === 'none')
      return null;

    const name = roleUtils.getElementAccessibleName(element, false);
    const receivesPointerEvents = roleUtils.receivesPointerEvents(element);

    const box = computeBox(element);
    if (role === 'generic' && box.inline && element.childNodes.length === 1 && element.childNodes[0]?.nodeType === Node.TEXT_NODE)
      return null;

    const result: aria.AriaNode = {
      role,
      name: normalizeWhiteSpace(name.text),
      children: [],
      props: {},
      box,
      receivesPointerEvents,
      active
    };
    setAriaNodeElement(result, element);
    nameSourceElements.set(result, name.elements);
    computeAriaRef(result, options);

    if (roleUtils.kAriaCheckedRoles.includes(role))
      result.checked = roleUtils.getAriaChecked(element);

    if (roleUtils.kAriaDisabledRoles.includes(role))
      result.disabled = roleUtils.getAriaDisabled(element);

    if (roleUtils.kAriaExpandedRoles.includes(role)) {
      const expanded = roleUtils.getAriaExpanded(element);
      if (expanded !== undefined)
        result.expanded = expanded;
    }

    if (roleUtils.kAriaInvalidRoles.includes(role)) {
      const invalid = roleUtils.getAriaInvalid(element);
      result.invalid = invalid === 'false' ? false : invalid === 'true' ? true : invalid;
    }

    if (roleUtils.kAriaLevelRoles.includes(role))
      result.level = roleUtils.getAriaLevel(element);

    if (roleUtils.kAriaPressedRoles.includes(role))
      result.pressed = roleUtils.getAriaPressed(element);

    if (roleUtils.kAriaSelectedRoles.includes(role))
      result.selected = roleUtils.getAriaSelected(element);

    // agent-harness: a field's type and `autocomplete`, which the serialiser's redaction reads.
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)
      result.field = { type: element.type, autocomplete: element.getAttribute('autocomplete') };

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      // agent-harness: a field whose value is never read gives its marker, and its value is not read.
      if (element.type !== 'checkbox' && element.type !== 'radio' && element.type !== 'file')
        result.children = [secretValue(element) ?? element.value];
    }

    return result;
  }

  function renderAriaTreeAsJSON(ariaSnapshot: AriaSnapshot, publicOptions: AriaTreeOptions): aria.AriaSnapshotJSON {
    const options = toInternalOptions(publicOptions);

    const visit = (ariaNode: aria.AriaNode, renderCursorPointer: boolean): aria.AriaNodeJSON => {
      const node: aria.AriaNodeJSON = { role: ariaNode.role as aria.AriaNodeJSON['role'] };
      if (ariaNode.name)
        node.name = ariaNode.name;
      if (ariaNode.checked === 'mixed' || ariaNode.checked === true)
        node.checked = ariaNode.checked;
      if (ariaNode.disabled)
        node.disabled = true;
      if (ariaNode.expanded)
        node.expanded = true;
      if (ariaNode.active && options.renderActive)
        node.active = true;
      if (ariaNode.invalid)
        node.invalid = ariaNode.invalid;
      if (ariaNode.level)
        node.level = ariaNode.level;
      if (ariaNode.pressed === 'mixed' || ariaNode.pressed === true)
        node.pressed = ariaNode.pressed;
      if (ariaNode.selected === true)
        node.selected = true;
      if (ariaNode.ref) {
        node.ref = ariaNode.ref;
        if (renderCursorPointer && hasPointerCursor(ariaNode))
          node.cursor = 'pointer';
      }
      if (ariaNode.props.url !== undefined)
        node.url = ariaNode.props.url;
      if (ariaNode.props.placeholder !== undefined)
        node.placeholder = ariaNode.props.placeholder;
      if (ariaNode.props['aria-hidden'] !== undefined)
        node.ariaHidden = true;
      if (ariaNode.field !== undefined)
        node.field = ariaNode.field;
      if (ariaNode.frame !== undefined)
        node.frame = ariaNode.frame;

      const singleTextChild = ariaNode.children.length === 1 && typeof ariaNode.children[0] === 'string' ? ariaNode.children[0] : undefined;
      if (singleTextChild !== undefined) {
        node.text = singleTextChild;
      } else if (ariaNode.children.length) {
        const inCursorPointer = !!ariaNode.ref && renderCursorPointer && hasPointerCursor(ariaNode);
        node.children = ariaNode.children.map(child => {
          if (typeof child === 'string')
            return child;
          return visit(child, renderCursorPointer && !inCursorPointer);
        });
      }
      return node;
    };

    const json: aria.AriaSnapshotJSON = [];
    const nodesToRender = ariaSnapshot.root.role === 'fragment' ? ariaSnapshot.root.children : [ariaSnapshot.root];
    for (const nodeToRender of nodesToRender) {
      if (typeof nodeToRender === 'string')
        json.push({ role: 'text', text: nodeToRender });
      else
        json.push(visit(nodeToRender, !!options.renderCursorPointer));
    }
    return json;
  }

  const elementSymbol = Symbol('element');

  function ariaNodeElement(ariaNode: aria.AriaNode): Element {
    return (ariaNode as aria.AriaNode & { [elementSymbol]: Element })[elementSymbol];
  }

  function setAriaNodeElement(ariaNode: aria.AriaNode, element: Element) {
    (ariaNode as aria.AriaNode & { [elementSymbol]?: Element })[elementSymbol] = element;
  }

  // Distillation makes the snapshot less verbose without losing information: after the full tree is
  // built, a single traversal applies the chained plugins below, babel-style. Each plugin is a
  // visitor: `enter` runs pre-order, `exit` runs post-order after the children were traversed - and
  // possibly removed, unwrapped or inlined. Either hook can detach the node by returning 'remove'
  // (from `enter`, the subtree is then not traversed and no further hooks run for it), or replace
  // the node with its children by returning 'unwrap' (from `enter`, the hoisted children are
  // re-visited in the node's place; from `exit`, they were already traversed and are spliced in as
  // is). Plugins mutate the tree in place; `snapshot.info` and `snapshot.refs` are left intact, so
  // refs of removed nodes still resolve through the aria-ref selector engine.
  type DistillerContext = {
    snapshot: AriaSnapshot;
    // Depth of the current node; children of the root fragment are at depth 0.
    depth: number;
    // The chain of ancestors of the current node, root first. Maintained by the traversal.
    ancestors: aria.AriaNode[];
    // Content refs of the entered nodes' accessible names that are not yet represented in the
    // output.
    pendingContentRefs: Set<string>;
  };

  type DistillerPlugin = {
    name: string;
    enter?(node: aria.AriaNode, ctx: DistillerContext): 'remove' | 'unwrap' | void;
    exit?(node: aria.AriaNode, ctx: DistillerContext): 'remove' | 'unwrap' | void;
  };

  function distillAriaSnapshot(snapshot: AriaSnapshot) {
    runPlugins(snapshot, aiPlugins);
  }

  function runPlugins(snapshot: AriaSnapshot, plugins: DistillerPlugin[]) {
    const ctx: DistillerContext = { snapshot, depth: -1, ancestors: [], pendingContentRefs: new Set() };
    const traverse = (node: aria.AriaNode, depth: number) => {
      const children: (aria.AriaNode | string)[] = [];
      const visitChild = (child: aria.AriaNode | string) => {
        if (typeof child === 'string') {
          children.push(child);
          return;
        }
        ctx.depth = depth + 1;
        for (const plugin of plugins) {
          const result = plugin.enter?.(child, ctx);
          if (result === 'remove')
            return;
          if (result === 'unwrap') {
            child.children.forEach(visitChild);
            return;
          }
        }
        traverse(child, depth + 1);
        ctx.depth = depth + 1;
        for (const plugin of plugins) {
          const result = plugin.exit?.(child, ctx);
          if (result === 'remove')
            return;
          if (result === 'unwrap') {
            children.push(...child.children);
            return;
          }
        }
        children.push(child);
      };
      ctx.ancestors.push(node);
      node.children.forEach(visitChild);
      ctx.ancestors.pop();
      node.children = children;
    };
    // Hooks run on the root as well, but the root cannot be removed or unwrapped.
    for (const plugin of plugins)
      plugin.enter?.(snapshot.root, ctx);
    traverse(snapshot.root, -1);
    ctx.depth = -1;
    for (const plugin of plugins)
      plugin.exit?.(snapshot.root, ctx);
  }

  // Removing the click target root would hide an actionable element from the snapshot.
  function isClickTargetRoot(node: aria.AriaNode, ctx: DistillerContext): boolean {
    return !!node.ref && hasPointerCursor(node) && !ctx.ancestors.some(ancestor => !!ancestor.ref && hasPointerCursor(ancestor));
  }

  // The tree builder emits raw text tokens - text nodes, CSS content, block spacing markers - as
  // string children. Coalesce the adjacent ones, normalize whitespace and drop the empties, then
  // drop a lone text child that merely repeats the node's accessible name. Runs on `exit`, so the
  // merge sees the children in their final shape.
  const mergeStringChildren: DistillerPlugin = {
    name: 'mergeStringChildren',
    exit(node: aria.AriaNode) {
      const children: (aria.AriaNode | string)[] = [];
      const buffer: string[] = [];
      const flush = () => {
        if (!buffer.length)
          return;
        const text = normalizeWhiteSpace(buffer.join(''));
        if (text)
          children.push(text);
        buffer.length = 0;
      };
      for (const child of node.children) {
        if (typeof child === 'string') {
          buffer.push(child);
        } else {
          flush();
          children.push(child);
        }
      }
      flush();
      node.children = children;
      if (node.children.length === 1 && node.children[0] === node.name)
        node.children = [];
    },
  };

  // Only unwrap a generic that encloses at most one element, logical grouping still makes sense,
  // even if it is not ref-able. The decision is made on `exit` - whether the node encloses a single
  // ref-bearing child is only known after its own descendants were unwrapped - so nested wrappers
  // collapse bottom-up. A generic emptied by the other plugins is dropped, unless it is the
  // click target root, for example an icon-only button.
  const unwrapSingleChildGenerics: DistillerPlugin = {
    name: 'unwrapSingleChildGenerics',
    exit(node: aria.AriaNode, ctx: DistillerContext): 'unwrap' | void {
      if (node.role !== 'generic' || node.name || node.children.length > 1 || !node.children.every(child => typeof child !== 'string' && !!child.ref))
        return;
      if (!node.children.length && isClickTargetRoot(node, ctx))
        return;
      return 'unwrap';
    },
  };

  // A decorative image - role `img` with no accessible name and no content - carries no
  // information. The decision is made on `exit` - whether the node has content is only known after
  // `mergeStringChildren` dropped the empty text tokens. A clickable image outside of any clickable
  // container is not decorative though - e.g. a bare svg icon acting as a button - and is kept.
  const removeNamelessImages: DistillerPlugin = {
    name: 'removeNamelessImages',
    exit(node: aria.AriaNode, ctx: DistillerContext): 'remove' | void {
      if (node.role === 'img' && !node.name && !node.children.length && !isClickTargetRoot(node, ctx))
        return 'remove';
    },
  };

  // A generic whose whole content is a piece of text - a single text child, or just an accessible
  // name - that repeats the parent's accessible name adds no information, so it removes itself.
  // `inlineTextIntoGeneric` runs first, bubbling text up through nameless wrappers, so by the time
  // a wrapper exits its text faces the real parent - no need to look further up the ancestor chain.
  const removeNameRepeatingChild: DistillerPlugin = {
    name: 'removeNameRepeatingChild',
    exit(node: aria.AriaNode, ctx: DistillerContext): 'remove' | void {
      const parent = ctx.ancestors[ctx.ancestors.length - 1];
      if (!parent?.name || node.role !== 'generic' || node.active || Object.keys(node.props).length)
        return;
      const singleTextChild = node.children.length === 1 && typeof node.children[0] === 'string' ? node.children[0] : undefined;
      const text = node.name ? (node.children.length ? undefined : node.name) : singleTextChild;
      if (text && text === parent.name) {
        if (node.ref)
          ctx.pendingContentRefs.add(node.ref);
        return 'remove';
      }
    },
  };

  // A generic whose only child is a nameless leaf generic inlines that child's text:
  // `generic: - generic: "text"` becomes `generic: "text"`. Runs post-order, so chains collapse
  // bottom-up, and after the other plugins already removed or unwrapped the children.
  const inlineTextIntoGeneric: DistillerPlugin = {
    name: 'inlineTextIntoGeneric',
    exit(node: aria.AriaNode) {
      if (node.role !== 'generic' || Object.keys(node.props).length || node.children.length !== 1)
        return;
      const child = node.children[0];
      if (child === undefined || typeof child === 'string')
        return;
      if (child.role !== 'generic' || child.name || child.active || Object.keys(child.props).length)
        return;
      if (child.children.length === 1 && typeof child.children[0] === 'string')
        node.children = [child.children[0]];
    },
  };

  // The ai preset compresses the snapshot on top of normalization. It runs as one traversal. On
  // exit, text is first inlined into the node, so that `removeNameRepeatingChild` faces the real
  // parent when it compares.
  const aiPlugins: DistillerPlugin[] = [
    mergeStringChildren,
    removeNamelessImages,
    inlineTextIntoGeneric,
    removeNameRepeatingChild,
    unwrapSingleChildGenerics,
  ];

  return { generateAriaTree, renderAriaTreeAsJSON };
}

export type AriaSnapshotGenerator = ReturnType<typeof playwrightAriaSnapshot>;
