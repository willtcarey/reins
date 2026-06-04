import { describe, expect, test } from "bun:test";
import { ImageLightbox, computeFittedImageSize } from "../../components/image-lightbox.js";
import { templateToString } from "../helpers/lit-template.js";

describe("computeFittedImageSize", () => {
  test("fits large images within the viewport at default zoom", () => {
    expect(computeFittedImageSize({
      naturalWidth: 2000,
      naturalHeight: 1000,
      viewportWidth: 1000,
      viewportHeight: 500,
      zoom: 1,
    })).toEqual({ width: 1000, height: 500 });
  });

  test("does not upscale small images until the user zooms", () => {
    expect(computeFittedImageSize({
      naturalWidth: 400,
      naturalHeight: 200,
      viewportWidth: 1000,
      viewportHeight: 800,
      zoom: 1,
    })).toEqual({ width: 400, height: 200 });

    expect(computeFittedImageSize({
      naturalWidth: 400,
      naturalHeight: 200,
      viewportWidth: 1000,
      viewportHeight: 800,
      zoom: 2,
    })).toEqual({ width: 800, height: 400 });
  });
});

describe("ImageLightbox", () => {
  test("renders a fullscreen dialog with zoom controls when opened", () => {
    const el = new ImageLightbox();
    el.show({ src: "/images/screen.png", alt: "screen", title: "screen.png" });

    const output = templateToString(el.render());

    expect(output).toContain('role="dialog"');
    expect(output).toContain('aria-modal="true"');
    expect(output).toContain("screen.png");
    expect(output).toContain("Zoom 100%");
    expect(output).toContain("/images/screen.png");
    expect(output).toContain("screen");
    expect(output).toContain("Close image preview");
  });
});
