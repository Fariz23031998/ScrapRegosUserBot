import { useLayoutEffect, type RefObject } from "react";

export function useStickyOffsetVar(
  elementRef: RefObject<HTMLElement | null>,
  cssVar = "--table-sticky-top",
) {
  useLayoutEffect(() => {
    const el = elementRef.current;
    if (!el) return;
    const header: HTMLElement = el;
    const target = (header.closest(".card") as HTMLElement | null) ?? document.documentElement;

    function apply() {
      target.style.setProperty(cssVar, `${header.offsetHeight}px`);
    }

    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(header);
    return () => {
      observer.disconnect();
      target.style.removeProperty(cssVar);
    };
  }, [cssVar, elementRef]);
}
