/**
 * The titled panels down the right: remember which ones are folded, and keep
 * the buttons in their headers (Reset, Zero) from folding the panel too.
 */
export function setupPanels(): void {
  let closed = new Set<string>();
  try {
    closed = new Set(JSON.parse(localStorage.getItem("ui:closedPanels") ?? "[]") as string[]);
  } catch {
    // Only a convenience.
  }
  for (const panel of document.querySelectorAll<HTMLDetailsElement>("details.panel[data-panel]")) {
    const name = panel.dataset.panel!;
    if (closed.has(name)) panel.open = false;
    panel.addEventListener("toggle", () => {
      if (panel.open) closed.delete(name);
      else closed.add(name);
      try {
        localStorage.setItem("ui:closedPanels", JSON.stringify([...closed]));
      } catch {
        // Only a convenience.
      }
    });
    for (const b of panel.querySelectorAll<HTMLButtonElement>(".panel-head button")) {
      b.addEventListener("click", (e) => {
        e.preventDefault();
        b.blur();
      });
    }
  }
}
