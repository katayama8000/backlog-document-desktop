// Link clicks never navigate the viewer: http(s) and mailto links open in the
// system's default app, `#…` anchors stay with the page, anything else does nothing.
import { openUrl } from "@tauri-apps/plugin-opener";

export type LinkAction = { kind: "open"; url: string } | { kind: "in-page" } | { kind: "block" };

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * What a click on a link with this `href` attribute does. The raw attribute is
 * parsed without a base, so a relative path never resolves to the app's origin.
 */
export function linkAction(href: string): LinkAction {
  if (href.startsWith("#")) return { kind: "in-page" };
  try {
    const url = new URL(href);
    if (EXTERNAL_PROTOCOLS.has(url.protocol)) return { kind: "open", url: url.href };
  } catch {}
  return { kind: "block" };
}

function onLinkClick(event: MouseEvent): void {
  // auxclick also fires for the right button, which keeps its context menu.
  if (event.button > 1) return;
  const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!link) return;
  const action = linkAction(link.getAttribute("href")!);
  if (action.kind === "in-page") return;
  event.preventDefault();
  if (action.kind === "open") void openUrl(action.url);
}

/** Capture phase, so a handler that stops propagation cannot let a link through. */
export function installLinkHandler(): void {
  document.addEventListener("click", onLinkClick, true);
  document.addEventListener("auxclick", onLinkClick, true);
}
