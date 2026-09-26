import type { EventEmitter } from "node:events";
import { useStdin } from "ink";
import { useEffect, useRef } from "react";

/**
 * Every key as the bytes the user's terminal sent (docs/specs/tui.md, "The
 * terminal pane": with focus, every key goes to the terminal). Ink's
 * `useInput` hands a handler the key it parsed, which loses what a shell
 * needs (a function key, Alt with an arrow, Ctrl+\ as a byte), so the pane
 * listens on the channel Ink's input parser emits each key's bytes on,
 * which `useStdin()` carries at runtime though its type does not say so
 * (Ink 7.1.1, pinned). `listener` is heard for every key, before the
 * `useInput` handlers. False when this Ink carries no such channel: the
 * caller refuses the pane rather than draw one that says it has the keys
 * while every key goes elsewhere.
 */
export const useRawInput = (listener: (bytes: string) => void): boolean => {
  const { internal_eventEmitter: emitter } = useStdin() as ReturnType<typeof useStdin> & { readonly internal_eventEmitter?: EventEmitter };
  const current = useRef(listener);
  current.current = listener;
  useEffect(() => {
    if (!emitter) return;
    const heard = (bytes: string) => current.current(bytes);
    emitter.on("input", heard);
    return () => void emitter.off("input", heard);
  }, [emitter]);
  return emitter !== undefined;
};
