import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Timecode } from "./Timecode";

describe("Timecode", () => {
  it("shows minutes and seconds for something shorter than an hour", () => {
    const { container } = render(<Timecode seconds={75} />);
    expect(container).toHaveTextContent("1:15");
  });

  it("shows hours whenever the media runs an hour or longer, so the shape never changes", () => {
    const { container } = render(<Timecode seconds={75} span={7305} />);
    expect(container).toHaveTextContent("0:01:15");
  });

  it("uses tabular numerals and never wraps", () => {
    const { container } = render(<Timecode seconds={2537} span={7305} />);
    expect(container.firstElementChild).toHaveClass("tabular", "whitespace-nowrap");
  });

  it("raises each colon, and only the colons", () => {
    const { container } = render(<Timecode seconds={2537} span={7305} />);
    const raised = container.querySelectorAll("span.relative");
    expect(raised).toHaveLength(2);
    for (const colon of raised) {
      expect(colon).toHaveTextContent(":");
    }
  });

  it("puts a prefix before the digits", () => {
    const { container } = render(<Timecode seconds={4768} span={7305} prefix="−" />);
    expect(container).toHaveTextContent("−1:19:28");
  });
});
