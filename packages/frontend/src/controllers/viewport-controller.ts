import type { ReactiveController, ReactiveControllerHost } from "lit";

/**
 * Owns viewport-derived app shell state and browser viewport listeners.
 */
export class ViewportController implements ReactiveController {
  isMobileLayout: boolean;
  isStandalone: boolean;

  private readonly host: ReactiveControllerHost;
  private readonly mobileLayoutQuery: MediaQueryList;
  private readonly standaloneQuery: MediaQueryList;
  private visualViewportResizeListener: (() => void) | null = null;

  constructor(host: ReactiveControllerHost) {
    this.host = host;
    this.mobileLayoutQuery = window.matchMedia("(max-width: 767px)");
    this.standaloneQuery = window.matchMedia("(display-mode: standalone)");
    this.isMobileLayout = this.mobileLayoutQuery.matches;
    this.isStandalone = this.standaloneQuery.matches
      || ("standalone" in navigator && navigator.standalone === true);
    host.addController(this);
  }

  hostConnected() {
    this.mobileLayoutQuery.addEventListener("change", this.handleMobileLayoutChange);
    this.installVisualViewportKeyboardListener();
  }

  hostDisconnected() {
    this.mobileLayoutQuery.removeEventListener("change", this.handleMobileLayoutChange);
    if (this.visualViewportResizeListener && window.visualViewport) {
      window.visualViewport.removeEventListener("resize", this.visualViewportResizeListener);
    }
    this.visualViewportResizeListener = null;
  }

  private handleMobileLayoutChange = (e: MediaQueryListEvent) => {
    this.isMobileLayout = e.matches;
    this.host.requestUpdate();
  };

  private installVisualViewportKeyboardListener() {
    if (this.visualViewportResizeListener) return;

    const vv = window.visualViewport;
    if (!vv) return;

    // Capture the initial viewport height before any keyboard appears —
    // on iOS standalone/PWA mode, both visualViewport.height and
    // window.innerHeight shrink together, so we need a fixed reference.
    const initialHeight = vv.height;
    this.visualViewportResizeListener = () => {
      const keyboardOpen = vv.height < initialHeight * 0.75;
      document.documentElement.classList.toggle("keyboard-open", keyboardOpen);
    };
    vv.addEventListener("resize", this.visualViewportResizeListener);
  }
}
