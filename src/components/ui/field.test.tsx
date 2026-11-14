import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderUi } from "@/test/render";
import { Field } from "./field";

describe("Field", () => {
  it("has a visible label that names the field", () => {
    renderUi(<Field label="Name" defaultValue="Evening" />);
    const field = screen.getByRole("textbox", { name: "Name" });
    expect(field).toHaveValue("Evening");
    expect(field).not.toHaveAttribute("aria-invalid");
  });

  it("describes itself with its hint", () => {
    renderUi(<Field label="Name" hint="Saving replaces what is in it." />);
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveAccessibleDescription(
      "Saving replaces what is in it.",
    );
  });

  it("says an error in place of the hint, and marks the field", () => {
    renderUi(<Field label="Name" hint="A hint" error="Another playlist is called that." />);
    const field = screen.getByRole("textbox", { name: "Name" });
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Another playlist is called that.");
    expect(field).toHaveAccessibleDescription("Another playlist is called that.");
    expect(screen.queryByText("A hint")).not.toBeInTheDocument();
  });
});
