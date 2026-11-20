import { useEffect } from "react";

import { useCartActions } from "~/lib/cart";

export function CartFocusRefresh() {
  const { refresh } = useCartActions();

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => document.removeEventListener("visibilitychange", refreshIfVisible);
  }, [refresh]);

  return null;
}
