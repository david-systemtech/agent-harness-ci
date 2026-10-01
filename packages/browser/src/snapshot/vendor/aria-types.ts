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

// Vendored from Playwright (https://github.com/microsoft/playwright) at commit
// 1b025d7e20a026371cd5f98ba0cdce48892737c8 (v1.63.0): the types of packages/isomorphic/ariaSnapshot.ts,
// under the Apache License 2.0 above, whose text is LICENSE beside this file, with Playwright's NOTICE.
// Changed for agent-harness: the snapshot's tree types alone (the templates and the YAML parsing are
// left out, and so is the box, which nothing here renders); a node carries a field's attributes and
// an iframe's place among the frame owners.

import type { FieldAttributes } from "../../redaction.js";

// https://www.w3.org/TR/wai-aria-1.2/#role_definitions

export type AriaRole = 'alert' | 'alertdialog' | 'application' | 'article' | 'banner' | 'blockquote' | 'button' | 'caption' | 'cell' | 'checkbox' | 'code' | 'columnheader' | 'combobox' |
  'complementary' | 'contentinfo' | 'definition' | 'deletion' | 'dialog' | 'directory' | 'document' | 'emphasis' | 'feed' | 'figure' | 'form' | 'generic' | 'grid' |
  'gridcell' | 'group' | 'heading' | 'img' | 'insertion' | 'link' | 'list' | 'listbox' | 'listitem' | 'log' | 'main' | 'mark' | 'marquee' | 'math' | 'meter' | 'menu' |
  'menubar' | 'menuitem' | 'menuitemcheckbox' | 'menuitemradio' | 'navigation' | 'none' | 'note' | 'option' | 'paragraph' | 'presentation' | 'progressbar' | 'radio' | 'radiogroup' |
  'region' | 'row' | 'rowgroup' | 'rowheader' | 'scrollbar' | 'search' | 'searchbox' | 'separator' | 'slider' |
  'spinbutton' | 'status' | 'strong' | 'subscript' | 'superscript' | 'switch' | 'tab' | 'table' | 'tablist' | 'tabpanel' | 'term' | 'textbox' | 'time' | 'timer' |
  'toolbar' | 'tooltip' | 'tree' | 'treegrid' | 'treeitem';

export type AriaProps = {
  checked?: boolean | 'mixed';
  disabled?: boolean;
  expanded?: boolean;
  active?: boolean;
  invalid?: boolean | 'grammar' | 'spelling';
  level?: number;
  pressed?: boolean | 'mixed';
  selected?: boolean;
};

export type AriaBox = {
  visible: boolean;
  inline: boolean;
  cursor?: string;
};

export type AriaNode = AriaProps & {
  role: AriaRole | 'fragment' | 'iframe';
  name: string;
  ref?: string;
  children: (AriaNode | string)[];
  box: AriaBox;
  receivesPointerEvents: boolean;
  props: Record<string, string>;
  /** agent-harness: an input's, a textarea's or a select's type and `autocomplete`, for the serialiser's redaction. */
  field?: FieldAttributes;
  /** agent-harness: an iframe's place among the frame owners the snapshot met, by which its frame is stitched in. */
  frame?: number;
};

export type AriaNodeJSON = {
  role: AriaRole | 'iframe' | 'text';
  name?: string;
  checked?: true | 'mixed';
  disabled?: true;
  expanded?: true;
  active?: true;
  invalid?: true | 'grammar' | 'spelling';
  level?: number;
  pressed?: true | 'mixed';
  selected?: true;
  ariaHidden?: true;
  ref?: string;
  cursor?: 'pointer';
  url?: string;
  placeholder?: string;
  text?: string;
  children?: (AriaNodeJSON | string)[];
  /** agent-harness: as `AriaNode`'s. */
  field?: FieldAttributes;
  /** agent-harness: as `AriaNode`'s. */
  frame?: number;
};

export type AriaSnapshotJSON = AriaNodeJSON[];
