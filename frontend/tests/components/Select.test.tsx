import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import Select from "../../src/components/common/Select";

const options = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Bravo" },
  { value: "c", label: "Charlie" },
];

function renderSelect(props: Partial<Parameters<typeof Select>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <Select
      value="a"
      onChange={onChange}
      options={options}
      ariaLabel="Pick"
      {...props}
    />,
  );
  return {
    onChange,
    trigger: screen.getByRole("combobox", { name: "Pick" }),
  };
}

describe("Select keyboard support", () => {
  it("opens with ArrowDown, moves the highlight, and picks with Enter", () => {
    const { onChange, trigger } = renderSelect();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("listbox")).toBeTruthy();

    // Opens on the selected option (Alpha); one more step reaches Bravo.
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const activeId = trigger.getAttribute("aria-activedescendant");
    expect(activeId).toBeTruthy();
    expect(document.getElementById(activeId as string)?.textContent).toBe(
      "Bravo",
    );

    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("b");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("opens upward with ArrowUp and Home/End jump to the ends", () => {
    const { trigger } = renderSelect({ value: "b" });

    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    let activeId = trigger.getAttribute("aria-activedescendant");
    expect(document.getElementById(activeId as string)?.textContent).toBe(
      "Bravo",
    );

    fireEvent.keyDown(trigger, { key: "End" });
    activeId = trigger.getAttribute("aria-activedescendant");
    expect(document.getElementById(activeId as string)?.textContent).toBe(
      "Charlie",
    );

    fireEvent.keyDown(trigger, { key: "Home" });
    activeId = trigger.getAttribute("aria-activedescendant");
    expect(document.getElementById(activeId as string)?.textContent).toBe(
      "Alpha",
    );
  });

  it("opens unhighlighted when the value matches no option", () => {
    const { trigger } = renderSelect({ value: "", placeholder: "None" });

    fireEvent.click(trigger);
    expect(screen.getByRole("listbox")).toBeTruthy();

    // Nothing selected, nothing pointed at: no option wears the focus tint.
    expect(trigger.getAttribute("aria-activedescendant")).toBeNull();
    expect(
      screen.getByRole("option", { name: "Alpha" }).className.split(" "),
    ).not.toContain("bg-gray-100");

    // The first arrow key still lands on the first option.
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const activeId = trigger.getAttribute("aria-activedescendant");
    expect(document.getElementById(activeId as string)?.textContent).toBe(
      "Alpha",
    );
  });

  it("closes on Escape and returns focus to the trigger", () => {
    const { trigger } = renderSelect();

    fireEvent.click(trigger);
    expect(screen.getByRole("listbox")).toBeTruthy();

    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("returns focus to the trigger after a mouse selection", () => {
    const { onChange, trigger } = renderSelect();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: "Charlie" }));

    expect(onChange).toHaveBeenCalledWith("c");
    expect(document.activeElement).toBe(trigger);
  });

  it("ignores Enter on a disabled option and keeps the menu open", () => {
    const { onChange, trigger } = renderSelect({
      options: [options[0], { ...options[1], disabled: true }, options[2]],
    });

    fireEvent.keyDown(trigger, { key: "ArrowDown" }); // open at Alpha
    fireEvent.keyDown(trigger, { key: "ArrowDown" }); // Bravo (disabled)
    fireEvent.keyDown(trigger, { key: "Enter" });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeTruthy();
  });
});
