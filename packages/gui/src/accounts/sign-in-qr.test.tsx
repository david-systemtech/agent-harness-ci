import { render, screen } from "@testing-library/react";
import decoder from "jsqr";
import { expect, it } from "vitest";
import { SignInQr } from "./sign-in-qr.js";

const jsQR = decoder as unknown as typeof decoder.default;

it("encodes the unchanged provider authorisation URL in a phone-readable QR", () => {
  const url = "https://provider.example.test/oauth/authorize?state=state-for-tests&code_challenge=challenge-for-tests&redirect_uri=https%3A%2F%2Fprovider.example.test%2Fcode";
  render(<SignInQr url={url} />);
  const qr = screen.getByRole("img", { name: "QR code of the provider sign-in page" });
  const modules = Number(qr.getAttribute("viewBox")?.split(" ")[2]);
  const scale = 5;
  const size = modules * scale;
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  for (const rect of qr.querySelectorAll("rect")) {
    const x = Number(rect.getAttribute("x")) * scale;
    const y = Number(rect.getAttribute("y")) * scale;
    for (let row = y; row < y + scale; row++) for (let column = x; column < x + scale; column++) {
      const offset = (row * size + column) * 4;
      pixels[offset] = 0; pixels[offset + 1] = 0; pixels[offset + 2] = 0;
    }
  }
  expect(jsQR(pixels, size, size)?.data).toBe(url);
});

it("keeps the link fallback usable when a provider URL cannot fit in a QR", () => {
  render(<SignInQr url={`https://provider.example.test/?state=${"x".repeat(10_000)}`} />);
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText(/URL is too long for a QR/)).toBeDefined();
});
