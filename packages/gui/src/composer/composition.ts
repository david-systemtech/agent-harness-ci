import { useRef, type KeyboardEvent } from "react";

/** Some mobile input methods commit with Enter before isComposing becomes true. */
export const useComposition = () => {
  const composing = useRef(false);
  return {
    composing,
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: () => { composing.current = false; },
    onKeyDownCapture: (event: KeyboardEvent) => {
      if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) event.stopPropagation();
    },
  };
};
