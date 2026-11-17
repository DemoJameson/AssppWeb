import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("selects an option with a real pointer click", async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = renderSelect();

    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: "Charlie" }));

    expect(onChange).toHaveBeenCalledWith("c");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("keeps the full label available when the text is truncated", () => {
    const { trigger } = renderSelect({
      options: [
        { value: "a", label: "A very long account label that will be clipped" },
      ],
    });

    expect(trigger).toHaveAttribute(
      "title",
      "A very long account label that will be clipped",
    );

    fireEvent.click(trigger);
    expect(
      screen.getByRole("option", {
        name: "A very long account label that will be clipped",
      }),
    ).toHaveAttribute(
      "title",
      "A very long account label that will be clipped",
    );
  });

  it("skips disabled options while arrowing", () => {
    const { onChange, trigger } = renderSelect({
      options: [options[0], { ...options[1], disabled: true }, options[2]],
    });

    fireEvent.keyDown(trigger, { key: "ArrowDown" }); // open at Alpha
    fireEvent.keyDown(trigger, { key: "ArrowDown" }); // Bravo is disabled, so Charlie
    const activeId = trigger.getAttribute("aria-activedescendant");
    expect(document.getElementById(activeId as string)?.textContent).toBe(
      "Charlie",
    );

    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("c");
  });

  it("jumps to an option by typing", () => {
    const { onChange, trigger } = renderSelect();

    fireEvent.keyDown(trigger, { key: "c" });
    expect(screen.getByRole("listbox")).toBeTruthy();
    const activeId = trigger.getAttribute("aria-activedescendant");
    expect(document.getElementById(activeId as string)?.textContent).toBe(
      "Charlie",
    );

    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("c");
  });

  it("leaves no active option when every option is disabled", () => {
    const { trigger } = renderSelect({
      options: options.map((option) => ({ ...option, disabled: true })),
    });

    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger.getAttribute("aria-activedescendant")).toBeNull();
  });

  it("keeps option actions outside the listbox but in the tab order", async () => {
    const user = userEvent.setup();
    const action = vi.fn();
    const { trigger } = renderSelect({
      options: [
        options[0],
        {
          ...options[1],
          disabled: true,
          trailing: <span>Downloaded</span>,
          action: { label: "Open", onActivate: action },
        },
      ],
    });

    await user.click(trigger);
    await user.tab();

    expect(
      screen.getByRole("option", { name: /Bravo.*Downloaded/ }),
    ).toBeTruthy();
    const actionButton = screen.getByRole("button", { name: "Open: Bravo" });
    const listbox = screen.getByRole("listbox");
    expect(actionButton).toHaveFocus();
    expect(listbox).not.toContainElement(actionButton);

    await user.click(actionButton);
    expect(action).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
