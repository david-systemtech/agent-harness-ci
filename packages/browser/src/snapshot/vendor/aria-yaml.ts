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

import type { AriaNodeJSON, AriaSnapshotJSON } from "./aria-types.js";

// Vendored from Playwright (https://github.com/microsoft/playwright) at commit
// 1b025d7e20a026371cd5f98ba0cdce48892737c8 (v1.63.0): packages/isomorphic/ariaSnapshotRenderer.ts
// and packages/isomorphic/yaml.ts, under the Apache License 2.0 above, whose text is LICENSE beside
// this file, with Playwright's NOTICE. Changed for agent-harness: the rendering of a snapshot as
// read, without the conversion of strings to regular expressions that writing an assertion uses, and
// without boxes; it runs in the driver over the tree the page answered, after the serialiser's
// filter, focus, depth and redaction (../serialiser.ts).

/** The snapshot as Playwright writes it for a model: one element a line, its role, name, states and ref, its text after a colon. */
export function renderAriaSnapshotAsYaml(snapshot: AriaSnapshotJSON): string {
  const lines: string[] = [];

  const visitText = (text: string, depth: number) => {
    const escaped = yamlEscapeValueIfNeeded(text);
    if (escaped)
      lines.push(indent(depth) + '- text: ' + escaped);
  };

  const createKey = (node: AriaNodeJSON): string => {
    let key: string = node.role;
    // Yaml has a limit of 1024 characters per key, and we leave some space for role and attributes.
    if (node.name && node.name.length <= 900) {
      const name = node.name;
      const stringifiedName = name.startsWith('/') && name.endsWith('/') ? name : JSON.stringify(name);
      key += ' ' + stringifiedName;
    }
    if (node.checked === 'mixed')
      key += ` [checked=mixed]`;
    if (node.checked === true)
      key += ` [checked]`;
    if (node.disabled)
      key += ` [disabled]`;
    if (node.expanded)
      key += ` [expanded]`;
    if (node.active)
      key += ` [active]`;
    if (node.invalid === 'grammar' || node.invalid === 'spelling')
      key += ` [invalid=${node.invalid}]`;
    if (node.invalid === true)
      key += ` [invalid]`;
    if (node.level)
      key += ` [level=${node.level}]`;
    if (node.pressed === 'mixed')
      key += ` [pressed=mixed]`;
    if (node.pressed === true)
      key += ` [pressed]`;
    if (node.selected === true)
      key += ` [selected]`;
    if (node.ariaHidden)
      key += ` [aria-hidden]`;
    if (node.ref) {
      key += ` [ref=${node.ref}]`;
      if (node.cursor === 'pointer')
        key += ' [cursor=pointer]';
    }
    return key;
  };

  const visit = (node: AriaNodeJSON, depth: number) => {
    if (node.role === 'text') {
      visitText(node.text || '', depth);
      return;
    }

    const escapedKey = indent(depth) + '- ' + yamlEscapeKeyIfNeeded(createKey(node));
    const props: [string, string][] = [];
    if (node.url !== undefined)
      props.push(['url', node.url]);
    if (node.placeholder !== undefined)
      props.push(['placeholder', node.placeholder]);

    if (node.text === undefined && !props.length && !node.children?.length) {
      // Leaf node without children.
      lines.push(escapedKey);
    } else if (node.text !== undefined && !props.length) {
      // Leaf node with just some text inside.
      lines.push(escapedKey + ': ' + yamlEscapeValueIfNeeded(node.text));
    } else {
      // Node with (optional) props and some children.
      lines.push(escapedKey + ':');
      for (const [name, value] of props)
        lines.push(indent(depth + 1) + '- /' + name + ': ' + yamlEscapeValueIfNeeded(value));
      if (node.text !== undefined) {
        visitText(node.text, depth + 1);
      } else {
        for (const child of node.children || []) {
          if (typeof child === 'string')
            visitText(child, depth + 1);
          else
            visit(child, depth + 1);
        }
      }
    }
  };

  for (const node of snapshot)
    visit(node, 0);
  return lines.join('\n');
}

function indent(depth: number): string {
  return '  '.repeat(depth);
}

function yamlEscapeKeyIfNeeded(str: string): string {
  if (!yamlStringNeedsQuotes(str))
    return str;
  return `'` + str.replace(/'/g, `''`) + `'`;
}

function yamlEscapeValueIfNeeded(str: string): string {
  if (!yamlStringNeedsQuotes(str))
    return str;
  // eslint-disable-next-line no-control-regex -- control characters are what it escapes
  return '"' + str.replace(/[\\"\x00-\x1f\x7f-\x9f]/g, c => {
    switch (c) {
      case '\\':
        return '\\\\';
      case '"':
        return '\\"';
      case '\b':
        return '\\b';
      case '\f':
        return '\\f';
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      default: {
        const code = c.charCodeAt(0);
        return '\\x' + code.toString(16).padStart(2, '0');
      }
    }
  }) + '"';
}

function yamlStringNeedsQuotes(str: string): boolean {
  if (str.length === 0)
    return true;

  // Strings with leading or trailing whitespace need quotes
  if (/^\s|\s$/.test(str))
    return true;

  // Strings containing control characters need quotes
  // eslint-disable-next-line no-control-regex -- control characters are what it looks for
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(str))
    return true;

  // Strings starting with '-' need quotes
  if (/^-/.test(str))
    return true;

  // Strings containing ':' or '\n' followed by a space or at the end need quotes
  if (/[\n:](\s|$)/.test(str))
    return true;

  // Strings containing '#' preceded by a space need quotes (comment indicator)
  if (/\s#/.test(str))
    return true;

  // Strings that contain line breaks need quotes
  if (/[\n\r]/.test(str))
    return true;

  // Strings starting with indicator characters or quotes need quotes
  if (/^[&*\],?!>|@"'#%]/.test(str))
    return true;

  // Strings containing special characters that could cause ambiguity
  if (/[{}`]/.test(str))
    return true;

  // YAML array starts with [
  if (/^\[/.test(str))
    return true;

  // Non-string types recognized by YAML
  if (!isNaN(Number(str)) || ['y', 'n', 'yes', 'no', 'true', 'false', 'on', 'off', 'null'].includes(str.toLowerCase()))
    return true;

  return false;
}
